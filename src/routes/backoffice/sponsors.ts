import { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  backofficeUsers,
  events,
  sponsorApplications,
  sponsorApplicationItems,
  sponsorBenefits,
  sponsorEventProfiles,
  sponsorMediaAssets,
  sponsorPackageComponents,
  sponsorPackageFeatures,
  sponsorPackages,
  sponsorStats,
  sponsorTimelineItems,
  staffEventAssignments,
} from "../../database/schema.js";
import {
  sponsorApplicationListQuerySchema,
  sponsorApplicationStatusUpdateSchema,
  sponsorBenefitSchema,
  sponsorMediaAssetSchema,
  sponsorMediaQuerySchema,
  sponsorPackageComponentsSchema,
  sponsorPackageFeaturesSchema,
  sponsorPackageSchema,
  sponsorPaymentStatusUpdateSchema,
  sponsorProfileSchema,
  sponsorStatSchema,
  sponsorTimelineItemSchema,
  updateSponsorApplicationSchema,
  updateSponsorBenefitSchema,
  updateSponsorMediaAssetSchema,
  updateSponsorPackageSchema,
  updateSponsorStatSchema,
  updateSponsorTimelineItemSchema,
} from "../../schemas/sponsors.schema.js";
import { getSponsorPage } from "../../services/sponsorService.js";
import { SponsorUploadKind, uploadSponsorFile } from "../../services/googleDrive.js";
import type { JWTPayload } from "../../types/index.js";

const SPONSOR_MEDIA_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const SPONSOR_MEDIA_DOCUMENT_TYPES = new Set([
  ...SPONSOR_MEDIA_IMAGE_TYPES,
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MAX_SPONSOR_MEDIA_SIZE = 50 * 1024 * 1024;

type AccessResult =
  | { ok: true; event: { id: number; eventCode: string; eventName: string } }
  | { ok: false; status: number; error: string };

type BufferedUpload = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
};

function getBackofficeUser(request: FastifyRequest) {
  return (request as { user?: JWTPayload }).user;
}

function stripUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as Partial<T>;
}

async function validateBundleComponents(
  eventId: number,
  bundlePackageId: number | null,
  components: { componentPackageId: number; componentRole?: string }[],
  client: any = db,
) {
  if (components.length < 2) {
    return { ok: false as const, error: "Bundle requires at least 2 Booth/Symposium packages" };
  }

  const componentIds = Array.from(new Set(components.map((component) => component.componentPackageId)));
  if (bundlePackageId && componentIds.includes(bundlePackageId)) {
    return { ok: false as const, error: "Bundle cannot include itself" };
  }
  if (componentIds.length !== components.length) {
    return { ok: false as const, error: "Bundle components must be unique" };
  }

  const componentRows: Array<{ id: number; packageType: "booth" | "symposium" | "bundle" }> = await client
    .select({
      id: sponsorPackages.id,
      packageType: sponsorPackages.packageType,
    })
    .from(sponsorPackages)
    .where(and(eq(sponsorPackages.eventId, eventId), inArray(sponsorPackages.id, componentIds)));

  if (componentRows.length !== componentIds.length) {
    return { ok: false as const, error: "All component packages must belong to the same event" };
  }
  if (componentRows.some((component) => component.packageType === "bundle")) {
    return { ok: false as const, error: "Bundle cannot include another bundle" };
  }
  if (!componentRows.some((component) => component.packageType === "booth")) {
    return { ok: false as const, error: "Bundle requires at least 1 Booth package" };
  }
  if (!componentRows.some((component) => component.packageType === "symposium")) {
    return { ok: false as const, error: "Bundle requires at least 1 Symposium package" };
  }

  return { ok: true as const };
}

function toDate(value: string | undefined) {
  return value ? new Date(value) : undefined;
}

async function getAssignedEventIds(staffId: number) {
  const assignments = await db
    .select({ eventId: staffEventAssignments.eventId })
    .from(staffEventAssignments)
    .where(eq(staffEventAssignments.staffId, staffId));

  return assignments.map((assignment) => assignment.eventId);
}

