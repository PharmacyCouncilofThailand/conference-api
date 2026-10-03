import path from "path";
import dotenv from "dotenv";

// Load env from root (monorepo structure)
const rootEnvPath = path.resolve(process.cwd(), "../../.env");
dotenv.config({ path: rootEnvPath });

export function readPrisWheelClaimOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PRIS_WHEEL_CLAIM_ORIGIN?.trim();
  if (!configured) throw new Error("PRIS_WHEEL_CLAIM_ORIGIN is required for Lucky Wheel QR projection");
  const url = new URL(configured);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && local && url.protocol === "http:"))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("PRIS_WHEEL_CLAIM_ORIGIN must be an HTTPS origin (local HTTP only outside production)");
  }
  return url.origin;
}
