import { google } from "googleapis";
import { Readable } from "stream";

// Create authenticated Drive client using OAuth2
function getDriveClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google OAuth2 credentials (CLIENT_ID, CLIENT_SECRET, or REFRESH_TOKEN)");
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    "https://developers.google.com/oauthplayground" // Redirect URL
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return google.drive({ version: "v3", auth: oauth2Client });
}

// Folder type mapping
export type UploadFolderType =
  | "student_docs"
  | "abstracts"
  | "speakers"
  | "venue_images"
  | "event_images"
  | "event_documents"
  | "sponsors";

const FOLDER_ENV_MAP: Record<UploadFolderType, string> = {
  student_docs: "GOOGLE_DRIVE_FOLDER_STUDENT_DOCS",
  abstracts: "GOOGLE_DRIVE_FOLDER_ABSTRACTS",
  speakers: "GOOGLE_DRIVE_FOLDER_SPEAKERS",
  venue_images: "GOOGLE_DRIVE_FOLDER_VENUE_IMAGES",
  event_images: "GOOGLE_DRIVE_FOLDER_EVENT_IMAGES",
  event_documents: "GOOGLE_DRIVE_FOLDER_EVENT_DOCUMENTS",
  sponsors: "GOOGLE_DRIVE_SPONSOR_ROOT_FOLDER",
};

// Abstract category type (matches database enum)
export type AbstractCategory =
  | "clinical_pharmacy"
  | "social_administrative"
  | "community_pharmacy"
  | "pharmacology_toxicology"
  | "pharmacy_education"
  | "digital_pharmacy";

// Presentation type (matches database enum)
export type PresentationType = "oral" | "poster";

// Map presentation type to human-readable folder name
const PRESENTATION_TYPE_FOLDER_NAMES: Record<PresentationType, string> = {
  poster: "Poster presentation",
  oral: "Oral presentation",
};

// Map category to human-readable folder name
const CATEGORY_FOLDER_NAMES: Record<AbstractCategory, string> = {
  clinical_pharmacy: "1. Clinical Pharmacy",
  social_administrative: "2. Social and Administrative Pharmacy",
  community_pharmacy: "3. Community Pharmacy",
  pharmacology_toxicology: "4. Pharmacology and Toxicology",
  pharmacy_education: "5. Pharmacy Education",
  digital_pharmacy: "6. Digital Pharmacy and Innovation",
};

// Direct subfolder ENV mapping for faster uploads (bypasses folder lookup)
// Format: GOOGLE_DRIVE_FOLDER_{PRESENTATION_TYPE}_{CATEGORY}
const DIRECT_SUBFOLDER_ENV_MAP: Record<PresentationType, Record<AbstractCategory, string>> = {
  poster: {
    clinical_pharmacy: "GOOGLE_DRIVE_FOLDER_POSTER_CLINICAL_PHARMACY",
    social_administrative: "GOOGLE_DRIVE_FOLDER_POSTER_SOCIAL_ADMINISTRATIVE",
    community_pharmacy: "GOOGLE_DRIVE_FOLDER_POSTER_COMMUNITY_PHARMACY",
    pharmacology_toxicology: "GOOGLE_DRIVE_FOLDER_POSTER_PHARMACOLOGY_TOXICOLOGY",
    pharmacy_education: "GOOGLE_DRIVE_FOLDER_POSTER_PHARMACY_EDUCATION",
    digital_pharmacy: "GOOGLE_DRIVE_FOLDER_POSTER_DIGITAL_PHARMACY",
  },
  oral: {
    clinical_pharmacy: "GOOGLE_DRIVE_FOLDER_ORAL_CLINICAL_PHARMACY",
    social_administrative: "GOOGLE_DRIVE_FOLDER_ORAL_SOCIAL_ADMINISTRATIVE",
    community_pharmacy: "GOOGLE_DRIVE_FOLDER_ORAL_COMMUNITY_PHARMACY",
    pharmacology_toxicology: "GOOGLE_DRIVE_FOLDER_ORAL_PHARMACOLOGY_TOXICOLOGY",
    pharmacy_education: "GOOGLE_DRIVE_FOLDER_ORAL_PHARMACY_EDUCATION",
    digital_pharmacy: "GOOGLE_DRIVE_FOLDER_ORAL_DIGITAL_PHARMACY",
  },
};

/**
 * Get direct subfolder ID from ENV if available
 * Returns null if ENV not set (will fallback to folder lookup)
 */
