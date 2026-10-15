import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireBuyer, type Buyer } from "./access.js";
import { addCartItem, addCartItemInput, readCart, removeCartItem, updateCartItem, updateCartItemInput } from "./cart.js";
import { MerchError } from "./errors.js";
import { merchRateLimit, noStore, ok, sendMerchFailure } from "./http.js";
import { confirmOrder, listBuyerOrders, readOrderDetail } from "./orders.js";
import { contextFrom } from "./payments/attempts.js";
import { recipientSchema } from "./recipient.js";
import { eventByCode } from "./store-window.js";
import type { MerchRouteOptions } from "./types.js";

const itemIdSchema = z.string().uuid();
const orderIdSchema = z.string().uuid();
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const confirmOrderInput = z
  .object({ cartVersion: z.string().min(1).max(128), recipient: recipientSchema })
  .strict();
const orderListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function idempotencyKey(request: FastifyRequest): string {
  const parsed = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
  if (!parsed.success) {
    throw new MerchError(400, "VALIDATION_ERROR", "ข้อมูลที่ส่งมาไม่ถูกต้อง", {
      fieldErrors: { "Idempotency-Key": ["ต้องเป็น A-Z a-z 0-9 _ - ยาว 1-100 ตัวอักษร"] },
    });
  }
  return parsed.data;
}

export async function merchandiseBuyerRoutes(
  app: FastifyInstance,
  options: MerchRouteOptions,
): Promise<void> {
  const db = options.database;
  const ctx = contextFrom(options);
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  const cartRateLimit = merchRateLimit(app, { max: 60, groupId: "merchandise-cart" });
  const routeOptions = { config: { rateLimit: false as const }, preHandler: cartRateLimit };
  const ordersRateLimit = merchRateLimit(app, { max: 10, groupId: "merchandise-orders" });

  const route =
    (handler: (buyer: Buyer, eventId: number, request: FastifyRequest) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        noStore(reply);
        const buyer = await requireBuyer(db, request);
        const { eventCode } = request.params as { eventCode: string };
        const event = await eventByCode(db, eventCode);
        return ok(reply, await handler(buyer, event.id, request));
      } catch (error) {
        return sendMerchFailure(reply, request, error);
      }
    };

  const itemId = (request: FastifyRequest): string => {
    const parsed = itemIdSchema.safeParse((request.params as { itemId?: unknown }).itemId);
    if (!parsed.success) throw new MerchError(404, "MERCH_CART_ITEM_NOT_FOUND", "ไม่พบรายการในตะกร้า");
    return parsed.data;
  };

  app.get(
    "/events/:eventCode/cart",
    routeOptions,
    route((buyer, eventId) => readCart(db, buyer, eventId)),
  );
  app.post(
    "/events/:eventCode/cart/items",
    routeOptions,
    route((buyer, eventId, request) =>
      addCartItem(db, buyer, eventId, addCartItemInput.parse(request.body)),
    ),
  );
  app.patch(
    "/events/:eventCode/cart/items/:itemId",
    routeOptions,
    route((buyer, eventId, request) =>
      updateCartItem(db, buyer, eventId, itemId(request), updateCartItemInput.parse(request.body)),
    ),
  );
  app.delete(
    "/events/:eventCode/cart/items/:itemId",
    routeOptions,
    route((buyer, eventId, request) => removeCartItem(db, buyer, eventId, itemId(request))),
  );

  app.post(
    "/events/:eventCode/orders",
    { config: { rateLimit: false as const }, preHandler: ordersRateLimit },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        noStore(reply);
        const buyer = await requireBuyer(db, request);
        const { eventCode } = request.params as { eventCode: string };
        const key = idempotencyKey(request);
        const body = confirmOrderInput.parse(request.body);
        const result = await confirmOrder(ctx, buyer, eventCode, {
          idempotencyKey: key,
          cartVersion: body.cartVersion,
          recipient: body.recipient,
        });
        return ok(reply, result, 201);
      } catch (error) {
        return sendMerchFailure(reply, request, error);
      }
    },
  );
  app.get(
    "/events/:eventCode/orders",
    { config: { rateLimit: false as const } },
    route((buyer, eventId, request) => {
      const query = orderListQuery.parse(request.query);
      return listBuyerOrders(db, buyer, eventId, query.page, query.limit);
    }),
  );
  app.get(
    "/orders/:orderId",
    { config: { rateLimit: false as const } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        noStore(reply);
        const buyer = await requireBuyer(db, request);
        const parsed = orderIdSchema.safeParse((request.params as { orderId?: unknown }).orderId);
        if (!parsed.success) throw new MerchError(404, "MERCH_ORDER_NOT_FOUND", "ไม่พบคำสั่งซื้อ");
        return ok(reply, await readOrderDetail(ctx, parsed.data, { ownerId: buyer.id }));
      } catch (error) {
        return sendMerchFailure(reply, request, error);
      }
    },
  );
}
