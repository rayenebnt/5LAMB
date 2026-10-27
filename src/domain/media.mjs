// Media library: upload requests (presigned S3 POST forms), retrieval with download URLs,
// alternative text, deletion, and validation of uploaded objects by the media processor.
//
// Upload flow:
//   1. POST /media stores a `pending` item (DynamoDB TTL: 24 h) and returns a presigned POST form
//      whose policy pins the object key, the declared content type and the maximum size.
//   2. The client sends the file directly to S3 (file bytes never transit through Lambda).
//   3. S3 emits "Object Created" to EventBridge -> media processor -> processUploadedObject():
//      declared type, size limit and magic bytes are checked; the media becomes `ready` (download
//      URL exposed) or `rejected` (object deleted, reason kept for a week).

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { dynamo, s3 } from '../lib/aws.mjs';
import { assertAuthenticated, assertCan, can, canActOn, isOwner, PERMISSIONS } from '../lib/auth.mjs';
import { config } from '../lib/config.mjs';
import { INDEXES, indexKeys, isConditionalCheckFailed, keys, queryPage, tableName } from '../lib/db.mjs';
import { forbidden, isAwsError, notFound, payloadTooLarge, unsupportedMediaType } from '../lib/errors.mjs';
import { isUuid, nowIso, ttlFromNow, uuidv7 } from '../lib/ids.mjs';
import { ENTITY, MEDIA_STATUS } from '../lib/schema.mjs';
import { slugify } from '../lib/text.mjs';

export const MEDIA_KIND = Object.freeze({ IMAGE: 'image', VIDEO: 'video' });

/**
 * Accepted content types with their kind and storage extension.
 * SVG is deliberately refused: an SVG file can embed scripts (stored XSS when opened inline).
 */
export const MEDIA_TYPES = Object.freeze({
  'image/jpeg': Object.freeze({ kind: MEDIA_KIND.IMAGE, extension: 'jpg' }),
  'image/png': Object.freeze({ kind: MEDIA_KIND.IMAGE, extension: 'png' }),
  'image/gif': Object.freeze({ kind: MEDIA_KIND.IMAGE, extension: 'gif' }),
  'image/webp': Object.freeze({ kind: MEDIA_KIND.IMAGE, extension: 'webp' }),
  'image/avif': Object.freeze({ kind: MEDIA_KIND.IMAGE, extension: 'avif' }),
  'video/mp4': Object.freeze({ kind: MEDIA_KIND.VIDEO, extension: 'mp4' }),
  'video/webm': Object.freeze({ kind: MEDIA_KIND.VIDEO, extension: 'webm' }),
  'video/quicktime': Object.freeze({ kind: MEDIA_KIND.VIDEO, extension: 'mov' }),
});

export const ALLOWED_CONTENT_TYPES = Object.freeze(Object.keys(MEDIA_TYPES));

/** Results of processUploadedObject (returned and logged by the media processor). */
export const PROCESSING_OUTCOME = Object.freeze({
  READY: 'ready', // pending media validated
  REJECTED: 'rejected', // invalid object deleted, media marked as rejected
  UNCHANGED: 'unchanged', // ready media whose object is still valid (e.g. duplicate event)
  ORPHAN_DELETED: 'orphan_deleted', // object without a matching media item, deleted
  STRAY_DELETED: 'stray_deleted', // object uploaded again for a rejected media, deleted
  OBJECT_MISSING: 'object_missing', // object deleted in the meantime: nothing to validate
  SKIPPED: 'skipped', // status changed concurrently (conditional update failed)
  IGNORED: 'ignored', // malformed event or event of another bucket
});

