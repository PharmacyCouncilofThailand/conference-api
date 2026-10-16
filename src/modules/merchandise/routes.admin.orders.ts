import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  assertEventOrder,
  listAdminOrders,
  listPaymentReviews,
  orderFilterSchema,
  readAdminOrderDetail,
  resolveReview,
  resolveReviewInput,
  reviewListQuery,
} from "./admin-orders.js";
import { resendNotification } from "./email.js";
import { adminRoute } from "./http.js";
import { editOrder, orderEditInput } from "./order-edit.js";
import { contextFrom } from "./payments/attempts.js";
import { checkOrderPayments } from "./payments/settlement.js";
import {
  buildOrdersWorkbook,
  buildProductionWorkbook,
  eventCodeOf,
  exportFilename,
  orderReportRows,
  productionRows,
  XLSX_CONTENT_TYPE,
} from "./reports.js";
import { bulkShipmentInput, bulkShipments, setShipment, shipmentInput } from "./shipping.js";
import type { MerchRouteOptions } from "./types.js";

const idSchema = z.string().uuid();
const resendInput = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
const notificationType = z.enum(["paid", "shipped"]);

/** Admin orders and payment reviews (§8.4); registered inside `merchandiseAdminRoutes`. */
export async function merchandiseAdminOrderRoutes(
  app: FastifyInstance,
  options: MerchRouteOptions,
): Promise<void> {
  const db = options.database;
  const ctx = contextFrom(options, app.log);
  const route = adminRoute(db);
  const idParam = (request: FastifyRequest) =>
    idSchema.parse((request.params as { id?: unknown }).id);
  const P = "/merchandise/events/:eventId";

  app.get(
    `${P}/orders`,
    route(async ({ eventId, request }) => ({
      data: await listAdminOrders(db, eventId, orderFilterSchema.parse(request.query)),
    })),
  );
  app.get(
    `${P}/orders/export.xlsx`,
    route(async ({ eventId, request }) => {
      const { page: _page, limit: _limit, ...filters } = orderFilterSchema.parse(request.query);
      const buffer = await buildOrdersWorkbook(await orderReportRows(db, eventId, filters));
      const filename = exportFilename("orders", await eventCodeOf(db, eventId));
      return { file: { buffer, contentType: XLSX_CONTENT_TYPE, filename } };
    }),
  );
  app.get(
    `${P}/production`,
    route(async ({ eventId }) => ({ data: await productionRows(db, eventId) })),
  );
  app.get(
    `${P}/production/export.xlsx`,
    route(async ({ eventId }) => {
      const buffer = await buildProductionWorkbook(await productionRows(db, eventId));
      const filename = exportFilename("production", await eventCodeOf(db, eventId));
      return { file: { buffer, contentType: XLSX_CONTENT_TYPE, filename } };
    }),
  );
  app.get(
    `${P}/orders/:id`,
    route(async ({ eventId, request }) => ({
      data: await readAdminOrderDetail(ctx, eventId, idParam(request)),
    })),
  );
  app.patch(
    `${P}/orders/:id`,
    route(async ({ admin, eventId, request }) => ({
      data: await editOrder(ctx, admin, eventId, idParam(request), orderEditInput.parse(request.body)),
    })),
  );
  app.post(
    `${P}/orders/:id/payment-checks`,
    route(async ({ eventId, request }) => {
      const orderId = idParam(request);
      await assertEventOrder(db, eventId, orderId);
      await checkOrderPayments(ctx, orderId);
      return { data: await readAdminOrderDetail(ctx, eventId, orderId) };
    }),
  );

  app.post(
    `${P}/orders/:id/notifications/:type/resend`,
    route(async ({ admin, eventId, request }) => {
      const type = notificationType.parse((request.params as { type?: unknown }).type);
      const { reason } = resendInput.parse(request.body ?? {});
      await resendNotification(db, admin, eventId, idParam(request), type, reason);
      return { data: { ok: true } };
    }),
  );

  app.put(
    `${P}/orders/:id/shipment`,
    route(async ({ admin, eventId, request }) => ({
      data: await setShipment(db, admin, eventId, idParam(request), shipmentInput.parse(request.body)),
    })),
  );
  app.post(
    `${P}/orders/shipments/bulk`,
    route(async ({ admin, eventId, request }) => ({
      data: { results: await bulkShipments(db, admin, eventId, bulkShipmentInput.parse(request.body).rows) },
    })),
  );

  app.get(
    `${P}/payment-reviews`,
    route(async ({ eventId, request }) => ({
      data: await listPaymentReviews(db, eventId, reviewListQuery.parse(request.query).resolved),
    })),
  );
  app.post(
    `${P}/payment-attempts/:id/resolve-review`,
    route(async ({ admin, eventId, request }) => ({
      data: await resolveReview(db, admin, eventId, idParam(request), resolveReviewInput.parse(request.body ?? {}).note),
    })),
  );
}
