import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireBuyer, type Buyer } from "./access.js";
import { addCartItem, addCartItemInput, readCart, removeCartItem, updateCartItem, updateCartItemInput } from "./cart.js";
import { MerchError } from "./errors.js";
import { merchRateLimit, noStore, ok, sendMerchFailure } from "./http.js";
import { eventByCode } from "./store-window.js";
import type { MerchRouteOptions } from "./types.js";

const itemIdSchema = z.string().uuid();

export async function merchandiseBuyerRoutes(
  app: FastifyInstance,
  options: MerchRouteOptions,
): Promise<void> {
  const db = options.database;
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  const cartRateLimit = merchRateLimit(app, { max: 60, groupId: "merchandise-cart" });
  const routeOptions = { config: { rateLimit: false as const }, preHandler: cartRateLimit };

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
}