export function getDirectSubfolderFromEnv(
  presentationType: PresentationType,
  category: AbstractCategory
): string | null {
  const envKey = DIRECT_SUBFOLDER_ENV_MAP[presentationType]?.[category];
  if (!envKey) return null;
  const folderId = process.env[envKey];
  return folderId && folderId.trim() !== "" ? folderId : null;
}

// Cache for subfolder IDs to avoid repeated API calls
const subfolderCache: Record<string, string> = {};

/**
 * Get or create a subfolder inside a parent folder
 * Returns the subfolder ID
 */
// In-flight promise cache to prevent duplicate folder creation under concurrent requests
const folderCreationPromises: Record<string, Promise<string>> = {};

type PresentationDriveClient = ReturnType<typeof getDriveClient>;
export type DriveWriteInput = { fileId: string; parentId: string; fileName: string; buffer: Buffer;
  digest: string; md5Checksum: string; attemptId: string };
const presentationDriveTimeout = 60_000;
const driveLiteral = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function generatePresentationDriveFileId(drive: PresentationDriveClient = getDriveClient()): Promise<string> {
  const response = await drive.files.generateIds({ count: 1, space: 'drive' }, { timeout: presentationDriveTimeout });
  const id = response.data.ids?.[0];
  if (!id) throw Error('PRESENTATION_DRIVE_ID_MISSING');
  return id;
}
export async function getOrCreatePresentationDriveFolder(parentId: string, name: string, drive: PresentationDriveClient = getDriveClient()): Promise<string> {
  return getOrCreateFolder(parentId, name, drive, true);
}
export async function inspectPresentationDriveFile(fileId: string, drive: PresentationDriveClient = getDriveClient()) {
  const response = await drive.files.get({ fileId, fields: 'id,name,mimeType,size,md5Checksum,parents,appProperties' }, { timeout: presentationDriveTimeout });
  return response.data;
}
export async function writePresentationDriveFile(input: DriveWriteInput, drive: PresentationDriveClient = getDriveClient()) {
  try {
    await drive.files.create({ requestBody: { id: input.fileId, name: input.fileName, mimeType: 'application/pdf', parents: [input.parentId],
      appProperties: { presentationAttemptId: input.attemptId, sha256: input.digest } },
      media: { mimeType: 'application/pdf', body: Readable.from(input.buffer) }, fields: 'id' }, { timeout: presentationDriveTimeout });
  } catch (error) {
    const existing = await inspectPresentationDriveFile(input.fileId, drive).catch(() => null);
    if (!existing) throw Object.assign(Error('PRESENTATION_STORAGE_OUTCOME_UNKNOWN'), { cause: error, storageOutcome: 'unknown' });
  }
  let actual: Awaited<ReturnType<typeof inspectPresentationDriveFile>>;
  try { actual = await inspectPresentationDriveFile(input.fileId, drive); }
  catch (error) { throw Object.assign(Error('PRESENTATION_STORAGE_OUTCOME_UNKNOWN'), { cause: error, storageOutcome: 'unknown' }); }
  if (actual.id !== input.fileId || actual.name !== input.fileName || actual.mimeType !== 'application/pdf' ||
    Number(actual.size) !== input.buffer.length || actual.md5Checksum !== input.md5Checksum || !actual.parents?.includes(input.parentId) ||
    actual.appProperties?.presentationAttemptId !== input.attemptId || actual.appProperties?.sha256 !== input.digest) {
    throw Error('PRESENTATION_DRIVE_FILE_MISMATCH');
  }
  const permissions = await drive.permissions.list({ fileId: input.fileId, fields: 'permissions(type,role)' }, { timeout: presentationDriveTimeout });
  if (!permissions.data.permissions?.some(permission => permission.type === 'anyone' && permission.role === 'reader')) {
    await drive.permissions.create({ fileId: input.fileId, requestBody: { type: 'anyone', role: 'reader' }, fields: 'id' }, { timeout: presentationDriveTimeout });
  }
  return { fileId: input.fileId, fileUrl: `https://drive.google.com/file/d/${input.fileId}/view`, storedFileName: input.fileName };
}

