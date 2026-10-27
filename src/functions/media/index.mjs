// Media library API: presigned uploads to S3, listing, retrieval, alternative text and deletion.
// Business rules live in src/domain/media.mjs; this module validates input and maps responses.
// File bytes never transit through Lambda: clients upload them to S3 with a presigned POST form,
// then the media processor validates the object (see src/functions/media-processor).

import { cacheHeaders, created, createApiHandler, noContent, ok } from '../../lib/http.mjs';
import { isUuid } from '../../lib/ids.mjs';
import { MEDIA_STATUS } from '../../lib/schema.mjs';
import { schemas, validate, z } from '../../lib/validation.mjs';
import {
  createMediaUpload,
  deleteMedia,
  getVisibleMedia,
  listMedia,
  presentMedia,
  updateMediaAltText,
} from '../../domain/media.mjs';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const mediaParamsSchema = z.strictObject({ mediaId: schemas.uuid });

/** Alternative text for screen readers; null (or blank) means "no alternative text". */
const altTextSchema = z.string().trim().max(300, 'altText must not exceed 300 characters').nullable();

const uploadSchema = z.strictObject({
  filename: z
    .string()
    .trim()
    .min(1, 'filename must not be empty')
    .max(200, 'filename must not exceed 200 characters'),
  // Checked against the accepted types by the domain: unsupported types are 415, not 400.
  contentType: z.string().trim().min(1, 'contentType must not be empty').max(100),
  size: z.number().int('size must be an integer number of bytes').min(1, 'size must be at least 1 byte'),
  altText: altTextSchema.optional(),
});

const updateSchema = z.strictObject({ altText: altTextSchema });

const listQuerySchema = z.strictObject({
  limit: schemas.limit(100, 20),
  cursor: schemas.cursor,
  owner: z
    .string()
    .trim()
    .refine((value) => value === 'me' || isUuid(value), "owner must be 'me' or a user id")
    .optional(),
});

const NO_STORE = { 'Cache-Control': 'private, no-store' };

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** POST /media - registers a pending media and returns a presigned S3 POST upload form. */
async function requestUpload(req) {
  const input = validate(uploadSchema, req.body);
  const { item, upload } = await createMediaUpload(req.identity, input);
  return created({ ...(await presentMedia(item)), upload }, `/media/${item.mediaId}`);
}

/** GET /media - own media (any media for editors and administrators), newest first. */
async function list(req) {
  const query = validate(listQuerySchema, req.query);
  const page = await listMedia(req.identity, query);
  const items = await Promise.all(page.items.map((item) => presentMedia(item)));
  return ok({ items, nextCursor: page.nextCursor }, cacheHeaders(req.identity));
}

/** GET /media/{mediaId} - ready media are public; pending/rejected ones for owner and editors. */
async function getOne(req) {
  const { mediaId } = validate(mediaParamsSchema, req.params);
  const item = await getVisibleMedia(req.identity, mediaId);
  const headers = item.status === MEDIA_STATUS.READY ? cacheHeaders(req.identity) : NO_STORE;
  return ok(await presentMedia(item), headers);
}

/** PATCH /media/{mediaId} - sets or clears the alternative text. */
async function update(req) {
  const { mediaId } = validate(mediaParamsSchema, req.params);
  const { altText } = validate(updateSchema, req.body);
  const item = await updateMediaAltText(req.identity, mediaId, altText);
  return ok(await presentMedia(item));
}

/** DELETE /media/{mediaId} - deletes the S3 object, then the media item. */
async function remove(req) {
  const { mediaId } = validate(mediaParamsSchema, req.params);
  await deleteMedia(req.identity, mediaId);
  return noContent();
}

export const routes = {
  'POST /media': { auth: 'required', handler: requestUpload },
  'GET /media': { auth: 'required', handler: list },
  'GET /media/{mediaId}': { auth: 'optional', handler: getOne },
  'PATCH /media/{mediaId}': { auth: 'required', handler: update },
  'DELETE /media/{mediaId}': { auth: 'required', handler: remove },
};

export const handler = createApiHandler(routes);
