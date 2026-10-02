import type { FastifyInstance } from "fastify";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_BYTES = 3 * 1024 * 1024;
const LIFETIME = 5 * 60_000;
const FILE = /^([a-f0-9]{32})\.(\d{13})\.png$/;

type Options = {
  secret: string;
  directory?: string;
  isOwnedConfirmed: (userId: number, registrationId: number) => Promise<boolean>;
};

export default async function ticketExportRoutes(app: FastifyInstance, options: Options) {
  // ponytail: local temporary files; use a shared private directory for multiple API replicas.
  const directory = options.directory || process.env.TICKET_EXPORT_DIR || path.join(tmpdir(), "pris-ticket-exports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const signature = (payload: string) => createHmac("sha256", options.secret).update("ticket-export:" + payload).digest("base64url");
  const cleanup = async () => {
    for (const name of await readdir(directory)) {
      const match = FILE.exec(name);
      if (match && Number(match[2]) <= Date.now()) {
        await unlink(path.join(directory, name)).catch(() => {});
      }
    }
  };
  await cleanup();
  const timer = setInterval(() => { void cleanup().catch(() => app.log.warn("Ticket export cleanup failed")); }, 60_000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
  });
  app.addContentTypeParser("image/png", { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_request, body, done) => done(null, body));

  app.post<{ Params: { registrationId: string }; Body: Buffer }>("/registrations/:registrationId", {
    onRequest: [app.authenticate],
    bodyLimit: MAX_BYTES,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    schema: { params: { type: "object", properties: { registrationId: { type: "string", pattern: "^[1-9][0-9]{0,9}$" } }, required: ["registrationId"] } },
  }, async (request, reply) => {
    const id = Number(request.params.registrationId);
    if (!await options.isOwnedConfirmed(request.user.id, id)) {
      return reply.code(404).send({ success: false, error: "Confirmed ticket not found" });
    }
    const png = request.body;
    if (!Buffer.isBuffer(png) || png.length < 45 || png.length > MAX_BYTES
      || !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR"
      || !png.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))) {
      return reply.code(400).send({ success: false, error: "Invalid PNG" });
    }
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 8192 || width * height > 12_000_000) {
      return reply.code(400).send({ success: false, error: "PNG dimensions exceed limit" });
    }
    const expiresAt = Date.now() + LIFETIME;
    const payload = randomBytes(16).toString("hex") + "." + expiresAt;
    await writeFile(path.join(directory, payload + ".png"), png, { flag: "wx", mode: 0o600 });
    return reply.code(201).send({ success: true, path: "/api/ticket-exports/" + payload + "." + signature(payload), expiresAt });
  });

  app.get<{ Params: { token: string } }>("/:token", async (request, reply) => {
    const match = /^([a-f0-9]{32}\.\d{13})\.([A-Za-z0-9_-]{43})$/.exec(request.params.token);
    if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(signature(match[1])))) {
      return reply.code(404).send({ success: false, error: "Download not found" });
    }
    if (Number(match[1].split(".")[1]) <= Date.now()) {
      return reply.code(410).send({ success: false, error: "Download expired. Please create a new export." });
    }
    let png: Buffer;
    try { png = await readFile(path.join(directory, match[1] + ".png")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return reply.code(410).send({ success: false, error: "Download expired. Please create a new export." });
    }
    return reply.type("image/png").header("Content-Disposition", 'attachment; filename="PRIS2026-Ticket.png"').send(png);
  });
}
