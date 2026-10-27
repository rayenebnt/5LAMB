// Comments API: public reading and posting of comments, moderation by editors and administrators.
// Business rules live in src/domain/comments.mjs; this module validates input and maps responses.

import { can, PERMISSIONS } from '../../lib/auth.mjs';
import { cacheHeaders, created, createApiHandler, noContent, ok } from '../../lib/http.mjs';
import { COMMENT_STATUS } from '../../lib/schema.mjs';
import { schemas, validate, z } from '../../lib/validation.mjs';
import {
  ALL_STATUSES,
  createComment,
  deleteComment,
  listModerationQueue,
  listPostComments,
  moderateComment,
  MODERATION_STATUSES,
  toApiComment,
} from '../../domain/comments.mjs';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const postParamsSchema = z.strictObject({ postId: schemas.uuid });
const commentParamsSchema = z.strictObject({ postId: schemas.uuid, commentId: schemas.uuid });

const listQuerySchema = z.strictObject({
  status: z.enum([...Object.values(COMMENT_STATUS), ALL_STATUSES]).default(COMMENT_STATUS.APPROVED),
  limit: schemas.limit(100, 20),
  cursor: schemas.cursor,
});

const queueQuerySchema = z.strictObject({
  status: z.enum(Object.values(COMMENT_STATUS)).default(COMMENT_STATUS.PENDING),
  limit: schemas.limit(100, 20),
  cursor: schemas.cursor,
});

const moderationSchema = z.strictObject({ status: z.enum(MODERATION_STATUSES) });

/** HTML forms send empty strings for optional fields left blank: treat them as absent. */
const blankToUndefined = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const commentFields = {
  body: z
    .string()
    .trim()
    .min(1, 'Comment must not be empty')
    .max(2000, 'Comment must not exceed 2000 characters'),
  parentId: z.preprocess(blankToUndefined, schemas.uuid.nullable().optional()),
  // Honeypot: hidden form field that humans leave empty (see initialStatus in the domain).
  website: z.string().nullable().optional(),
};

/** Anonymous readers sign their comment; the e-mail address is optional and never published. */
const anonymousCommentSchema = z.strictObject({
  ...commentFields,
  authorName: z
    .string({ error: (issue) => (issue.input === undefined ? 'authorName is required for anonymous comments' : undefined) })
    .trim()
    .min(1, 'authorName must not be empty')
    .max(80, 'authorName must not exceed 80 characters'),
  authorEmail: z.preprocess(blankToUndefined, schemas.email.optional()),
});

/** Signed-in users: name and e-mail come from the token, values sent in the body are ignored. */
const memberCommentSchema = z.strictObject({
  ...commentFields,
  authorName: z.unknown().optional(),
  authorEmail: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const toPage = (page, moderator) => ({
  items: page.items.map((item) => toApiComment(item, { moderator })),
  nextCursor: page.nextCursor,
});

/** GET /posts/{postId}/comments - approved comments (any status for moderators), oldest first. */
async function listForPost(req) {
  const { postId } = validate(postParamsSchema, req.params);
  const query = validate(listQuerySchema, req.query);
  const page = await listPostComments(req.identity, postId, query);
  const moderator = can(req.identity, PERMISSIONS.COMMENT_MODERATE);
  return ok(toPage(page, moderator), cacheHeaders(req.identity));
}

/** POST /posts/{postId}/comments - anonymous or signed-in comment, optionally replying to another. */
async function create(req) {
  const { postId } = validate(postParamsSchema, req.params);
  const input = validate(req.identity ? memberCommentSchema : anonymousCommentSchema, req.body);
  const item = await createComment(req.identity, postId, input);
  // Honeypot hits are stored as spam but answered exactly like a comment awaiting moderation.
  const shown = item.status === COMMENT_STATUS.SPAM ? { ...item, status: COMMENT_STATUS.PENDING } : item;
  return created(toApiComment(shown), `/posts/${postId}/comments/${item.commentId}`);
}

/** PATCH /posts/{postId}/comments/{commentId} - moderation (approve, reject, mark as spam). */
async function moderate(req) {
  const { postId, commentId } = validate(commentParamsSchema, req.params);
  const { status } = validate(moderationSchema, req.body);
  const item = await moderateComment(req.identity, postId, commentId, status);
  return ok(toApiComment(item, { moderator: true }));
}

/** DELETE /posts/{postId}/comments/{commentId} - by a moderator or the author of the comment. */
async function remove(req) {
  const { postId, commentId } = validate(commentParamsSchema, req.params);
  await deleteComment(req.identity, postId, commentId);
  return noContent();
}

/** GET /comments - moderation queue across every post (pending comments by default). */
async function moderationQueue(req) {
  const query = validate(queueQuerySchema, req.query);
  const page = await listModerationQueue(req.identity, query);
  return ok(toPage(page, true), cacheHeaders(req.identity));
}

export const routes = {
  'GET /posts/{postId}/comments': { auth: 'optional', handler: listForPost },
  'POST /posts/{postId}/comments': { auth: 'optional', handler: create },
  'PATCH /posts/{postId}/comments/{commentId}': { auth: 'required', handler: moderate },
  'DELETE /posts/{postId}/comments/{commentId}': { auth: 'required', handler: remove },
  'GET /comments': { auth: 'required', handler: moderationQueue },
};

export const handler = createApiHandler(routes);
