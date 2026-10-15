import { randomUUID } from "node:crypto";
import { merchImages } from "../../database/schema.js";
import {
  createR2ImageStorage,
  normalizeWheelImage,
  readR2ImageConfig,
  WheelImageError,
  type WheelImageFile,
  type WheelImageStorage,
} from "../lucky-wheel/images.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import type { ImageAsset } from "./types.js";

function toMerchImageError(error: unknown): unknown {
  if (error instanceof WheelImageError) {
    return new MerchError(error.statusCode, error.code, error.message, error.details, error);
  }
  return error;
}

export async function uploadMerchImage(
  db: MerchDb,
  admin: { id: number },
  eventId: number,
  file: WheelImageFile,
  storage?: WheelImageStorage,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): Promise<ImageAsset> {
  try {
    const normalized = await normalizeWheelImage(file);
    const config = readR2ImageConfig(process.env, nodeEnv);
    const store = storage ?? createR2ImageStorage(config);
    const id = randomUUID();
    const key = `events/${eventId}/merchandise/${id}.${normalized.extension}`;
    const url = `${config.publicBaseUrl}/${key}`;

    try {
      await store.putObject({
        key,
        body: normalized.buffer,
        contentType: normalized.mimeType,
        cacheControl: "public, max-age=31536000, immutable",
      });
    } catch (cause) {
      throw new MerchError(502, "IMAGE_STORAGE_FAILED", "อัปโหลดรูปไม่สำเร็จ", undefined, cause);
    }

    try {
      await db.insert(merchImages).values({
        id,
        eventId,
        objectKey: key,
        publicUrl: url,
        mimeType: normalized.mimeType,
        width: normalized.width,
        height: normalized.height,
        byteSize: normalized.sizeBytes,
        uploadedBy: admin.id,
      });
    } catch (cause) {
      try {
        await store.deleteObject(key);
      } catch {
        // best effort; an orphaned object is harmless
      }
      throw new MerchError(500, "IMAGE_RECORD_FAILED", "บันทึกข้อมูลรูปไม่สำเร็จ", undefined, cause);
    }
    return { id, url, width: normalized.width, height: normalized.height };
  } catch (error) {
    throw toMerchImageError(error);
  }
}