async function getOrCreateFolder(parentFolderId: string, folderName: string, injectedDrive?: PresentationDriveClient, fresh = false): Promise<string> {
  const cacheKey = `${parentFolderId}/${folderName}`;

  // Check resolved cache first
  if (!fresh && subfolderCache[cacheKey]) {
    return subfolderCache[cacheKey];
  }

  // If another request is already creating this folder, reuse that promise
  if (!fresh && Object.prototype.hasOwnProperty.call(folderCreationPromises, cacheKey)) {
    return folderCreationPromises[cacheKey];
  }

  const drive = injectedDrive ?? getDriveClient();

  const promise = (async () => {
    // Search for existing folder
    const searchResponse = await drive.files.list({
      q: `name='${driveLiteral(folderName)}' and '${driveLiteral(parentFolderId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name)",
      spaces: "drive",
      pageSize: 100,
    }, { timeout: presentationDriveTimeout });

    if (searchResponse.data.files && searchResponse.data.files.length > 0) {
      if (fresh && searchResponse.data.files.length > 1) throw Error('PRESENTATION_DRIVE_FOLDER_AMBIGUOUS');
      const folderId = searchResponse.data.files[0].id;
      if (!folderId) throw Error('PRESENTATION_DRIVE_FOLDER_ID_MISSING');
      if (!fresh) subfolderCache[cacheKey] = folderId;
      return folderId;
    }

    // Create new folder if not exists
    const generatedId = fresh ? await generatePresentationDriveFileId(drive) : undefined;
    let newFolderId: string | undefined;
    try {
      const createResponse = await drive.files.create({
      requestBody: {
        ...(generatedId ? { id: generatedId } : {}),
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      },
      fields: "id",
      }, { timeout: presentationDriveTimeout });
      newFolderId = createResponse.data.id ?? undefined;
    } catch (error) {
      if (!generatedId) throw error;
      const existing = await drive.files.get({ fileId: generatedId, fields: 'id,name,mimeType,parents' },
        { timeout: presentationDriveTimeout }).catch(() => null);
      if (existing?.data.id !== generatedId || existing.data.name !== folderName ||
        existing.data.mimeType !== 'application/vnd.google-apps.folder' || !existing.data.parents?.includes(parentFolderId)) throw error;
      newFolderId = generatedId;
    }
    if (!newFolderId) throw Error('PRESENTATION_DRIVE_FOLDER_ID_MISSING');
    if (!fresh) subfolderCache[cacheKey] = newFolderId;
    return newFolderId;
  })();

  if (!fresh) {
    folderCreationPromises[cacheKey] = promise;
    void promise.finally(() => { delete folderCreationPromises[cacheKey]; }).catch(() => undefined);
  }

  return promise;
}

/**
 * Upload a file to Google Drive and return shareable link.
 *
 * Supports two calling styles:
 *   1. Legacy (string params):  uploadToGoogleDrive(buf, name, mime, "student_docs", "subfolder", "nested")
 *   2. Array-based (recommended): uploadToGoogleDrive(buf, name, mime, "abstracts", ["PRIS-2026", "Oral", "Clinical Pharmacy"])
 *
 * @param folderType  - Root folder type (mapped to ENV variable)
 * @param subfolders  - A single string, an array of folder names, or undefined.
 *                      Each element is created inside its parent if it doesn't exist.
 * @param nestedSubfolder - (Legacy) second-level subfolder string
 */
export async function uploadToGoogleDrive(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  folderType: UploadFolderType = "student_docs",
  subfolders?: string | string[],
  nestedSubfolder?: string,
): Promise<string> {
  const drive = getDriveClient();

  const envKey = FOLDER_ENV_MAP[folderType];
  let folderId = process.env[envKey];

  if (!folderId) {
    throw new Error(`${envKey} environment variable not set`);
  }

  // Resolve subfolders — normalise to array
  const folderPath: string[] = [];
  if (Array.isArray(subfolders)) {
    folderPath.push(...subfolders);
  } else if (typeof subfolders === "string") {
    folderPath.push(subfolders);
    if (nestedSubfolder) {
      folderPath.push(nestedSubfolder);
    }
  }

  // Walk down the folder tree, creating any missing folders
  for (const folder of folderPath) {
    folderId = await getOrCreateFolder(folderId, folder);
  }

  // Upload file
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: Readable.from(fileBuffer),
    },
    fields: "id, webViewLink",
  });

  const fileId = response.data.id;

  if (!fileId) {
    throw new Error("Failed to upload file to Google Drive");
  }

  // Set permission to "anyone with link can view"
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  // Return appropriate URL based on file type
  const apiBase = (process.env.API_BASE_URL || "http://localhost:3002").replace(/\/$/, "");
  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");

  if (isImage || isVideo) {
    // Proxy through our API to avoid Google Drive hotlink restrictions
    return `${apiBase}/api/files/${fileId}`;
  } else {
    // For PDFs and other documents, return the view link
    return `https://drive.google.com/file/d/${fileId}/view`;
  }
}

/**
 * Get folder name for abstract category
 */
export function getCategoryFolderName(category: AbstractCategory): string {
  return CATEGORY_FOLDER_NAMES[category] || category;
}

/**
 * Get folder name for presentation type
 */
export function getPresentationTypeFolderName(presentationType: PresentationType): string {
  return PRESENTATION_TYPE_FOLDER_NAMES[presentationType] || presentationType;
}

// ============================================================================
// EVENT MEDIA UPLOAD (per-event folder structure)
// ============================================================================

/**
 * Media type for event uploads — determines subfolder and file naming convention
 */
export type EventMediaType = "thumbnail" | "cover_img" | "cover_vdo" | "venue" | "document";

/**
 * Upload event media to Google Drive with per-event folder structure.
 *
 * Folder structure:
 *   GOOGLE_DRIVE_EVENT_ROOT_FOLDER/
 *     └─ {eventCode}/
 *         ├─ img/      ← thumbnail, cover_img, venue images
 *         └─ vdo/      ← cover_vdo
 *
 * File naming convention:
 *   thumbnail.{eventCode}.{ext}
 *   cover_img_{eventCode}.{ext}
 *   cover_vdo_{eventCode}.{ext}
 *   venue_{sortOrder}_{eventCode}.{ext}
 *   doc_{originalName}
 */
export async function uploadEventMedia(
  fileBuffer: Buffer,
  originalFileName: string,
  mimeType: string,
  eventCode: string,
  eventName: string,
  mediaType: EventMediaType,
  sortOrder?: number,
): Promise<string> {
  const drive = getDriveClient();

  // 1. Get root folder from ENV
  const rootFolderId = process.env.GOOGLE_DRIVE_EVENT_ROOT_FOLDER;
  if (!rootFolderId) {
    throw new Error("GOOGLE_DRIVE_EVENT_ROOT_FOLDER environment variable not set");
  }

  // 2. Get or create event folder: root/{eventCode}
  const eventFolderId = await getOrCreateFolder(rootFolderId, eventCode);

  // 3. Get or create single media subfolder: root/{eventCode}/img&vdo
  const mediaFolderId = await getOrCreateFolder(eventFolderId, "img&vdo");

  // 4. Build file name based on convention (use eventCode for file names)
  const ext = getFileExtension(originalFileName);
  const safeName = sanitizeFileName(eventCode);
  let fileName: string;

  switch (mediaType) {
    case "thumbnail":
      fileName = `thumbnail.${safeName}${ext}`;
      break;
    case "cover_img":
      fileName = `cover_img_${safeName}${ext}`;
      break;
    case "cover_vdo":
      fileName = `cover_vdo_${safeName}${ext}`;
      break;
    case "venue":
      fileName = `venue_${sortOrder ?? 0}_${safeName}${ext}`;
      break;
    case "document":
      fileName = `doc_${originalFileName}`;
      break;
    default:
      fileName = `${Date.now()}_${originalFileName}`;
  }

  // 5. Upload file to Drive
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [mediaFolderId],
    },
    media: {
      mimeType,
      body: Readable.from(fileBuffer),
    },
    fields: "id, webViewLink",
  });

  const fileId = response.data.id;
  if (!fileId) {
    throw new Error("Failed to upload file to Google Drive");
  }

  // 6. Set permission to "anyone with link can view"
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  // 7. Return appropriate URL based on file type
  const apiBase = (process.env.API_BASE_URL || "http://localhost:3002").replace(/\/$/, "");
  const isImage = mimeType.startsWith("image/");
  const isVid = mimeType.startsWith("video/");

  if (isImage || isVid) {
    // Proxy through our API to avoid Google Drive hotlink restrictions
    return `${apiBase}/api/files/${fileId}`;
  } else {
    return `https://drive.google.com/file/d/${fileId}/view`;
  }
}

