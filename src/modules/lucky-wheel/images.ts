import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import type { WheelActor, WheelDatabase } from "./service.js";
import { validateAdminActor } from "./service.js";

export const MAX_WHEEL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_WHEEL_IMAGE_PIXELS = 16_000_000;
export const MAX_WHEEL_IMAGE_DIMENSION = 1600;

type ImageFormat = "jpeg" | "png" | "webp";

const FORMAT_MIME: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const FORMAT_EXTENSION: Record<ImageFormat, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

export type WheelImageFile = {
  buffer: Buffer;
  filename: string;
  mimetype: string;
};

export type NormalizedWheelImage = {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  sizeBytes: number;
};

export type WheelImageStorage = {
  putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
    cacheControl: string;
    signal?: AbortSignal;
  }): Promise<void>;
  deleteObject(key: string): Promise<void>;
};

export type WheelImageLogger = {
  warn(details: Record<string, unknown>, message: string): void;
};

export type R2ImageConfig = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
};

export type WheelImageContext = {
  database?: WheelDatabase;
  storage?: WheelImageStorage;
  env?: NodeJS.ProcessEnv;
  nodeEnv?: string;
  logger?: WheelImageLogger;
  createImageId?: () => string;
};

export class WheelImageError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code:
      | "ADMIN_REQUIRED"
      | "IMAGE_CONFIG_ERROR"
      | "IMAGE_INVALID"
      | "IMAGE_TOO_LARGE"
      | "IMAGE_STORAGE_FAILED"
      | "IMAGE_RECORD_FAILED",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WheelImageError";
  }
}

function requiredConfig(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv,
): string {
  const value = env[name]?.trim() ?? "";
  if (!value) {
    throw new WheelImageError(
      503,
      "IMAGE_CONFIG_ERROR",
      "Lucky Wheel image storage is not configured",
    );
  }
  return value;
}

export function readR2ImageConfig(
  env: NodeJS.ProcessEnv = process.env,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): R2ImageConfig {
  const accountId = requiredConfig(env, "R2_ACCOUNT_ID");
  const bucket = requiredConfig(env, "R2_BUCKET");
  const accessKeyId = requiredConfig(env, "R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredConfig(env, "R2_SECRET_ACCESS_KEY");
  const rawBase = requiredConfig(env, "R2_PUBLIC_BASE_URL");

  let publicBase: URL;
  try {
    publicBase = new URL(rawBase);
  } catch {
    throw new WheelImageError(
      503,
      "IMAGE_CONFIG_ERROR",
      "Lucky Wheel public image base URL is invalid",
    );
  }

  if (
    !["http:", "https:"].includes(publicBase.protocol) ||
    (nodeEnv === "production" && publicBase.protocol !== "https:") ||
    publicBase.username ||
    publicBase.password ||
    publicBase.search ||
    publicBase.hash ||
    publicBase.pathname !== "/"
  ) {
    throw new WheelImageError(
      503,
      "IMAGE_CONFIG_ERROR",
      "Lucky Wheel public image base URL must be a trusted root origin",
    );
  }

  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: publicBase.origin,
  };
}

export function createR2ImageStorage(config: R2ImageConfig): WheelImageStorage {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async putObject(input) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.length,
        CacheControl: input.cacheControl,
      }), { abortSignal: input.signal });
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }));
    },
  };
}

function formatFromMetadata(format: string | undefined): ImageFormat {
  if (format === "jpeg" || format === "png" || format === "webp") {
    return format;
  }
  throw new WheelImageError(
    400,
    "IMAGE_INVALID",
    "Only decoded JPEG, PNG, and WebP images are allowed",
  );
}

