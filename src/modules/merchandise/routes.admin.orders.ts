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
import { adminRoute } from "./http.js";
import { editOrder, orderEditInput } from "./order-edit.js";
import { contextFrom } from "./payments/attempts.js";
import { checkOrderPayments } from "./payments/settlement.js";
import type { MerchRouteOptions } from "./types.js";

const idSchema = z.string().uuid();

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