// ============================================================================
// SPONSOR UPLOADS (per-event folder structure)
// ============================================================================

export type SponsorUploadKind =
  | "organizer_logo"
  | "past_sponsor_logo"
  | "previous_year_impression"
  | "brochure"
  | "other"
  | "payment_slip"
  | "logo";

const SPONSOR_UPLOAD_FOLDER_NAMES: Record<SponsorUploadKind, string[]> = {
  organizer_logo: ["page", "organizer-logo"],
  past_sponsor_logo: ["page", "past-sponsors"],
  previous_year_impression: ["page", "previous-year-impressions"],
  brochure: ["page", "documents"],
  other: ["page", "other"],
  payment_slip: ["applications"],
  logo: ["applications"],
};

export async function uploadSponsorFile(
  fileBuffer: Buffer,
  originalFileName: string,
  mimeType: string,
  eventCode: string,
  uploadKind: SponsorUploadKind,
  options?: { applicationNo?: string; sortOrder?: number },
): Promise<string> {
  const drive = getDriveClient();

  const rootFolderId = process.env.GOOGLE_DRIVE_SPONSOR_ROOT_FOLDER;
  if (!rootFolderId) {
    throw new Error("GOOGLE_DRIVE_SPONSOR_ROOT_FOLDER environment variable not set");
  }

  let folderId = await getOrCreateFolder(rootFolderId, sanitizeFileName(eventCode));
  const basePath = SPONSOR_UPLOAD_FOLDER_NAMES[uploadKind] || SPONSOR_UPLOAD_FOLDER_NAMES.other;
  const folderPath = [...basePath];

  if ((uploadKind === "payment_slip" || uploadKind === "logo") && options?.applicationNo) {
    folderPath.push(sanitizeFileName(options.applicationNo));
    folderPath.push(uploadKind === "payment_slip" ? "payment-slip" : "logo");
  }

  for (const folder of folderPath) {
    folderId = await getOrCreateFolder(folderId, folder);
  }

  const ext = getFileExtension(originalFileName);
  const safeEventCode = sanitizeFileName(eventCode);
  const safeOriginalName = sanitizeFileName(originalFileName.replace(ext, ""));
  const prefix = uploadKind === "logo" ? "sponsor_logo" : uploadKind;
  const orderPart = options?.sortOrder != null ? `_${options.sortOrder}` : "";
  const fileName = `${prefix}${orderPart}_${safeEventCode}_${Date.now()}_${safeOriginalName}${ext}`;

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: Readable.from(fileBuffer),
    },
    fields: "id, webViewLink",
  });

  const fileId = response.data.id;
  if (!fileId) {
    throw new Error("Failed to upload sponsor file to Google Drive");
  }

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  const apiBase = (process.env.API_BASE_URL || "http://localhost:3002").replace(/\/$/, "");
  const isMedia = mimeType.startsWith("image/") || mimeType.startsWith("video/");

  if (isMedia) {
    return `${apiBase}/api/files/${fileId}`;
  }

  return `https://drive.google.com/file/d/${fileId}/view`;
}