const PENDING_TTL_SECONDS = 24 * 60 * 60; // abandoned uploads are removed after one day
const REJECTED_TTL_SECONDS = 7 * 24 * 60 * 60; // rejection reasons stay visible for a week
const SIGNATURE_RANGE = 'bytes=0-31'; // the first 32 bytes hold every supported signature
const ALL_MEDIA_PARTITION = 'MEDIA'; // GSI1 partition of every media item (indexKeys.mediaAll)
const OWNER_MEDIA_PREFIX = 'MEDIA#'; // GSI2 sort key prefix of media in a user partition
const MEBIBYTE = 1024 * 1024;

const formatMegabytes = (bytes) => `${Number((bytes / MEBIBYTE).toFixed(1))} MB`;

// ---------------------------------------------------------------------------
// Content types, file names and object keys
// ---------------------------------------------------------------------------

/** Canonical form of a MIME type: " Image/PNG; charset=x" -> "image/png". */
export function normalizeContentType(value) {
  return String(value ?? '').split(';')[0].trim().toLowerCase();
}

/** `{ kind, extension }` of an accepted (canonical) content type, or null when refused. */
export function mediaTypeOf(contentType) {
  return Object.hasOwn(MEDIA_TYPES, contentType) ? MEDIA_TYPES[contentType] : null;
}

/** Maximum size in bytes of a media kind (MAX_IMAGE_MB / MAX_VIDEO_MB). */
export function maxBytesFor(kind) {
  return kind === MEDIA_KIND.VIDEO ? config.maxVideoBytes : config.maxImageBytes;
}

/**
 * File name stored in S3: slug of the client file name without directories and extension,
 * followed by the extension of the declared content type (never the client's own, so
 * "evil.html" declared as image/png is stored as "evil.png").
 * Example: "C:\\photos\\Mon Schéma.PNG" + "png" -> "mon-schema.png".
 */
export function sanitizeFilename(filename, extension) {
  const basename = String(filename ?? '').split(/[\\/]/).pop();
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return `${slugify(stem) || 'file'}.${extension}`;
}

/** S3 key of a media object: media/<mediaId>/<filename>. */
export function mediaObjectKey(mediaId, filename) {
  return `media/${mediaId}/${filename}`;
}

/** Media id of an object key shaped like "media/<mediaId>/<file>", or null for any other key. */
export function parseMediaKey(key) {
  const match = /^media\/([^/]+)\/./.exec(String(key ?? ''));
  return match && isUuid(match[1]) ? match[1] : null;
}

/**
 * Object keys of S3 event notifications may be URL-encoded ("+" for spaces).
 * A key that is not valid percent-encoding is returned unchanged.
 */
export function decodeS3Key(key) {
  const raw = String(key ?? '');
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// File signatures ("magic bytes")
// ---------------------------------------------------------------------------

const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []));
const ascii = (buffer, start, end) => buffer.toString('latin1', start, end);
const startsWith = (buffer, signature) => signature.every((byte, index) => buffer[index] === byte);
/** Brand of an ISO base media file ("....ftyp<brand>": MP4, QuickTime, AVIF/HEIF), else null. */
const isoBrand = (buffer) => (ascii(buffer, 4, 8) === 'ftyp' ? ascii(buffer, 8, 12) : null);

const AVIF_BRANDS = new Set(['avif', 'avis', 'mif1']);
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free']);

/**
 * Signature test of each accepted content type. Detection returns the first match, so the
 * specific ISO-BMFF brands (AVIF, QuickTime) are listed before the generic MP4 rule (any brand).
 */
const SIGNATURES = Object.freeze({
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': (b) => ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6)),
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/avif': (b) => AVIF_BRANDS.has(isoBrand(b)),
  'video/quicktime': (b) => isoBrand(b) === 'qt  ' || QUICKTIME_ATOMS.has(ascii(b, 4, 8)),
  'video/mp4': (b) => isoBrand(b) !== null,
  'video/webm': (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]), // EBML header
});

/**
 * Identifies the format of a file from its first bytes.
 * @param {Uint8Array|Buffer|number[]} bytes beginning of the file (32 bytes are enough)
 * @returns {string|null} most specific accepted content type whose signature matches, or null
 *   (unknown or refused format such as SVG, HTML or PDF)
 */