export async function normalizeWheelImage(
  file: WheelImageFile,
): Promise<NormalizedWheelImage> {
  if (file.buffer.length === 0) {
    throw new WheelImageError(400, "IMAGE_INVALID", "Image file is empty");
  }
  if (file.buffer.length > MAX_WHEEL_IMAGE_BYTES) {
    throw new WheelImageError(
      400,
      "IMAGE_TOO_LARGE",
      "Lucky Wheel image must be 5 MiB or smaller",
    );
  }

  const acceptedClaimedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!acceptedClaimedTypes.has(file.mimetype.toLowerCase())) {
    throw new WheelImageError(
      400,
      "IMAGE_INVALID",
      "Lucky Wheel image must be JPEG, PNG, or WebP",
    );
  }

  let metadata: Awaited<
    ReturnType<ReturnType<typeof sharp>["metadata"]>
  >;
  try {
    metadata = await sharp(file.buffer, {
      failOn: "error",
      limitInputPixels: MAX_WHEEL_IMAGE_PIXELS,
      animated: true,
    }).metadata();
  } catch {
    throw new WheelImageError(
      400,
      "IMAGE_INVALID",
      "Image bytes could not be decoded safely",
    );
  }

  const format = formatFromMetadata(metadata.format);
  if (FORMAT_MIME[format] !== file.mimetype.toLowerCase()) {
    throw new WheelImageError(
      400,
      "IMAGE_INVALID",
      "Declared image type does not match decoded bytes",
    );
  }
  if (!metadata.width || !metadata.height) {
    throw new WheelImageError(
      400,
      "IMAGE_INVALID",
      "Decoded image dimensions are unavailable",
    );
  }
  if (metadata.width * metadata.height > MAX_WHEEL_IMAGE_PIXELS) {
    throw new WheelImageError(
      400,
      "IMAGE_INVALID",
      "Decoded image exceeds the 16 megapixel limit",
    );
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new WheelImageError(
      400,
      "IMAGE_INVALID",
      "Animated images are not allowed",
    );
  }

  let pipeline = sharp(file.buffer, {
    failOn: "error",
    limitInputPixels: MAX_WHEEL_IMAGE_PIXELS,
    animated: false,
  })
    .rotate()
    .resize({
      width: MAX_WHEEL_IMAGE_DIMENSION,
      height: MAX_WHEEL_IMAGE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });

  if (format === "jpeg") {
    pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
  } else if (format === "png") {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else {
    pipeline = pipeline.webp({ quality: 90 });
  }

  let output: Buffer;
  try {
    output = await pipeline.toBuffer();
  } catch {
    throw new WheelImageError(
      400,
      "IMAGE_INVALID",
      "Image normalization failed",
    );
  }
  if (output.length > MAX_WHEEL_IMAGE_BYTES) {
    throw new WheelImageError(
      400,
      "IMAGE_TOO_LARGE",
      "Normalized Lucky Wheel image exceeds 5 MiB",
    );
  }

  const normalizedMetadata = await sharp(output, {
    failOn: "error",
    limitInputPixels: MAX_WHEEL_IMAGE_PIXELS,
  }).metadata();
  if (!normalizedMetadata.width || !normalizedMetadata.height) {
    throw new WheelImageError(
      400,
      "IMAGE_INVALID",
      "Normalized image dimensions are unavailable",
    );
  }

  return {
    buffer: output,
    mimeType: FORMAT_MIME[format],
    extension: FORMAT_EXTENSION[format],
    width: normalizedMetadata.width,
    height: normalizedMetadata.height,
    sizeBytes: output.length,
  };
}

async function resolveImageDatabase(
  context: WheelImageContext,
): Promise<WheelDatabase> {
  if (context.database) return context.database;
  return (await import("../../database/index.js")).db;
}

function publicImageUrl(publicBaseUrl: string, key: string): string {
  return new URL(key, `${publicBaseUrl}/`).toString();
}

export async function uploadWheelImage(
  actor: WheelActor,
  eventId: number,
  file: WheelImageFile,
  context: WheelImageContext = {},
): Promise<{
  imageId: string;
  imageKey: string;
  url: string;
  width: number;
  height: number;
}> {
  const database = await resolveImageDatabase(context);
  const admin = await validateAdminActor(database, actor, eventId);
  if (!admin) {
    throw new WheelImageError(
      403,
      "ADMIN_REQUIRED",
      "Active admin access is required",
    );
  }

  const normalized = await normalizeWheelImage(file);
  const config = readR2ImageConfig(
    context.env ?? process.env,
    context.nodeEnv ?? process.env.NODE_ENV,
  );
  const storage = context.storage ?? createR2ImageStorage(config);
  const imageId = (context.createImageId ?? randomUUID)();
  const imageKey = `events/${eventId}/wheel/${imageId}.${normalized.extension}`;
  const url = publicImageUrl(config.publicBaseUrl, imageKey);

  try {
    await storage.putObject({
      key: imageKey,
      body: normalized.buffer,
      contentType: normalized.mimeType,
      cacheControl: "public, max-age=31536000, immutable",
    });
  } catch {
    throw new WheelImageError(
      502,
      "IMAGE_STORAGE_FAILED",
      "Lucky Wheel image upload failed",
    );
  }

  try {
    await database.execute(sql`
      INSERT INTO lucky_wheel_images (
        id, event_id, object_key, public_url, mime_type,
        width, height, size_bytes, created_by
      )
      VALUES (
        ${imageId}, ${eventId}, ${imageKey}, ${url}, ${normalized.mimeType},
        ${normalized.width}, ${normalized.height}, ${normalized.sizeBytes}, ${admin.id}
      )
    `);
  } catch {
    try {
      await storage.deleteObject(imageKey);
    } catch {
      context.logger?.warn(
        { imageKey, code: "R2_CLEANUP_FAILED" },
        "Lucky Wheel image DB record failed and best-effort R2 cleanup also failed",
      );
    }
    throw new WheelImageError(
      500,
      "IMAGE_RECORD_FAILED",
      "Lucky Wheel image metadata could not be recorded",
      { imageKey },
    );
  }

  return {
    imageId,
    imageKey,
    url,
    width: normalized.width,
    height: normalized.height,
  };
}

