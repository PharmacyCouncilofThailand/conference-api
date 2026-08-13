import { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  sponsorApplications,
  sponsorApplicationItems,
  sponsorEventProfiles,
  sponsorPackageComponents,
  sponsorPackages,
} from "../../database/schema.js";
import {
  SponsorApplicationInput,
  sponsorApplicationSchema,
} from "../../schemas/sponsors.schema.js";
import {
  generateSponsorApplicationNo,
  getEventByIdOrCode,
  getSponsorPackageReservedCounts,
  getSponsorPage,
} from "../../services/sponsorService.js";
import { uploadSponsorFile } from "../../services/googleDrive.js";

const PAYMENT_SLIP_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const LOGO_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const MAX_SPONSOR_FILE_SIZE = 10 * 1024 * 1024;

type BufferedUpload = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
};

function isMultipartRequest(request: FastifyRequest) {
  return String(request.headers["content-type"] || "").includes("multipart/form-data");
}

function normalizeApplicationPayload(payload: Record<string, unknown>) {
  const normalized = { ...payload };
  if (typeof normalized.items === "string") {
    try {
      normalized.items = JSON.parse(normalized.items);
    } catch {
      normalized.items = [];
    }
  }
  return normalized;
}

async function readFilePart(part: any): Promise<BufferedUpload> {
  const chunks: Buffer[] = [];
  for await (const chunk of part.file) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return {
    buffer,
    filename: part.filename,
    mimeType: part.mimetype,
    size: buffer.length,
  };
}

async function parseSponsorApplicationRequest(request: FastifyRequest) {
  if (!isMultipartRequest(request)) {
    const result = sponsorApplicationSchema.safeParse(request.body);
    if (!result.success) {
      return {
        ok: false as const,
        status: 400,
        error: "Invalid input",
        details: result.error.flatten(),
      };
    }
    return { ok: true as const, data: result.data };
  }

  const payload: Record<string, unknown> = {};
  const files: { paymentSlip?: BufferedUpload; logo?: BufferedUpload } = {};

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname === "paymentSlip") {
        files.paymentSlip = await readFilePart(part);
      } else if (part.fieldname === "logo") {
        files.logo = await readFilePart(part);
      } else {
        for await (const _chunk of part.file) {
          // Drain unexpected file fields.
        }
      }
      continue;
    }

    const value = String(part.value ?? "");
    if (part.fieldname === "application") {
      try {
        Object.assign(payload, JSON.parse(value));
      } catch {
        return {
          ok: false as const,
          status: 400,
          error: "Invalid application JSON",
        };
      }
    } else {
      payload[part.fieldname] = value;
    }
  }

  const result = sponsorApplicationSchema.safeParse(normalizeApplicationPayload(payload));
  if (!result.success) {
    return {
      ok: false as const,
      status: 400,
      error: "Invalid input",
      details: result.error.flatten(),
    };
  }

  return { ok: true as const, data: result.data, files };
}

function validateSponsorUpload(file: BufferedUpload, allowedTypes: Set<string>, label: string) {
  if (!allowedTypes.has(file.mimeType)) {
    return `${label} file type is not allowed`;
  }
  if (file.size > MAX_SPONSOR_FILE_SIZE) {
    return `${label} file is too large. Maximum size is 10MB.`;
  }
  return null;
}

function isRegistrationWindowOpen(profile: typeof sponsorEventProfiles.$inferSelect) {
  const now = new Date();
  if (profile.registrationOpenAt && now < profile.registrationOpenAt) return false;
  if (profile.registrationCloseAt && now > profile.registrationCloseAt) return false;
  return true;
}

function combineApplicationItems(items: SponsorApplicationInput["items"]) {
  const itemMap = new Map<number, number>();
  for (const item of items) {
    itemMap.set(item.packageId, (itemMap.get(item.packageId) || 0) + item.quantity);
  }
  return Array.from(itemMap.entries()).map(([packageId, quantity]) => ({ packageId, quantity }));
}

