import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_WHEEL_IMAGE_BYTES, WheelImageError } from "../lucky-wheel/images.js";
import {
  bulkInput,
  bulkUpdateProducts,
  componentsInput,
  createProduct,
  getAdminProduct,
  listAdminProducts,
  orderProducts,
  previewProduct,
  previewStore,
  productCreateInput,
  productListQuery,
  productOrderInput,
  productPatchInput,
  publishProduct,
  replaceComponents,
  replaceVariants,
  transitionInput,
  unpublishProduct,
  updateProduct,
  variantsInput,
} from "./admin-catalog.js";
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
import { adminRoute } from "./http.js";
import { uploadMerchImage } from "./images.js";
import { merchandiseAdminOrderRoutes } from "./routes.admin.orders.js";
import type { MerchRouteOptions } from "./types.js";

const idSchema = z.string().uuid();

export async function merchandiseAdminRoutes(
  app: FastifyInstance,
  options: MerchRouteOptions,
): Promise<void> {
  const db = options.database;

  const route = adminRoute(db);

  await app.register((orders) => merchandiseAdminOrderRoutes(orders, options));

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
        throwFileSizeLimit: true,
      });
      if (!data) throw new WheelImageError(400, "IMAGE_INVALID", "ต้องแนบไฟล์รูปภาพ");
      const buffer = await data.toBuffer();
      const image = await uploadMerchImage(
        db,
        admin,
        eventId,
        { buffer, filename: data.filename, mimetype: data.mimetype },
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

  const P = "/merchandise/events/:eventId";
  app.get(
    `${P}/products`,
    route(async ({ eventId, request }) => ({
      data: await listAdminProducts(db, eventId, productListQuery.parse(request.query)),
    })),
  );
  app.post(
    `${P}/products`,
    route(async ({ admin, eventId, request }) => ({
      data: await createProduct(db, admin, eventId, productCreateInput.parse(request.body)),
      status: 201,
    })),
  );
  app.put(
    `${P}/products/order`,
    route(async ({ eventId, request }) => {
      await orderProducts(db, eventId, productOrderInput.parse(request.body).ids);
      return { data: await listAdminProducts(db, eventId, {}) };
    }),
  );
  app.post(
    `${P}/products/bulk`,
    route(async ({ admin, eventId, request }) => ({
      data: await bulkUpdateProducts(db, admin, eventId, bulkInput.parse(request.body)),
    })),
  );
  app.get(
    `${P}/products/:id`,
    route(async ({ eventId, request }) => ({
      data: await getAdminProduct(db, eventId, idParam(request)),
    })),
  );
  app.patch(
    `${P}/products/:id`,
    route(async ({ admin, eventId, request }) => ({
      data: await updateProduct(db, admin, eventId, idParam(request), productPatchInput.parse(request.body)),
    })),
  );
  app.put(
    `${P}/products/:id/variants`,
    route(async ({ admin, eventId, request }) => ({
      data: await replaceVariants(db, admin, eventId, idParam(request), variantsInput.parse(request.body)),
    })),
  );
  app.put(
    `${P}/products/:id/components`,
    route(async ({ admin, eventId, request }) => ({
      data: await replaceComponents(db, admin, eventId, idParam(request), componentsInput.parse(request.body)),
    })),
  );
  app.post(
    `${P}/products/:id/publish`,
    route(async ({ admin, eventId, request }) => ({
      data: await publishProduct(
        db, admin, eventId, idParam(request),
        transitionInput.parse(request.body ?? {}).expectedVersion,
      ),
    })),
  );
  app.post(
    `${P}/products/:id/unpublish`,
    route(async ({ admin, eventId, request }) => ({
      data: await unpublishProduct(
        db, admin, eventId, idParam(request),
        transitionInput.parse(request.body ?? {}).expectedVersion,
      ),
    })),
  );

  app.get(
    `${P}/preview/store`,
    route(async ({ eventId }) => ({ data: await previewStore(db, eventId) })),
  );
  app.get(
    `${P}/preview/products/:id`,
    route(async ({ eventId, request }) => ({
      data: await previewProduct(db, eventId, idParam(request)),
    })),
  );
}