export function detectSignature(bytes) {
  const buffer = toBuffer(bytes);
  const match = Object.entries(SIGNATURES).find(([, test]) => test(buffer));
  return match ? match[0] : null;
}

/**
 * True when the first bytes of a file are valid for the declared content type. Unlike
 * detectSignature, every compatible format counts (an MP4 may use any ISO-BMFF brand).
 */
export function matchesSignature(bytes, contentType) {
  return Object.hasOwn(SIGNATURES, contentType) && SIGNATURES[contentType](toBuffer(bytes));
}

/**
 * Checks an uploaded object against its media item: content type equal to the declared one,
 * size within the limit of the kind, and magic bytes of the declared format.
 * @param {object} item media item
 * @param {{ contentType?: string, size: number, bytes: Uint8Array }} object HeadObject data + first bytes
 * @returns {string|null} rejection reason (shown to the owner), or null when the object is valid
 */
export function uploadRejectionReason(item, { contentType, size, bytes }) {
  const actualType = normalizeContentType(contentType);
  if (actualType !== item.contentType) {
    return `Content type '${actualType || 'unknown'}' does not match the declared type '${item.contentType}'`;
  }
  const maxBytes = maxBytesFor(item.kind);
  if (size > maxBytes) {
    return `File size (${size} bytes) exceeds the ${formatMegabytes(maxBytes)} limit for ${item.kind} files`;
  }
  if (!matchesSignature(bytes, item.contentType)) {
    const detected = detectSignature(bytes) ?? 'unknown format';
    return `File content is not a valid ${item.contentType} file (detected: ${detected})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Representation and access rules
// ---------------------------------------------------------------------------

/**
 * Download URL of a media: null unless ready; a CloudFront URL when MEDIA_CDN_DOMAIN is set,
 * otherwise a presigned S3 GET URL valid DOWNLOAD_URL_TTL_SECONDS (returned with its expiry).
 * @returns {Promise<{ url: string|null, urlExpiresAt?: string }>}
 */
export async function mediaUrl(item) {
  if (item.status !== MEDIA_STATUS.READY) return { url: null };
  const cdnDomain = config.mediaCdnDomain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (cdnDomain) {
    const path = item.s3Key.split('/').map(encodeURIComponent).join('/');
    return { url: `https://${cdnDomain}/${path}` };
  }
  const expiresIn = config.downloadUrlTtlSeconds;
  const urlExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const command = new GetObjectCommand({ Bucket: config.mediaBucket, Key: item.s3Key });
  return { url: await getSignedUrl(s3(), command, { expiresIn }), urlExpiresAt };
}