export type UnreferencedWheelImage = {
  id: string;
  objectKey: string;
  createdAt: string;
};

export async function findUnreferencedWheelImages(
  database: WheelDatabase,
  eventId: number,
  olderThan: Date,
): Promise<UnreferencedWheelImage[]> {
  const rows = await database.execute(sql`
    SELECT img.id, img.object_key, img.created_at
    FROM lucky_wheel_images img
    WHERE img.event_id = ${eventId}
      AND img.deleted_at IS NULL
      AND img.created_at < ${olderThan.toISOString()}::timestamptz
      AND NOT EXISTS (
        SELECT 1
        FROM lucky_wheel_segments seg
        WHERE seg.image_id = img.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM lucky_wheel_spins spin
        WHERE spin.event_id = img.event_id
          AND spin.awarded_image_key = img.object_key
      )
    ORDER BY img.created_at, img.id
  `);
  return (rows as unknown as Array<{
    id: string;
    object_key: string;
    created_at: Date | string;
  }>).map((row) => ({
    id: row.id,
    objectKey: row.object_key,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  }));
}

export async function cleanupUnreferencedWheelImages(
  database: WheelDatabase,
  eventId: number,
  olderThan: Date,
  context: Omit<WheelImageContext, "database" | "createImageId"> = {},
): Promise<{ deleted: string[]; failed: string[] }> {
  const config = readR2ImageConfig(
    context.env ?? process.env,
    context.nodeEnv ?? process.env.NODE_ENV,
  );
  const storage = context.storage ?? createR2ImageStorage(config);
  const candidates = await findUnreferencedWheelImages(
    database,
    eventId,
    olderThan,
  );
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const candidate of candidates) {
    const claimed = await database.transaction(async (tx) => {
      const txDb = tx as unknown as WheelDatabase;
      const lockedRows = await txDb.execute(sql`
        SELECT id, object_key
        FROM lucky_wheel_images
        WHERE id = ${candidate.id}
          AND event_id = ${eventId}
          AND deleted_at IS NULL
          AND created_at < ${olderThan.toISOString()}::timestamptz
        FOR UPDATE
      `);
      const locked = (
        lockedRows as unknown as Array<{ id: string; object_key: string }>
      )[0];
      if (!locked) return null;

      const referenceRows = await txDb.execute(sql`
        SELECT EXISTS (
          SELECT 1
          FROM lucky_wheel_segments seg
          WHERE seg.image_id = ${locked.id}
        ) OR EXISTS (
          SELECT 1
          FROM lucky_wheel_spins spin
          WHERE spin.event_id = ${eventId}
            AND spin.awarded_image_key = ${locked.object_key}
        ) AS referenced
      `);
      const referenced = (
        referenceRows as unknown as Array<{ referenced: boolean }>
      )[0]?.referenced;
      if (referenced) return null;

      const markedRows = await txDb.execute(sql`
        UPDATE lucky_wheel_images
        SET deleted_at = clock_timestamp()
        WHERE id = ${locked.id}
          AND event_id = ${eventId}
          AND deleted_at IS NULL
        RETURNING object_key
      `);
      return (
        markedRows as unknown as Array<{ object_key: string }>
      )[0] ?? null;
    });
    if (!claimed) continue;

    try {
      await storage.deleteObject(claimed.object_key);
      deleted.push(claimed.object_key);
    } catch {
      await database.execute(sql`
        UPDATE lucky_wheel_images
        SET deleted_at = NULL
        WHERE id = ${candidate.id}
          AND event_id = ${eventId}
          AND object_key = ${claimed.object_key}
          AND deleted_at IS NOT NULL
      `);
      failed.push(claimed.object_key);
      context.logger?.warn(
        { imageKey: claimed.object_key, code: "R2_CLEANUP_FAILED" },
        "Lucky Wheel unreferenced image cleanup failed",
      );
    }
  }

  return { deleted, failed };
}
