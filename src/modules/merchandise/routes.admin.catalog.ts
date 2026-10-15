import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { events } from "../../database/schema.js";
import { MAX_WHEEL_IMAGE_BYTES, WheelImageError } from "../lucky-wheel/images.js";
import { requireAdmin } from "./access.js";
import {
  bannerCreateInput,
  bannerPatchInput,
  categoryCreateInput,
  categoryPatchInput,
  createBanner,
  createCategory,
  deleteBanner,
  deleteCategory,
  getAdminStore,
  listBanners,
  listCategories,
  orderBanners,
  orderCategories,
  orderInput,
  patchBanner,
  patchCategory,
  putStore,
  storeInput,
} from "./admin-store.js";
import { MerchError } from "./errors.js";
import { noStore, ok, sendMerchFailure } from "./http.js";
import { uploadMerchImage } from "./images.js";
import type { MerchRouteOptions } from "./types.js";

const eventIdSchema = z.coerce.number().int().positive();
const idSchema = z.string().uuid();

type Ctx = { admin: { id: number; email: string }; eventId: number; request: FastifyRequest };
type Result = { data: unknown; status?: number };

export async function merchandiseAdminRoutes(
  app: FastifyInstance,
  options: MerchRouteOptions,
): Promise<void> {
  const db = options.database;

  const route =
    (handler: (ctx: Ctx) => Promise<Result>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        noStore(reply);
        const params = request.params as { eventId?: unknown };
        const parsed = eventIdSchema.safeParse(params.eventId);
        if (!parsed.success) {
          throw new MerchError(400, "VALIDATION_ERROR", "ข้อมูลที่ส่งมาไม่ถูกต้อง");
        }
        const eventId = parsed.data;
        const admin = await requireAdmin(db, request, eventId);
        const [event] = await db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1);
        if (!event) throw new MerchError(404, "MERCH_EVENT_NOT_FOUND", "ไม่พบงานที่ระบุ");
        const result = await handler({ admin, eventId, request });
        return ok(reply, result.data, result.status ?? 200);
      } catch (error) {
        return sendMerchFailure(reply, request, error);
      }
    };

  const idParam = (request: FastifyRequest) =>
    idSchema.parse((request.params as { id?: unknown }).id);

  app.get(
    "/merchandise/events/:eventId/store",
    route(async ({ eventId }) => ({ data: await getAdminStore(db, eventId) })),
  );
  app.put(
    "/merchandise/events/:eventId/store",
    route(async ({ admin, eventId, request }) => ({
      data: await putStore(db, admin, eventId, storeInput.parse(request.body)),
    })),
  );

  app.post(
    "/merchandise/events/:eventId/images",
    route(async ({ admin, eventId, request }) => {
      const data = await request.file({
        limits: { fileSize: MAX_WHEEL_IMAGE_BYTES, files: 1, fields: 0, parts: 1 },
      });
      if (!data) throw new WheelImageError(400, "IMAGE_INVALID", "ต้องแนบไฟล์รูปภาพ");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of data.file) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_WHEEL_IMAGE_BYTES) {
          throw new MerchError(400, "IMAGE_TOO_LARGE", "รูปภาพต้องมีขนาดไม่เกิน 5 MB");
        }
        chunks.push(buffer);
      }
      if (data.file.truncated) {
        throw new MerchError(400, "IMAGE_TOO_LARGE", "รูปภาพต้องมีขนาดไม่เกิน 5 MB");
      }
      const image = await uploadMerchImage(
        db,
        admin,
        eventId,
        { buffer: Buffer.concat(chunks), filename: data.filename, mimetype: data.mimetype },
        options.imageStorage,
        options.nodeEnv,
      );
      return { data: image, status: 201 };
    }),
  );

  app.get(
    "/merchandise/events/:eventId/categories",
    route(async ({ eventId }) => ({ data: await listCategories(db, eventId) })),
  );
  app.post(
    "/merchandise/events/:eventId/categories",
    route(async ({ eventId, request }) => ({
      data: await createCategory(db, eventId, categoryCreateInput.parse(request.body)),
      status: 201,
    })),
  );
  app.put(
    "/merchandise/events/:eventId/categories/order",
    route(async ({ eventId, request }) => {
      await orderCategories(db, eventId, orderInput.parse(request.body).ids);
      return { data: await listCategories(db, eventId) };
    }),
  );
  app.patch(
    "/merchandise/events/:eventId/categories/:id",
    route(async ({ eventId, request }) => ({
      data: await patchCategory(db, eventId, idParam(request), categoryPatchInput.parse(request.body)),
    })),
  );
  app.delete(
    "/merchandise/events/:eventId/categories/:id",
    route(async ({ eventId, request }) => {
      await deleteCategory(db, eventId, idParam(request));
      return { data: { deleted: true } };
    }),
  );

  app.get(
    "/merchandise/events/:eventId/banners",
    route(async ({ eventId }) => ({ data: await listBanners(db, eventId) })),
  );
  app.post(
    "/merchandise/events/:eventId/banners",
    route(async ({ eventId, request }) => ({
      data: await createBanner(db, eventId, bannerCreateInput.parse(request.body)),
      status: 201,
    })),
  );
  app.put(
    "/merchandise/events/:eventId/banners/order",
    route(async ({ eventId, request }) => {
      await orderBanners(db, eventId, orderInput.parse(request.body).ids);
      return { data: await listBanners(db, eventId) };
    }),
  );
  app.patch(
    "/merchandise/events/:eventId/banners/:id",
    route(async ({ eventId, request }) => ({
      data: await patchBanner(db, eventId, idParam(request), bannerPatchInput.parse(request.body)),
    })),
  );
  app.delete(
    "/merchandise/events/:eventId/banners/:id",
    route(async ({ eventId, request }) => {
      await deleteBanner(db, eventId, idParam(request));
      return { data: { deleted: true } };
    }),
  );
}