async function ensureEventAccess(request: FastifyRequest, eventId: number): Promise<AccessResult> {
  const user = getBackofficeUser(request);

  const [event] = await db
    .select({
      id: events.id,
      eventCode: events.eventCode,
      eventName: events.eventName,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    return { ok: false, status: 404, error: "Event not found" };
  }

  if (!user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  if (user.role === "admin") {
    return { ok: true, event };
  }

  const [assignment] = await db
    .select({ id: staffEventAssignments.id })
    .from(staffEventAssignments)
    .where(
      and(
        eq(staffEventAssignments.staffId, user.id),
        eq(staffEventAssignments.eventId, eventId),
      ),
    )
    .limit(1);

  if (!assignment) {
    return { ok: false, status: 403, error: "You do not have access to this event" };
  }

  return { ok: true, event };
}

async function getApplicationDetail(applicationId: number) {
  const [application] = await db
    .select({
      id: sponsorApplications.id,
      applicationNo: sponsorApplications.applicationNo,
      eventId: sponsorApplications.eventId,
      companyName: sponsorApplications.companyName,
      contactFullName: sponsorApplications.contactFullName,
      businessEmail: sponsorApplications.businessEmail,
      phone: sponsorApplications.phone,
      billingName: sponsorApplications.billingName,
      taxId: sponsorApplications.taxId,
      billingAddress: sponsorApplications.billingAddress,
      paymentSlipUrl: sponsorApplications.paymentSlipUrl,
      paymentSlipFileName: sponsorApplications.paymentSlipFileName,
      logoUrl: sponsorApplications.logoUrl,
      logoFileName: sponsorApplications.logoFileName,
      totalAmount: sponsorApplications.totalAmount,
      currency: sponsorApplications.currency,
      applicationStatus: sponsorApplications.applicationStatus,
      paymentStatus: sponsorApplications.paymentStatus,
      internalNote: sponsorApplications.internalNote,
      rejectionReason: sponsorApplications.rejectionReason,
      reviewedBy: sponsorApplications.reviewedBy,
      reviewedAt: sponsorApplications.reviewedAt,
      confirmedAt: sponsorApplications.confirmedAt,
      createdAt: sponsorApplications.createdAt,
      updatedAt: sponsorApplications.updatedAt,
      eventName: events.eventName,
      eventCode: events.eventCode,
      reviewerFirstName: backofficeUsers.firstName,
      reviewerLastName: backofficeUsers.lastName,
    })
    .from(sponsorApplications)
    .innerJoin(events, eq(sponsorApplications.eventId, events.id))
    .leftJoin(backofficeUsers, eq(sponsorApplications.reviewedBy, backofficeUsers.id))
    .where(eq(sponsorApplications.id, applicationId))
    .limit(1);

  if (!application) return null;

  const items = await db
    .select()
    .from(sponsorApplicationItems)
    .where(eq(sponsorApplicationItems.applicationId, applicationId))
    .orderBy(asc(sponsorApplicationItems.sortOrder), asc(sponsorApplicationItems.id));

  return { ...application, items };
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

function validateMediaUpload(file: BufferedUpload, mediaType: string) {
  const allowedTypes =
    mediaType === "past_sponsor_logo" || mediaType === "previous_year_impression"
      ? SPONSOR_MEDIA_IMAGE_TYPES
      : SPONSOR_MEDIA_DOCUMENT_TYPES;

  if (!allowedTypes.has(file.mimeType)) {
    return "Invalid file type for sponsor media";
  }
  if (file.size > MAX_SPONSOR_MEDIA_SIZE) {
    return "File too large. Maximum size is 50MB.";
  }
  return null;
}

function validateOrganizerLogoUpload(file: BufferedUpload) {
  if (!SPONSOR_MEDIA_IMAGE_TYPES.has(file.mimeType)) {
    return "Invalid organizer logo file type";
  }
  if (file.size > MAX_SPONSOR_MEDIA_SIZE) {
    return "File too large. Maximum size is 50MB.";
  }
  return null;
}

export default async function backofficeSponsorRoutes(fastify: FastifyInstance) {
  // Sponsor page aggregate for a backoffice event editor.
  fastify.get("/events/:eventId/sponsor", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    try {
      const sponsorPage = await getSponsorPage(parsedEventId, { includeInactive: true });
      return reply.send({ sponsor: sponsorPage });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch sponsor page" });
    }
  });

  fastify.patch("/events/:eventId/sponsor", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const result = sponsorProfileSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const values = stripUndefined({
      aboutTitle: result.data.aboutTitle,
      aboutDescription: result.data.aboutDescription,
      organizerLogoUrl: result.data.organizerLogoUrl,
      brochureUrl: result.data.brochureUrl,
      registrationOpenAt: toDate(result.data.registrationOpenAt),
      registrationCloseAt: toDate(result.data.registrationCloseAt),
      isPublished: result.data.isPublished,
      updatedAt: new Date(),
    });

    try {
      const [existing] = await db
        .select({ id: sponsorEventProfiles.id })
        .from(sponsorEventProfiles)
        .where(eq(sponsorEventProfiles.eventId, parsedEventId))
        .limit(1);

      const [profile] = existing
        ? await db
          .update(sponsorEventProfiles)
          .set(values)
          .where(eq(sponsorEventProfiles.id, existing.id))
          .returning()
        : await db
          .insert(sponsorEventProfiles)
          .values({
            eventId: parsedEventId,
            ...values,
          })
          .returning();

      return reply.send({ profile });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to save sponsor profile" });
    }
  });

  fastify.post("/events/:eventId/sponsor/organizer-logo/upload", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    if (!String(request.headers["content-type"] || "").includes("multipart/form-data")) {
      return reply.status(400).send({ error: "multipart/form-data is required" });
    }

    let file: BufferedUpload | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file" && part.fieldname === "file") {
        file = await readFilePart(part);
      } else if (part.type === "file") {
        for await (const _chunk of part.file) {
          // Drain unexpected file fields.
        }
      }
    }

    if (!file) return reply.status(400).send({ error: "file is required" });

    const fileError = validateOrganizerLogoUpload(file);
    if (fileError) return reply.status(400).send({ error: fileError });

    try {
      const organizerLogoUrl = await uploadSponsorFile(
        file.buffer,
        file.filename,
        file.mimeType,
        access.event.eventCode,
        "organizer_logo",
      );

      const [existing] = await db
        .select({ id: sponsorEventProfiles.id })
        .from(sponsorEventProfiles)
        .where(eq(sponsorEventProfiles.eventId, parsedEventId))
        .limit(1);

      const values = {
        organizerLogoUrl,
        updatedAt: new Date(),
      };

      const [profile] = existing
        ? await db
          .update(sponsorEventProfiles)
          .set(values)
          .where(eq(sponsorEventProfiles.id, existing.id))
          .returning()
        : await db
          .insert(sponsorEventProfiles)
          .values({
            eventId: parsedEventId,
            ...values,
          })
          .returning();

      return reply.status(201).send({ profile, organizerLogoUrl });
    } catch (error: any) {
      fastify.log.error(error);
      const message = String(error?.message || "");
      if (message.includes("GOOGLE_DRIVE_SPONSOR_ROOT_FOLDER")) {
        return reply.status(503).send({ error: "Google Drive sponsor folder is not configured" });
      }
      return reply.status(500).send({ error: "Failed to upload organizer logo" });
    }
  });

  // Stats
  fastify.get("/events/:eventId/sponsor/stats", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const stats = await db
      .select()
      .from(sponsorStats)
      .where(eq(sponsorStats.eventId, parsedEventId))
      .orderBy(asc(sponsorStats.sortOrder), asc(sponsorStats.id));

    return reply.send({ stats });
  });

  fastify.post("/events/:eventId/sponsor/stats", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const result = sponsorStatSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [stat] = await db
      .insert(sponsorStats)
      .values({ eventId: parsedEventId, ...result.data })
      .returning();

    return reply.status(201).send({ stat });
  });

  fastify.patch("/sponsor-stats/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateSponsorStatSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const [existing] = await db
      .select()
      .from(sponsorStats)
      .where(eq(sponsorStats.id, parseInt(id, 10)))
      .limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor stat not found" });

    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [stat] = await db
      .update(sponsorStats)
      .set({ ...result.data, updatedAt: new Date() })
      .where(eq(sponsorStats.id, existing.id))
      .returning();

    return reply.send({ stat });
  });

  fastify.delete("/sponsor-stats/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await db
      .select()
      .from(sponsorStats)
      .where(eq(sponsorStats.id, parseInt(id, 10)))
      .limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor stat not found" });

    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    await db.delete(sponsorStats).where(eq(sponsorStats.id, existing.id));
    return reply.send({ success: true });
  });

  // Packages
  fastify.get("/events/:eventId/sponsor/packages", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const { type } = request.query as { type?: string };
    const parsedEventId = parseInt(eventId, 10);
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const sponsorPage = await getSponsorPage(parsedEventId, { includeInactive: true });
    const allPackages = sponsorPage
      ? [
        ...sponsorPage.packages.booth,
        ...sponsorPage.packages.symposium,
        ...sponsorPage.packages.bundle,
      ]
      : [];
    const packages = type ? allPackages.filter((pkg) => pkg.packageType === type) : allPackages;

    return reply.send({ packages });
  });

  fastify.post("/events/:eventId/sponsor/packages", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const result = sponsorPackageSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    try {
      const { features, components, ...packageData } = result.data;
      if (packageData.packageType === "bundle") {
        const componentValidation = await validateBundleComponents(parsedEventId, null, components);
        if (!componentValidation.ok) {
          return reply.status(400).send({ error: componentValidation.error });
        }
      }
      const created = await db.transaction(async (tx) => {
        const [pkg] = await tx
          .insert(sponsorPackages)
          .values({
            eventId: parsedEventId,
            ...packageData,
            price: String(packageData.price),
          })
          .returning();

        const featureRows = features.length > 0
          ? await tx
            .insert(sponsorPackageFeatures)
            .values(features.map((feature) => ({ packageId: pkg.id, ...feature })))
            .returning()
          : [];

        const componentRows = packageData.packageType === "bundle" && components.length > 0
          ? await tx
            .insert(sponsorPackageComponents)
            .values(components.map((component) => ({ bundlePackageId: pkg.id, ...component })))
            .returning()
          : [];

        return { ...pkg, features: featureRows, components: componentRows };
      });

      return reply.status(201).send({ package: created });
    } catch (error: any) {
      if (String(error?.message || "").includes("idx_sponsor_packages_event_code_unique")) {
        return reply.status(409).send({ error: "Sponsor package code already exists for this event" });
      }
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to create sponsor package" });
    }
  });

  fastify.patch("/sponsor-packages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const packageId = parseInt(id, 10);
    const result = updateSponsorPackageSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const [existing] = await db
      .select()
      .from(sponsorPackages)
      .where(eq(sponsorPackages.id, packageId))
      .limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor package not found" });

    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    try {
      const { features, components, ...packageData } = result.data;
      const nextPackageType = packageData.packageType || existing.packageType;
      if (nextPackageType === "bundle" && components !== undefined) {
        const componentValidation = await validateBundleComponents(existing.eventId, packageId, components);
        if (!componentValidation.ok) {
          return reply.status(400).send({ error: componentValidation.error });
        }
      }

      const updated = await db.transaction(async (tx) => {
        const values = stripUndefined({
          ...packageData,
          quota: nextPackageType === "bundle" ? 0 : packageData.quota,
          price: packageData.price !== undefined ? String(packageData.price) : undefined,
          updatedAt: new Date(),
        });

        const [pkg] = await tx
          .update(sponsorPackages)
          .set(values)
          .where(eq(sponsorPackages.id, packageId))
          .returning();

        if (features !== undefined) {
          await tx
            .delete(sponsorPackageFeatures)
            .where(eq(sponsorPackageFeatures.packageId, packageId));

          if (features.length > 0) {
            await tx.insert(sponsorPackageFeatures).values(
              features.map((feature) => ({ packageId, ...feature })),
            );
          }
        }

        if (nextPackageType !== "bundle") {
          await tx
            .delete(sponsorPackageComponents)
            .where(eq(sponsorPackageComponents.bundlePackageId, packageId));
        } else if (components !== undefined) {
          await tx
            .delete(sponsorPackageComponents)
            .where(eq(sponsorPackageComponents.bundlePackageId, packageId));

          if (components.length > 0) {
            await tx.insert(sponsorPackageComponents).values(
              components.map((component) => ({ bundlePackageId: packageId, ...component })),
            );
          }
        }

        const featureRows = await tx
          .select()
          .from(sponsorPackageFeatures)
          .where(eq(sponsorPackageFeatures.packageId, packageId))
          .orderBy(asc(sponsorPackageFeatures.sortOrder), asc(sponsorPackageFeatures.id));

        const componentRows = nextPackageType === "bundle"
          ? await tx
            .select()
            .from(sponsorPackageComponents)
            .where(eq(sponsorPackageComponents.bundlePackageId, packageId))
            .orderBy(asc(sponsorPackageComponents.id))
          : [];

        return { ...pkg, features: featureRows, components: componentRows };
      });

      return reply.send({ package: updated });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to update sponsor package" });
    }
  });

  fastify.delete("/sponsor-packages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const packageId = parseInt(id, 10);
    const [existing] = await db
      .select()
      .from(sponsorPackages)
      .where(eq(sponsorPackages.id, packageId))
      .limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor package not found" });

    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    await db.delete(sponsorPackages).where(eq(sponsorPackages.id, packageId));
    return reply.send({ success: true });
  });

  fastify.put("/sponsor-packages/:id/features", async (request, reply) => {
    const { id } = request.params as { id: string };
    const packageId = parseInt(id, 10);
    const result = sponsorPackageFeaturesSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const [pkg] = await db.select().from(sponsorPackages).where(eq(sponsorPackages.id, packageId)).limit(1);
    if (!pkg) return reply.status(404).send({ error: "Sponsor package not found" });
    const access = await ensureEventAccess(request, pkg.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const features = await db.transaction(async (tx) => {
      await tx.delete(sponsorPackageFeatures).where(eq(sponsorPackageFeatures.packageId, packageId));
      if (result.data.features.length === 0) return [];
      return tx
        .insert(sponsorPackageFeatures)
        .values(result.data.features.map((feature) => ({ packageId, ...feature })))
        .returning();
    });

    return reply.send({ features });
  });

  fastify.put("/sponsor-packages/:id/components", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bundlePackageId = parseInt(id, 10);
    const result = sponsorPackageComponentsSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const [bundle] = await db.select().from(sponsorPackages).where(eq(sponsorPackages.id, bundlePackageId)).limit(1);
    if (!bundle) return reply.status(404).send({ error: "Sponsor package not found" });
    if (bundle.packageType !== "bundle") {
      return reply.status(400).send({ error: "Components can only be assigned to bundle packages" });
    }

    const access = await ensureEventAccess(request, bundle.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const componentValidation = await validateBundleComponents(
      bundle.eventId,
      bundlePackageId,
      result.data.components,
    );
    if (!componentValidation.ok) {
      return reply.status(400).send({ error: componentValidation.error });
    }

    const components = await db.transaction(async (tx) => {
      await tx
        .delete(sponsorPackageComponents)
        .where(eq(sponsorPackageComponents.bundlePackageId, bundlePackageId));
      if (result.data.components.length === 0) return [];
      return tx
        .insert(sponsorPackageComponents)
        .values(result.data.components.map((component) => ({ bundlePackageId, ...component })))
        .returning();
    });

    return reply.send({ components });
  });

  // Benefits
  fastify.get("/events/:eventId/sponsor/benefits", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const benefits = await db
      .select()
      .from(sponsorBenefits)
      .where(eq(sponsorBenefits.eventId, parsedEventId))
      .orderBy(asc(sponsorBenefits.sortOrder), asc(sponsorBenefits.id));
    return reply.send({ benefits });
  });

  fastify.post("/events/:eventId/sponsor/benefits", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const result = sponsorBenefitSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [benefit] = await db
      .insert(sponsorBenefits)
      .values({ eventId: parsedEventId, ...result.data })
      .returning();
    return reply.status(201).send({ benefit });
  });

  fastify.patch("/sponsor-benefits/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateSponsorBenefitSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }
    const [existing] = await db.select().from(sponsorBenefits).where(eq(sponsorBenefits.id, parseInt(id, 10))).limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor benefit not found" });
    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [benefit] = await db
      .update(sponsorBenefits)
      .set({ ...result.data, updatedAt: new Date() })
      .where(eq(sponsorBenefits.id, existing.id))
      .returning();
    return reply.send({ benefit });
  });

  fastify.delete("/sponsor-benefits/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await db.select().from(sponsorBenefits).where(eq(sponsorBenefits.id, parseInt(id, 10))).limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor benefit not found" });
    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    await db.delete(sponsorBenefits).where(eq(sponsorBenefits.id, existing.id));
    return reply.send({ success: true });
  });

  // Timeline
  fastify.get("/events/:eventId/sponsor/timeline", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const timeline = await db
      .select()
      .from(sponsorTimelineItems)
      .where(eq(sponsorTimelineItems.eventId, parsedEventId))
      .orderBy(asc(sponsorTimelineItems.sortOrder), asc(sponsorTimelineItems.id));
    return reply.send({ timeline });
  });

  fastify.post("/events/:eventId/sponsor/timeline", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const result = sponsorTimelineItemSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [timelineItem] = await db
      .insert(sponsorTimelineItems)
      .values({
        eventId: parsedEventId,
        ...result.data,
        startDate: toDate(result.data.startDate),
        endDate: toDate(result.data.endDate),
      })
      .returning();
    return reply.status(201).send({ timelineItem });
  });

  fastify.patch("/sponsor-timeline/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateSponsorTimelineItemSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }
    const [existing] = await db
      .select()
      .from(sponsorTimelineItems)
      .where(eq(sponsorTimelineItems.id, parseInt(id, 10)))
      .limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor timeline item not found" });
    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const values = stripUndefined({
      ...result.data,
      startDate: toDate(result.data.startDate),
      endDate: toDate(result.data.endDate),
      updatedAt: new Date(),
    });
    const [timelineItem] = await db
      .update(sponsorTimelineItems)
      .set(values)
      .where(eq(sponsorTimelineItems.id, existing.id))
      .returning();
    return reply.send({ timelineItem });
  });

  fastify.delete("/sponsor-timeline/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await db
      .select()
      .from(sponsorTimelineItems)
      .where(eq(sponsorTimelineItems.id, parseInt(id, 10)))
      .limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor timeline item not found" });
    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    await db.delete(sponsorTimelineItems).where(eq(sponsorTimelineItems.id, existing.id));
    return reply.send({ success: true });
  });

  // Media
  fastify.get("/events/:eventId/sponsor/media", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const queryResult = sponsorMediaQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const conditions = [eq(sponsorMediaAssets.eventId, parsedEventId)];
    if (queryResult.data.mediaType) conditions.push(eq(sponsorMediaAssets.mediaType, queryResult.data.mediaType));
    if (queryResult.data.activeOnly) conditions.push(eq(sponsorMediaAssets.isActive, true));

    const media = await db
      .select()
      .from(sponsorMediaAssets)
      .where(and(...conditions))
      .orderBy(asc(sponsorMediaAssets.mediaType), asc(sponsorMediaAssets.sortOrder), asc(sponsorMediaAssets.id));

    return reply.send({ media });
  });

  fastify.post("/events/:eventId/sponsor/media", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const result = sponsorMediaAssetSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [media] = await db
      .insert(sponsorMediaAssets)
      .values({ eventId: parsedEventId, ...result.data })
      .returning();
    return reply.status(201).send({ media });
  });

  fastify.post("/events/:eventId/sponsor/media/upload", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const parsedEventId = parseInt(eventId, 10);
    const access = await ensureEventAccess(request, parsedEventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    if (!String(request.headers["content-type"] || "").includes("multipart/form-data")) {
      return reply.status(400).send({ error: "multipart/form-data is required" });
    }

    let file: BufferedUpload | null = null;
    const payload: Record<string, unknown> = {};

    for await (const part of request.parts()) {
      if (part.type === "file" && part.fieldname === "file") {
        file = await readFilePart(part);
      } else if (part.type === "file") {
        for await (const _chunk of part.file) {
          // Drain unexpected file fields.
        }
      } else {
        payload[part.fieldname] = String(part.value ?? "");
      }
    }

    if (!file) return reply.status(400).send({ error: "file is required" });

    const mediaType = String(payload.mediaType || "");
    if (!["past_sponsor_logo", "previous_year_impression", "brochure", "other"].includes(mediaType)) {
      return reply.status(400).send({ error: "Invalid mediaType" });
    }

    const fileError = validateMediaUpload(file, mediaType);
    if (fileError) return reply.status(400).send({ error: fileError });

    try {
      const sortOrder = Number(payload.sortOrder || 0);
      const fileUrl = await uploadSponsorFile(
        file.buffer,
        file.filename,
        file.mimeType,
        access.event.eventCode,
        mediaType as SponsorUploadKind,
        { sortOrder },
      );

      const mediaResult = sponsorMediaAssetSchema.safeParse({
        ...payload,
        mediaType,
        fileUrl,
        fileName: file.filename,
        mimeType: file.mimeType,
        fileSize: file.size,
        sortOrder,
        isActive: payload.isActive === undefined ? true : payload.isActive === "true",
      });
      if (!mediaResult.success) {
        return reply.status(400).send({ error: "Invalid input", details: mediaResult.error.flatten() });
      }

      const [media] = await db
        .insert(sponsorMediaAssets)
        .values({ eventId: parsedEventId, ...mediaResult.data })
        .returning();

      return reply.status(201).send({ media });
    } catch (error: any) {
      fastify.log.error(error);
      const message = String(error?.message || "");
      if (message.includes("GOOGLE_DRIVE_SPONSOR_ROOT_FOLDER")) {
        return reply.status(503).send({ error: "Google Drive sponsor folder is not configured" });
      }
      return reply.status(500).send({ error: "Failed to upload sponsor media" });
    }
  });

  fastify.patch("/sponsor-media/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateSponsorMediaAssetSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }
    const [existing] = await db.select().from(sponsorMediaAssets).where(eq(sponsorMediaAssets.id, parseInt(id, 10))).limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor media not found" });
    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [media] = await db
      .update(sponsorMediaAssets)
      .set({ ...result.data, updatedAt: new Date() })
      .where(eq(sponsorMediaAssets.id, existing.id))
      .returning();
    return reply.send({ media });
  });

  fastify.delete("/sponsor-media/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await db.select().from(sponsorMediaAssets).where(eq(sponsorMediaAssets.id, parseInt(id, 10))).limit(1);
    if (!existing) return reply.status(404).send({ error: "Sponsor media not found" });
    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    await db.delete(sponsorMediaAssets).where(eq(sponsorMediaAssets.id, existing.id));
    return reply.send({ success: true });
  });

  // Applications
  fastify.get("/sponsor-applications", async (request, reply) => {
    const queryResult = sponsorApplicationListQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const user = getBackofficeUser(request);
    const { page, limit, eventId, status, paymentStatus, search } = queryResult.data;
    const offset = (page - 1) * limit;
    const conditions = [];

    if (user && user.role !== "admin") {
      const assignedEventIds = await getAssignedEventIds(user.id);
      if (assignedEventIds.length === 0) {
        return reply.send({
          applications: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
        });
      }
      conditions.push(inArray(sponsorApplications.eventId, assignedEventIds));
    }
    if (eventId) conditions.push(eq(sponsorApplications.eventId, eventId));
    if (status) conditions.push(eq(sponsorApplications.applicationStatus, status));
    if (paymentStatus) conditions.push(eq(sponsorApplications.paymentStatus, paymentStatus));
    if (search) {
      conditions.push(or(
        ilike(sponsorApplications.companyName, `%${search}%`),
        ilike(sponsorApplications.businessEmail, `%${search}%`),
        ilike(sponsorApplications.applicationNo, `%${search}%`),
        ilike(sponsorApplications.contactFullName, `%${search}%`),
      ));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ totalCount }] = await db
      .select({ totalCount: count() })
      .from(sponsorApplications)
      .where(whereClause);

    const applications = await db
      .select({
        id: sponsorApplications.id,
        applicationNo: sponsorApplications.applicationNo,
        eventId: sponsorApplications.eventId,
        eventName: events.eventName,
        eventCode: events.eventCode,
        companyName: sponsorApplications.companyName,
        contactFullName: sponsorApplications.contactFullName,
        businessEmail: sponsorApplications.businessEmail,
        phone: sponsorApplications.phone,
        totalAmount: sponsorApplications.totalAmount,
        currency: sponsorApplications.currency,
        applicationStatus: sponsorApplications.applicationStatus,
        paymentStatus: sponsorApplications.paymentStatus,
        createdAt: sponsorApplications.createdAt,
        reviewedAt: sponsorApplications.reviewedAt,
        reviewerFirstName: backofficeUsers.firstName,
        reviewerLastName: backofficeUsers.lastName,
      })
      .from(sponsorApplications)
      .innerJoin(events, eq(sponsorApplications.eventId, events.id))
      .leftJoin(backofficeUsers, eq(sponsorApplications.reviewedBy, backofficeUsers.id))
      .where(whereClause)
      .orderBy(desc(sponsorApplications.createdAt))
      .limit(limit)
      .offset(offset);

    return reply.send({
      applications,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  });

  fastify.get("/sponsor-applications/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const application = await getApplicationDetail(parseInt(id, 10));
    if (!application) return reply.status(404).send({ error: "Sponsor application not found" });

    const access = await ensureEventAccess(request, application.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    return reply.send({ application });
  });

  fastify.patch("/sponsor-applications/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const applicationId = parseInt(id, 10);
    const result = updateSponsorApplicationSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const existing = await getApplicationDetail(applicationId);
    if (!existing) return reply.status(404).send({ error: "Sponsor application not found" });

    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [application] = await db
      .update(sponsorApplications)
      .set({ ...stripUndefined(result.data), updatedAt: new Date() })
      .where(eq(sponsorApplications.id, applicationId))
      .returning();

    return reply.send({ application });
  });

  fastify.patch("/sponsor-applications/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const applicationId = parseInt(id, 10);
    const result = sponsorApplicationStatusUpdateSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const existing = await getApplicationDetail(applicationId);
    if (!existing) return reply.status(404).send({ error: "Sponsor application not found" });

    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const user = getBackofficeUser(request);
    const updates = stripUndefined({
      applicationStatus: result.data.status,
      rejectionReason: result.data.status === "rejected" ? result.data.rejectionReason : undefined,
      internalNote: result.data.internalNote,
      reviewedBy: user?.id,
      reviewedAt: new Date(),
      confirmedAt: result.data.status === "approved" ? new Date() : undefined,
      updatedAt: new Date(),
    });

    const [application] = await db
      .update(sponsorApplications)
      .set(updates)
      .where(eq(sponsorApplications.id, applicationId))
      .returning();

    return reply.send({ application });
  });

  fastify.patch("/sponsor-applications/:id/payment-status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const applicationId = parseInt(id, 10);
    const result = sponsorPaymentStatusUpdateSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
    }

    const existing = await getApplicationDetail(applicationId);
    if (!existing) return reply.status(404).send({ error: "Sponsor application not found" });

    const access = await ensureEventAccess(request, existing.eventId);
    if (!access.ok) return reply.status(access.status).send({ error: access.error });

    const [application] = await db
      .update(sponsorApplications)
      .set({
        paymentStatus: result.data.paymentStatus,
        internalNote: result.data.internalNote ?? existing.internalNote,
        updatedAt: new Date(),
      })
      .where(eq(sponsorApplications.id, applicationId))
      .returning();

    return reply.send({ application });
  });
}