/** API representation of a media item (keys, s3Key, TTL and other internals are never exposed). */
export function toApiMedia(item, { url = null, urlExpiresAt } = {}) {
  return {
    id: item.mediaId,
    filename: item.filename,
    contentType: item.contentType,
    kind: item.kind,
    size: item.size,
    status: item.status,
    altText: item.altText ?? null,
    url,
    ...(urlExpiresAt ? { urlExpiresAt } : {}),
    owner: { id: item.ownerId, name: item.ownerName },
    ...(item.status === MEDIA_STATUS.REJECTED ? { rejectionReason: item.rejectionReason ?? null } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** API representation with the download URL resolved. */
export async function presentMedia(item) {
  return toApiMedia(item, await mediaUrl(item));
}

/** Ready media are public; pending and rejected ones are visible to their owner and to MEDIA_READ_ANY. */
export function canViewMedia(identity, item) {
  if (!item) return false;
  if (item.status === MEDIA_STATUS.READY) return true;
  return isOwner(identity, item.ownerId) || can(identity, PERMISSIONS.MEDIA_READ_ANY);
}

/** Editing and deletion: the owner (still allowed to upload) or MEDIA_DELETE_ANY. */
export function canManageMedia(identity, item) {
  return canActOn(identity, item.ownerId, PERMISSIONS.MEDIA_UPLOAD, PERMISSIONS.MEDIA_DELETE_ANY);
}

// ---------------------------------------------------------------------------
// API use cases
// ---------------------------------------------------------------------------

/** Reads a media item (null when it does not exist). */
export async function getMediaItem(mediaId, { consistent = false } = {}) {
  const { Item } = await dynamo().send(
    new GetCommand({ TableName: tableName(), Key: keys.media(mediaId), ConsistentRead: consistent }),
  );
  return Item ?? null;
}

/** Presigned POST form for the direct upload of the object of a pending media. */
async function createUploadForm(item) {
  const expiresIn = config.uploadUrlTtlSeconds;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const { url, fields } = await createPresignedPost(s3(), {
    Bucket: config.mediaBucket,
    Key: item.s3Key,
    Conditions: [
      ['content-length-range', 1, item.size],
      ['eq', '$Content-Type', item.contentType],
    ],
    Fields: { 'Content-Type': item.contentType },
    Expires: expiresIn,
  });
  return { method: 'POST', url, fields, expiresAt };
}

/**
 * Registers a pending media and creates its presigned POST upload form (POST /media).
 * The form policy pins the key, the content type and the maximum size, so S3 itself refuses
 * any other upload; the media processor then validates the stored object.
 * @param {object} identity caller (needs MEDIA_UPLOAD)
 * @param {{ filename: string, contentType: string, size: number, altText?: string|null }} input
 * @returns {Promise<{ item: object, upload: { method: 'POST', url: string, fields: object, expiresAt: string } }>}
 * @throws {AppError} 403, 415 UNSUPPORTED_MEDIA_TYPE, 413 PAYLOAD_TOO_LARGE
 */
export async function createMediaUpload(identity, { filename, contentType, size, altText }) {
  assertCan(identity, PERMISSIONS.MEDIA_UPLOAD, 'You are not allowed to upload media');
  const declaredType = normalizeContentType(contentType);
  const type = mediaTypeOf(declaredType);
  if (!type) {
    throw unsupportedMediaType(
      `Unsupported content type '${declaredType}' (accepted: ${ALLOWED_CONTENT_TYPES.join(', ')})`,
    );
  }
  const maxBytes = maxBytesFor(type.kind);
  if (size > maxBytes) {
    throw payloadTooLarge(
      `The maximum size of ${type.kind} files is ${formatMegabytes(maxBytes)} (${maxBytes} bytes)`,
    );
  }

  const mediaId = uuidv7();
  const now = nowIso();
  const storedFilename = sanitizeFilename(filename, type.extension);
  const item = {
    ...keys.media(mediaId),
    ...indexKeys.mediaAll(now, mediaId),
    ...indexKeys.mediaByOwner(identity.userId, now, mediaId),
    entityType: ENTITY.MEDIA,
    mediaId,
    ownerId: identity.userId,
    ownerName: identity.name,
    filename: storedFilename,
    contentType: declaredType,
    kind: type.kind,
    size,
    status: MEDIA_STATUS.PENDING,
    s3Key: mediaObjectKey(mediaId, storedFilename),
    altText: altText || null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlFromNow(PENDING_TTL_SECONDS),
  };
  await dynamo().send(
    new PutCommand({ TableName: tableName(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }),
  );
  return { item, upload: await createUploadForm(item) };
}

/**
 * Lists media items, newest first (GET /media). Without MEDIA_READ_ANY a caller only lists
 * their own media (`owner` absent, "me" or their own id; another owner -> 403). With it:
 * every media (GSI1) or the media of `owner` (GSI2).
 * @returns {Promise<{ items: object[], nextCursor: string|null }>}
 */
export async function listMedia(identity, { owner, limit, cursor }) {
  assertAuthenticated(identity);
  const readAny = can(identity, PERMISSIONS.MEDIA_READ_ANY);
  const ownerId = owner === undefined || owner === 'me' ? identity.userId : owner;
  if (!readAny && ownerId !== identity.userId) throw forbidden('You can only list your own media');

  if (readAny && owner === undefined) {
    return queryPage({
      indexName: INDEXES.GSI1,
      keyCondition: 'GSI1PK = :pk',
      values: { ':pk': ALL_MEDIA_PARTITION },
      limit,
      cursor,
      forward: false,
    });
  }
  return queryPage({
    indexName: INDEXES.GSI2,
    keyCondition: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
    values: { ':pk': `USER#${ownerId}`, ':prefix': OWNER_MEDIA_PREFIX },
    limit,
    cursor,
    forward: false,
  });
}

/** Media visible to the caller (GET /media/{mediaId}); unknown or invisible media -> 404. */
export async function getVisibleMedia(identity, mediaId, { consistent = false } = {}) {
  const item = await getMediaItem(mediaId, { consistent });
  if (!canViewMedia(identity, item)) throw notFound('Media not found');
  return item;
}

/** Media the caller may edit or delete: 404 when invisible to them, 403 when not allowed. */
async function getManageableMedia(identity, mediaId) {
  const item = await getVisibleMedia(identity, mediaId, { consistent: true });
  if (!canManageMedia(identity, item)) {
    throw forbidden('Only the owner of a media or an editor can modify it');
  }
  return item;
}

/**
 * Sets the alternative text of a media; null or an empty string clears it (PATCH /media/{mediaId}).
 * @returns {Promise<object>} updated media item
 */
export async function updateMediaAltText(identity, mediaId, altText) {
  await getManageableMedia(identity, mediaId);
  try {
    const { Attributes } = await dynamo().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: keys.media(mediaId),
        UpdateExpression: 'SET altText = :altText, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':altText': altText || null, ':now': nowIso() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes;
  } catch (err) {
    if (isConditionalCheckFailed(err)) throw notFound('Media not found'); // deleted meanwhile
    throw err;
  }
}

/** Deletes the S3 object, then the media item (DELETE /media/{mediaId}). */
export async function deleteMedia(identity, mediaId) {
  const item = await getManageableMedia(identity, mediaId);
  await deleteObject(config.mediaBucket, item.s3Key);
  await dynamo().send(new DeleteCommand({ TableName: tableName(), Key: keys.media(mediaId) }));
}

// ---------------------------------------------------------------------------
// Media processor (S3 "Object Created" events)
// ---------------------------------------------------------------------------

async function deleteObject(bucket, key) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Content type and size (HeadObject) and first bytes (ranged GetObject) of an object,
 * or null when the object no longer exists.
 */
async function inspectObject(bucket, key) {
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const size = head.ContentLength ?? 0;
    let bytes = new Uint8Array(0);
    if (size > 0) {
      // IfMatch: the bytes must belong to the object described by HeadObject (no swap in between).
      const object = await s3().send(
        new GetObjectCommand({ Bucket: bucket, Key: key, Range: SIGNATURE_RANGE, IfMatch: head.ETag }),
      );
      bytes = (await object.Body?.transformToByteArray()) ?? bytes;
    }
    return { contentType: head.ContentType, size, bytes };
  } catch (err) {
    if (isAwsError(err, 'NotFound', 'NoSuchKey')) return null;
    throw err;
  }
}

/** Conditional update of a media item; false when the condition failed (concurrent change). */
async function updateMediaIf(mediaId, update) {
  try {
    await dynamo().send(new UpdateCommand({ TableName: tableName(), Key: keys.media(mediaId), ...update }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

function markReady(mediaId, size) {
  return updateMediaIf(mediaId, {
    UpdateExpression: 'SET #status = :ready, #size = :size, updatedAt = :now REMOVE expiresAt',
    ConditionExpression: '#status = :pending',
    ExpressionAttributeNames: { '#status': 'status', '#size': 'size' },
    ExpressionAttributeValues: {
      ':ready': MEDIA_STATUS.READY,
      ':pending': MEDIA_STATUS.PENDING,
      ':size': size,
      ':now': nowIso(),
    },
  });
}

function markRejected(mediaId, reason) {
  return updateMediaIf(mediaId, {
    UpdateExpression:
      'SET #status = :rejected, rejectionReason = :reason, updatedAt = :now, expiresAt = :expiresAt',
    ConditionExpression: '#status IN (:pending, :ready)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':rejected': MEDIA_STATUS.REJECTED,
      ':pending': MEDIA_STATUS.PENDING,
      ':ready': MEDIA_STATUS.READY,
      ':reason': reason,
      ':now': nowIso(),
      ':expiresAt': ttlFromNow(REJECTED_TTL_SECONDS),
    },
  });
}

function updateReadySize(mediaId, size) {
  return updateMediaIf(mediaId, {
    UpdateExpression: 'SET #size = :size, updatedAt = :now',
    ConditionExpression: '#status = :ready',
    ExpressionAttributeNames: { '#status': 'status', '#size': 'size' },
    ExpressionAttributeValues: { ':ready': MEDIA_STATUS.READY, ':size': size, ':now': nowIso() },
  });
}

/**
 * Validates an object stored in the media bucket (S3 "Object Created" event):
 * - no media item for the key (never requested, deleted, foreign key) -> the orphan is deleted;
 * - pending media -> HeadObject + first 32 bytes; valid (declared content type, size limit of
 *   the kind, magic bytes) -> `ready` with the real size; invalid -> object deleted, `rejected`;
 * - other statuses: duplicate events change nothing (idempotent). As the upload form stays
 *   usable until it expires, an object can be replaced after validation, so a ready media is
 *   checked again (rejected if its new content is invalid) and a rejected media keeps no object.
 * S3 "not found" (object deleted meanwhile) and lost conditional updates are not errors; any
 * other error is rethrown so that EventBridge retries the event (then sends it to the DLQ).
 * @param {{ bucket: string, key: string }} object bucket and decoded object key
 * @returns {Promise<{ outcome: string, mediaId?: string, reason?: string }>} see PROCESSING_OUTCOME
 */
export async function processUploadedObject({ bucket, key }) {
  const mediaId = parseMediaKey(key);
  const item = mediaId ? await getMediaItem(mediaId, { consistent: true }) : null;
  if (!item || item.s3Key !== key) {
    await deleteObject(bucket, key);
    return { outcome: PROCESSING_OUTCOME.ORPHAN_DELETED };
  }
  if (item.status === MEDIA_STATUS.REJECTED) {
    await deleteObject(bucket, key);
    return { outcome: PROCESSING_OUTCOME.STRAY_DELETED, mediaId };
  }

  const object = await inspectObject(bucket, key);
  if (!object) return { outcome: PROCESSING_OUTCOME.OBJECT_MISSING, mediaId };

  const reason = uploadRejectionReason(item, object);
  if (reason) {
    await deleteObject(bucket, key);
    const rejected = await markRejected(mediaId, reason);
    return { outcome: rejected ? PROCESSING_OUTCOME.REJECTED : PROCESSING_OUTCOME.SKIPPED, mediaId, reason };
  }
  if (item.status === MEDIA_STATUS.PENDING) {
    const ready = await markReady(mediaId, object.size);
    return { outcome: ready ? PROCESSING_OUTCOME.READY : PROCESSING_OUTCOME.SKIPPED, mediaId };
  }
  // Already ready: duplicate event, or the object was replaced by another valid file.
  if (object.size !== item.size) await updateReadySize(mediaId, object.size);
  return { outcome: PROCESSING_OUTCOME.UNCHANGED, mediaId };
}
