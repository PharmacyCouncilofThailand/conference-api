import type { MerchDb } from "./db.js";
import { createPaysoClient, readPaysoConfig } from "./payments/payso-client.js";
import type { MerchRouteOptions } from "./types.js";

export { merchandiseAdminRoutes } from "./routes.admin.catalog.js";
export { merchandiseBuyerRoutes } from "./routes.buyer.js";
export { merchandiseProviderRoutes } from "./routes.provider.js";
export { merchandisePublicRoutes } from "./routes.public.js";

/**
 * Route options shared by every merchandise plugin. Without the five PaySolution variables
 * `payso` and `paysoConfig` stay null (payment features report unavailable). A blank NODE_ENV
 * is kept blank so it is treated as production, never as development.
 */
export function buildMerchandiseOptions(
  database: MerchDb,
  env: NodeJS.ProcessEnv = process.env,
): MerchRouteOptions {
  const paysoConfig = readPaysoConfig(env);
  return {
    database,
    payso: paysoConfig ? createPaysoClient(paysoConfig) : null,
    paysoConfig,
    nodeEnv: env.NODE_ENV ?? "",
  };
}
