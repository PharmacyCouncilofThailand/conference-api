import { inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { merchProducts } from "../../database/schema.js";
import { loadCatalog, loadImages, toProductDto, toStoreDto } from "./catalog-read.js";
import type { CatalogSnapshot } from "./catalog-rules.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { ok, sendMerchFailure } from "./http.js";
import { eventByCode, readStore } from "./store-window.js";
import type { ImageAsset, MerchRouteOptions, ProductDto } from "./types.js";

const idSchema = z.string().uuid();

const listQuery = z.object({
  categoryId: idSchema.optional(),
  kind: z.enum(["single", "bundle"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// A published bundle may reference a component that is not published, so the
// component is absent from the public catalog snapshot. Keep its name visible.
async function fillComponentNames(db: MerchDb, dtos: ProductDto[]) {
  const missing = new Set<string>();
  for (const dto of dtos) {
    for (const c of dto.components) {
      if (!c.nameTh) missing.add(c.productId);
    }
  }
  if (missing.size === 0) return;
  const rows = await db
    .select({ id: merchProducts.id, nameTh: merchProducts.nameTh })
    .from(merchProducts)
    .where(inArray(merchProducts.id, [...missing]));
  const names = new Map(rows.map((r) => [r.id, r.nameTh]));
  for (const dto of dtos) {
    for (const c of dto.components) {
      if (!c.nameTh) c.nameTh = names.get(c.productId) ?? "";
    }
  }
}

export async function merchandisePublicRoutes(
  app: FastifyInstance,
  options: MerchRouteOptions,
): Promise<void> {
  const db = options.database;

  const route =
    (handler: (eventId: number, request: FastifyRequest) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { eventCode } = request.params as { eventCode: string };
        const event = await eventByCode(db, eventCode);
        return ok(reply, await handler(event.id, request));
      } catch (error) {
        return sendMerchFailure(reply, request, error);
      }
    };

  const buildDtos = async (
    eventId: number,
    catalog: CatalogSnapshot,
    ids: string[],
  ): Promise<ProductDto[]> => {
    const { state } = await readStore(db, eventId);
    const images: Map<string, ImageAsset> = await loadImages(
      db,
      ids.flatMap((id) => [
        ...(catalog.products.get(id)?.imageIds ?? []),
        ...(catalog.componentsByBundle.get(id) ?? []).flatMap(
          (c) => catalog.products.get(c.componentProductId)?.imageIds ?? [],
        ),
      ]),
    );
    const dtos = ids.map((id) => toProductDto(id, catalog, state, images));
    await fillComponentNames(db, dtos);
    return dtos;
  };

  app.get(
    "/events/:eventCode/store",
    route(async (eventId) => {
      const store = await toStoreDto(db, eventId, { includeHidden: false });
      return {
        ...store,
        productionInfoTh: store.productionInfoTh?.trim() ? store.productionInfoTh : null,
        shippingInfoTh: store.shippingInfoTh?.trim() ? store.shippingInfoTh : null,
      };
    }),
  );

  app.get(
    "/events/:eventCode/products",
    route(async (eventId, request) => {
      const query = listQuery.parse(request.query);
      // The snapshot is already ordered by sort_order; filter, then page.
      const catalog = await loadCatalog(db, eventId, { includeDrafts: false });
      const all = [...catalog.products.values()]
        .filter(
          (p) =>
            (!query.kind || p.kind === query.kind) &&
            (!query.categoryId || p.categoryId === query.categoryId),
        )
        .map((p) => p.id);
      const total = all.length;
      const pageIds = all.slice((query.page - 1) * query.limit, query.page * query.limit);
      const items = await buildDtos(eventId, catalog, pageIds);
      return {
        items,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      };
    }),
  );

  app.get(
    "/events/:eventCode/products/:productId",
    route(async (eventId, request) => {
      const parsed = idSchema.safeParse((request.params as { productId?: unknown }).productId);
      if (!parsed.success) throw new MerchError(404, "MERCH_PRODUCT_NOT_FOUND", "ไม่พบสินค้า");
      const catalog = await loadCatalog(db, eventId, { includeDrafts: false });
      if (!catalog.products.has(parsed.data)) {
        throw new MerchError(404, "MERCH_PRODUCT_NOT_FOUND", "ไม่พบสินค้า");
      }
      const [dto] = await buildDtos(eventId, catalog, [parsed.data]);
      return dto;
    }),
  );
}