export default async function publicSponsorRoutes(fastify: FastifyInstance) {
  fastify.get("/:eventId/sponsor", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };

    try {
      const sponsorPage = await getSponsorPage(eventId, {
        requirePublishedEvent: true,
        requirePublishedProfile: true,
      });

      if (!sponsorPage) {
        return reply.status(404).send({ error: "Sponsor page not found" });
      }

      return reply.send({ sponsor: sponsorPage });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch sponsor page" });
    }
  });

  fastify.post("/:eventId/sponsor/applications", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };

    try {
      const event = await getEventByIdOrCode(eventId);
      if (!event || event.status !== "published" || event.archivedAt) {
        return reply.status(404).send({ error: "Event not found" });
      }

      const [profile] = await db
        .select()
        .from(sponsorEventProfiles)
        .where(eq(sponsorEventProfiles.eventId, event.id))
        .limit(1);

      if (!profile || !profile.isPublished) {
        return reply.status(404).send({ error: "Sponsor page not found" });
      }

      if (!isRegistrationWindowOpen(profile)) {
        return reply.status(409).send({ error: "Sponsor registration is not open" });
      }

      const parsed = await parseSponsorApplicationRequest(request);
      if (!parsed.ok) {
        return reply.status(parsed.status).send({
          error: parsed.error,
          details: "details" in parsed ? parsed.details : undefined,
        });
      }

      const applicationNo = generateSponsorApplicationNo(event.eventCode);
      const data = { ...parsed.data };

      if ("files" in parsed && parsed.files?.paymentSlip) {
        const fileError = validateSponsorUpload(parsed.files.paymentSlip, PAYMENT_SLIP_MIME_TYPES, "Payment slip");
        if (fileError) return reply.status(400).send({ error: fileError });

        data.paymentSlipUrl = await uploadSponsorFile(
          parsed.files.paymentSlip.buffer,
          parsed.files.paymentSlip.filename,
          parsed.files.paymentSlip.mimeType,
          event.eventCode,
          "payment_slip",
          { applicationNo },
        );
        data.paymentSlipFileName = parsed.files.paymentSlip.filename;
      }

      if ("files" in parsed && parsed.files?.logo) {
        const fileError = validateSponsorUpload(parsed.files.logo, LOGO_MIME_TYPES, "Logo");
        if (fileError) return reply.status(400).send({ error: fileError });

        data.logoUrl = await uploadSponsorFile(
          parsed.files.logo.buffer,
          parsed.files.logo.filename,
          parsed.files.logo.mimeType,
          event.eventCode,
          "logo",
          { applicationNo },
        );
        data.logoFileName = parsed.files.logo.filename;
      }

      if (!data.paymentSlipUrl) {
        return reply.status(400).send({ error: "paymentSlip is required" });
      }
      if (!data.logoUrl) {
        return reply.status(400).send({ error: "logo is required" });
      }

      const created = await db.transaction(async (tx) => {
        const requestedItems = combineApplicationItems(data.items);
        const requestedPackageIds = requestedItems.map((item) => item.packageId);

        const selectedPackageRows = await tx
          .select()
          .from(sponsorPackages)
          .where(
            and(
              eq(sponsorPackages.eventId, event.id),
              eq(sponsorPackages.isActive, true),
              inArray(sponsorPackages.id, requestedPackageIds),
            ),
          );

        if (selectedPackageRows.length !== requestedPackageIds.length) {
          throw new Error("SPONSOR_PACKAGE_NOT_FOUND");
        }

        const bundleComponentRows = requestedPackageIds.length > 0
          ? await tx
            .select()
            .from(sponsorPackageComponents)
            .where(inArray(sponsorPackageComponents.bundlePackageId, requestedPackageIds))
          : [];

        const componentPackageIds = bundleComponentRows.map((component) => component.componentPackageId);
        const impactedPackageIds = Array.from(new Set([...requestedPackageIds, ...componentPackageIds]));

        const impactedPackageRows = await tx
          .select()
          .from(sponsorPackages)
          .where(
            and(
              eq(sponsorPackages.eventId, event.id),
              eq(sponsorPackages.isActive, true),
              inArray(sponsorPackages.id, impactedPackageIds),
            ),
          );

        if (impactedPackageRows.length !== impactedPackageIds.length) {
          throw new Error("SPONSOR_PACKAGE_NOT_FOUND");
        }

        const currencySet = new Set(selectedPackageRows.map((pkg) => pkg.currency));
        if (currencySet.size > 1) {
          throw new Error("SPONSOR_PACKAGE_CURRENCY_MISMATCH");
        }

        const reservedByPackage = await getSponsorPackageReservedCounts(impactedPackageIds, tx);

        const selectedPackageMap = new Map(selectedPackageRows.map((pkg) => [pkg.id, pkg]));
        const impactedPackageMap = new Map(impactedPackageRows.map((pkg) => [pkg.id, pkg]));
        const componentsByBundle = bundleComponentRows.reduce<Record<number, number[]>>((acc, component) => {
          if (!acc[component.bundlePackageId]) acc[component.bundlePackageId] = [];
          acc[component.bundlePackageId].push(component.componentPackageId);
          return acc;
        }, {});
        const requestedQuantitiesByPackage = new Map<number, number>();
        let totalAmount = 0;

        for (const requestedItem of requestedItems) {
          const pkg = selectedPackageMap.get(requestedItem.packageId);
          if (!pkg) throw new Error("SPONSOR_PACKAGE_NOT_FOUND");

          requestedQuantitiesByPackage.set(
            pkg.id,
            (requestedQuantitiesByPackage.get(pkg.id) || 0) + requestedItem.quantity,
          );
          for (const componentPackageId of componentsByBundle[pkg.id] || []) {
            requestedQuantitiesByPackage.set(
              componentPackageId,
              (requestedQuantitiesByPackage.get(componentPackageId) || 0) + requestedItem.quantity,
            );
          }

          totalAmount += Number(pkg.price) * requestedItem.quantity;
        }

        for (const [packageId, requestedQuantity] of requestedQuantitiesByPackage.entries()) {
          const pkg = impactedPackageMap.get(packageId);
          if (!pkg) throw new Error("SPONSOR_PACKAGE_NOT_FOUND");

          const isBundleWithComponents = pkg.packageType === "bundle" && (componentsByBundle[pkg.id] || []).length > 0;
          if (isBundleWithComponents) {
            continue;
          }

          const reservedCount = reservedByPackage[pkg.id] || 0;
          if (pkg.quota > 0 && reservedCount + requestedQuantity > pkg.quota) {
            throw new Error("SPONSOR_PACKAGE_SOLD_OUT");
          }
        }

        const [application] = await tx
          .insert(sponsorApplications)
          .values({
            applicationNo,
            eventId: event.id,
            companyName: data.companyName,
            contactFullName: data.contactFullName,
            businessEmail: data.businessEmail,
            phone: data.phone,
            billingName: data.billingName,
            taxId: data.taxId,
            billingAddress: data.billingAddress,
            paymentSlipUrl: data.paymentSlipUrl,
            paymentSlipFileName: data.paymentSlipFileName,
            logoUrl: data.logoUrl,
            logoFileName: data.logoFileName,
            totalAmount: String(totalAmount),
            currency: selectedPackageRows[0]?.currency || "THB",
          })
          .returning();

        const itemRows = await tx
          .insert(sponsorApplicationItems)
          .values(
            requestedItems.map((item, index) => {
              const pkg = selectedPackageMap.get(item.packageId)!;
              return {
                applicationId: application.id,
                packageId: pkg.id,
                packageType: pkg.packageType,
                packageNameSnapshot: pkg.name,
                priceSnapshot: pkg.price,
                quantity: item.quantity,
                sortOrder: index,
              };
            }),
          )
          .returning();

        return { application, items: itemRows };
      });

      return reply.status(201).send({
        application: {
          ...created.application,
          items: created.items,
        },
      });
    } catch (error: any) {
      const knownErrors: Record<string, { status: number; message: string }> = {
        SPONSOR_PACKAGE_NOT_FOUND: { status: 400, message: "Sponsor package not found" },
        SPONSOR_PACKAGE_CURRENCY_MISMATCH: { status: 400, message: "Selected packages must use the same currency" },
        SPONSOR_PACKAGE_SOLD_OUT: { status: 409, message: "Sponsor package quota is not available" },
      };

      const known = knownErrors[error?.message];
      if (known) {
        return reply.status(known.status).send({ error: known.message, code: error.message });
      }

      fastify.log.error(error);
      if (String(error?.message || "").includes("GOOGLE_DRIVE_SPONSOR_ROOT_FOLDER")) {
        return reply.status(503).send({ error: "Google Drive sponsor folder is not configured" });
      }
      return reply.status(500).send({ error: "Failed to submit sponsor application" });
    }
  });
}
