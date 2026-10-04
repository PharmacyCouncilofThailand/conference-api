import path from "path";
import dotenv from "dotenv";

// Load env from root (monorepo structure)
const rootEnvPath = path.resolve(process.cwd(), "../../.env");
dotenv.config({ path: rootEnvPath });

export function validatePrisWheelClaimOrigin(
  websiteUrl: string | null,
  backofficeOrigin: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = websiteUrl?.trim();
  if (!configured) throw new Error("Set the event website URL to the public PRIS website before downloading a QR code");
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("The event website URL must be an absolute PRIS web origin");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && local && url.protocol === "http:"))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("The event website URL must be an HTTPS origin (local HTTP only outside production)");
  }
  if (backofficeOrigin) {
    try {
      if (new URL(backofficeOrigin).origin === url.origin) {
        throw new Error("The event website URL points to Backoffice; set it to the PRIS website");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("points to Backoffice")) throw error;
    }
  }
  return url.origin;
}