/**
 * Sanitize event name for use in file names
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\u0E00-\u0E7F._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100);
}

/**
 * Extract file extension including the dot
 */
function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.substring(lastDot) : '';
}

/**
 * Delete a file from Google Drive by ID
 */
export async function deleteFromGoogleDrive(fileId: string): Promise<void> {
  const drive = getDriveClient();
  await drive.files.delete({ fileId });
}

/**
 * Extract file ID from Google Drive URL (supports multiple formats)
 */
export function extractFileIdFromUrl(url: string): string | null {
  // Format: /d/FILE_ID/
  const dMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (dMatch) return dMatch[1];

  // Format: id=FILE_ID (used in thumbnail and uc links)
  const idMatch = url.match(/id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];

  return null;
}

/**
 * List image files in a Google Drive folder
 * Returns array of { id, name, mimeType }
 */
export async function listFolderFiles(
  folderId: string,
  options?: { imagesOnly?: boolean; pageSize?: number }
): Promise<{ id: string; name: string; mimeType: string }[]> {
  const drive = getDriveClient();
  const imagesOnly = options?.imagesOnly ?? true;
  const pageSize = options?.pageSize ?? 100;

  const mimeFilter = imagesOnly ? " and mimeType contains 'image/'" : " and trashed=false";
  const q = `'${folderId}' in parents${mimeFilter} and trashed=false`;

  const response = await drive.files.list({
    q,
    fields: "files(id, name, mimeType)",
    orderBy: "createdTime",
    pageSize,
  });

  return (response.data.files || []).map((f) => ({
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
  }));
}

/**
 * Get file stream from Google Drive
 */
export async function getFileStream(fileId: string): Promise<{ stream: Readable; mimeType: string }> {
  const drive = getDriveClient();

  // Get file metadata for MIME type
  const metadata = await drive.files.get({
    fileId,
    fields: "mimeType",
  });

  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  return {
    stream: response.data as Readable,
    mimeType: metadata.data.mimeType || "application/octet-stream",
  };
}

