// Posts: input contracts, API representation, editorial workflow and DynamoDB access.
//
// Post item: PK POST#<postId> / SK POST, plus two index entries
//   GSI1 POSTS#<status> / <publishedAt (published) or updatedAt (other statuses)>#<postId>
//   GSI2 USER#<authorId> / POST#<createdAt>#<postId>
// Slug uniqueness relies on a SLUG#<slug> item written in the same transaction as the post.
// Every modification made here increments `version` (optimistic locking, ETag "v<version>").
// `commentCount` belongs to the comments domain (atomic ADD) and is never rewritten here:
// updates only SET the attributes they change.

import { randomBytes } from 'node:crypto';
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo } from '../lib/aws.mjs';
import { assertCan, can, canActOn, PERMISSIONS } from '../lib/auth.mjs';
import {
  cancellationReasons,
  indexKeys,
  INDEXES,
  isConditionalCheckFailed,
  keys,
  queryPage,
  tableName,
} from '../lib/db.mjs';
import {
  conflict,
  forbidden,
  notFound,
  preconditionFailed,
  unauthorized,
  validationError,
} from '../lib/errors.mjs';
import { isUuid, nowIso, uuidv7 } from '../lib/ids.mjs';
import { ENTITY, POST_STATUS } from '../lib/schema.mjs';
import {
  makeExcerpt,
  normalizeTag,
  normalizeTags,
  readingTimeMinutes,
  SLUG_RE,
  slugify,
} from '../lib/text.mjs';
import { schemas, z } from '../lib/validation.mjs';
import { canViewPost, getPostIdBySlug, getPostItem } from './post-access.mjs';

const { DRAFT, IN_REVIEW, PUBLISHED, ARCHIVED } = POST_STATUS;

export const SLUG_MAX_LENGTH = 80;

/** Statuses in which authors without POST_UPDATE_ANY / POST_DELETE_ANY may still change their post. */
const AUTHOR_EDITABLE_STATUSES = new Set([DRAFT, IN_REVIEW]);

/** Editorial workflow: allowed source statuses and target status of each action. */
export const WORKFLOW = Object.freeze({
  submit: Object.freeze({ from: [DRAFT], to: IN_REVIEW }),
  publish: Object.freeze({ from: [DRAFT, IN_REVIEW, ARCHIVED], to: PUBLISHED }),
  unpublish: Object.freeze({ from: [PUBLISHED], to: DRAFT }),
  reject: Object.freeze({ from: [IN_REVIEW], to: DRAFT }),
  archive: Object.freeze({ from: [DRAFT, IN_REVIEW, PUBLISHED], to: ARCHIVED }),
});

// ---------------------------------------------------------------------------
// Input contracts (strict objects: unknown fields are rejected with 400)
// ---------------------------------------------------------------------------

const titleSchema = z.string().trim().min(1, 'Title is required').max(200);
const contentSchema = z.string().max(100_000); // Markdown, kept verbatim (not trimmed)
const excerptSchema = z.string().trim().max(500).nullable(); // null or '' = automatic excerpt
const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((tag) => normalizeTag(tag) !== '', 'Tag must contain at least one letter or digit');
const tagsSchema = z
  .array(tagSchema)
  .max(10, 'At most 10 tags are allowed')
  .transform((tags) => normalizeTags(tags));
const slugSchema = z
  .string()
  .trim()
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_RE, 'Slug must only contain lowercase letters, digits and single hyphens')
  // GET /posts/{postId} treats UUIDs as post ids: a UUID-shaped slug could never be resolved.
  .refine((slug) => !isUuid(slug), 'Slug must not be a UUID');
const coverImageUrlSchema = schemas.httpsUrl.nullable();

/** Body of POST /posts. `status`, `authorId`… are not accepted (unknown fields). */
export const createPostSchema = z.strictObject({
  title: titleSchema,
  content: contentSchema.default(''),
  excerpt: excerptSchema.optional(),
  tags: tagsSchema.optional(),
  slug: slugSchema.optional(),
  coverImageUrl: coverImageUrlSchema.optional(),
  allowComments: z.boolean().optional(),
});

/** Body of PATCH /posts/{postId}: same fields, all optional, at least one. */
export const updatePostSchema = z
  .strictObject({
    title: titleSchema.optional(),
    content: contentSchema.optional(),
    excerpt: excerptSchema.optional(),
    tags: tagsSchema.optional(),
    slug: slugSchema.optional(),
    coverImageUrl: coverImageUrlSchema.optional(),
    allowComments: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one field must be provided');

/** Path parameters of the write routes (slugs are only resolved by GET /posts/{postId}). */
export const postIdParamsSchema = z.object({
  postId: schemas.uuid.transform((id) => id.toLowerCase()),
});

/** Query string of GET /posts. */
export const listPostsQuerySchema = z.strictObject({
  limit: schemas.limit(50, 10),
  cursor: schemas.cursor,
  status: z.enum(Object.values(POST_STATUS)).default(PUBLISHED),
  tag: tagSchema.transform((tag) => normalizeTag(tag)).optional(),
  author: z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => value === 'me' || isUuid(value), 'Must be "me" or a user id (UUID)')
    .optional(),
});

const rejectBodySchema = z.strictObject({ note: z.string().trim().max(1000).nullable().optional() });
const emptyBodySchema = z.strictObject({});

/** Body schema of a workflow action: only `reject` accepts a field (`note`). */
export function transitionBodySchema(action) {
  return action === 'reject' ? rejectBodySchema : emptyBodySchema;
}

// ---------------------------------------------------------------------------
// API representation
// ---------------------------------------------------------------------------

/**
 * API representation of a post (base item, GSI projection or tag membership copy).
 * `content` is only included in single-resource responses; internal attributes never leak.
 */
export function toApiPost(item, { includeContent = false } = {}) {
  return {
    id: item.postId,
    slug: item.slug,
    title: item.title,
    excerpt: item.excerpt ?? '',
    ...(includeContent ? { content: item.content ?? '' } : {}),
    coverImageUrl: item.coverImageUrl ?? null,
    tags: item.tags ?? [],
    status: item.status,
    allowComments: item.allowComments !== false,
    author: { id: item.authorId, name: item.authorName },
    readingTimeMinutes: item.readingTimeMinutes ?? 1,
    commentCount: item.commentCount ?? 0,
    reviewNote: item.reviewNote ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    submittedAt: item.submittedAt ?? null,
    publishedAt: item.publishedAt ?? null,
    version: item.version,
  };
}

// ---------------------------------------------------------------------------
// Pure business rules
// ---------------------------------------------------------------------------

const NUMBERED_SLUG_SUFFIXES = [2, 3, 4, 5];
const RANDOM_SLUG_ATTEMPTS = 3;

const randomHex = () => randomBytes(3).toString('hex');

/** Appends a suffix, shortening the base so that the slug stays within SLUG_MAX_LENGTH. */
function withSuffix(base, suffix) {
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/**
 * Candidate slugs for a title, in order: "<base>", "<base>-2" … "<base>-5", then
 * "<base>-<6 random hex chars>" (a few attempts). `base` is slugify(title), or "post" when empty.
 * @param {string} title
 * @param {() => string} [random] generator of the random suffix (tests)
 */
export function* autoSlugCandidates(title, random = randomHex) {
  let base = slugify(title, SLUG_MAX_LENGTH) || 'post';
  if (isUuid(base)) base = `post-${base}`; // see slugSchema: UUIDs are reserved for post ids
  yield base;
  for (const n of NUMBERED_SLUG_SUFFIXES) yield withSuffix(base, `-${n}`);
  for (let i = 0; i < RANDOM_SLUG_ATTEMPTS; i += 1) yield withSuffix(base, `-${random()}`);
}

/**
 * New draft item from a validated creation input.
 * @param {{ postId: string, slug: string, input: object, author: { userId: string, name: string }, now: string }} params
 */
export function buildPostItem({ postId, slug, input, author, now }) {
  const content = input.content ?? '';
  const customExcerpt = Boolean(input.excerpt);
  return {
    ...keys.post(postId),
    ...indexKeys.postByStatus(DRAFT, now, postId),
    ...indexKeys.postByAuthor(author.userId, now, postId),
    entityType: ENTITY.POST,
    postId,
    slug,
    title: input.title,
    content,
    excerpt: customExcerpt ? input.excerpt : makeExcerpt(content),
    customExcerpt,
    coverImageUrl: input.coverImageUrl ?? null,
    tags: input.tags ?? [],
    status: DRAFT,
    allowComments: input.allowComments ?? true,
    authorId: author.userId,
    authorName: author.name,
    readingTimeMinutes: readingTimeMinutes(content),
    commentCount: 0,
    reviewNote: null,
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    publishedAt: null,
    version: 1,
  };
}

const PATCHABLE_FIELDS = ['title', 'content', 'tags', 'coverImageUrl', 'allowComments'];

/**
 * Attributes to SET for a validated PATCH: the provided fields, the slug when it changes,
 * derived attributes (excerpt unless custom, reading time), updatedAt, version and, for
 * non-published posts, GSI1SK (those listings are sorted by updatedAt).
 */
export function computePostChanges(post, patch, now) {
  const changes = {};
  for (const field of PATCHABLE_FIELDS) {
    if (patch[field] !== undefined) changes[field] = patch[field];
  }
  if (patch.slug !== undefined && patch.slug !== post.slug) changes.slug = patch.slug;

  const content = changes.content ?? post.content ?? '';
  if (patch.excerpt) {
    Object.assign(changes, { excerpt: patch.excerpt, customExcerpt: true });
  } else if (patch.excerpt !== undefined) {
    // null or '': back to the automatic excerpt.
    Object.assign(changes, { excerpt: makeExcerpt(content), customExcerpt: false });
  } else if (!post.customExcerpt) {
    changes.excerpt = makeExcerpt(content);
  }
  changes.readingTimeMinutes = readingTimeMinutes(content);
  changes.updatedAt = now;
  changes.version = post.version + 1;
  if (post.status !== PUBLISHED) {
    changes.GSI1SK = indexKeys.postByStatus(post.status, now, post.postId).GSI1SK;
  }
  return changes;
}

/** True when the caller may perform a workflow action on a post it can see. */
export function canTransition(identity, post, action) {
  if (action === 'submit') {
    return canActOn(identity, post.authorId, PERMISSIONS.POST_SUBMIT, PERMISSIONS.POST_UPDATE_ANY);
  }
  return can(identity, PERMISSIONS.POST_PUBLISH);
}

/**
 * Attributes to SET for an allowed workflow action: status, GSI1 keys (published posts are
 * sorted by publishedAt, the others by updatedAt), timestamps, review note and version.
 */
export function transitionChanges(post, action, { note = null, now }) {
  const status = WORKFLOW[action].to;
  const changes = { status, updatedAt: now, version: post.version + 1 };
  if (action === 'submit') changes.submittedAt = now;
  if (action === 'publish') {
    changes.publishedAt = post.publishedAt ?? now; // the first publication date is kept
    changes.reviewNote = null;
  }
  if (action === 'reject') changes.reviewNote = note || null;
  const sortDate = status === PUBLISHED ? changes.publishedAt : now;
  return { ...changes, ...indexKeys.postByStatus(status, sortDate, post.postId) };
}

const byStatus = (status) => ({
  indexName: INDEXES.GSI1,
  keyCondition: 'GSI1PK = :pk',
  values: { ':pk': `POSTS#${status}` },
});

const byTag = (tag, authorId) => ({
  indexName: INDEXES.GSI1,
  keyCondition: 'GSI1PK = :pk',
  values: authorId ? { ':pk': `TAG#${tag}`, ':authorId': authorId } : { ':pk': `TAG#${tag}` },
  filter: authorId ? 'authorId = :authorId' : undefined,
});

const byAuthor = (authorId, status) => ({
  indexName: INDEXES.GSI2,
  keyCondition: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
  names: { '#status': 'status' },
  values: { ':pk': `USER#${authorId}`, ':prefix': 'POST#', ':status': status },
  filter: '#status = :status',
});

/**
 * Chooses the index query serving GET /posts (see the listing matrix of the specification):
 * published posts are public (by status, tag or author); other statuses require a token and
 * are limited to the caller's own posts unless the caller has POST_READ_ANY.
 * @returns {object} queryPage options (without limit, cursor and direction)
 */
export function planPostListing(identity, { status = PUBLISHED, tag, author } = {}) {
  if (author === 'me' && !identity) throw unauthorized('Authentication is required to list your own posts');
  const authorId = author === 'me' ? identity.userId : author;

  if (status === PUBLISHED) {
    if (tag) return byTag(tag, authorId);
    return authorId ? byAuthor(authorId, status) : byStatus(status);
  }

  if (!identity) throw unauthorized(`Authentication is required to list posts whose status is '${status}'`);
  if (tag) {
    throw validationError([{ field: 'tag', message: 'The tag filter is only available for published posts' }]);
  }
  if (can(identity, PERMISSIONS.POST_READ_ANY)) {
    return authorId ? byAuthor(authorId, status) : byStatus(status);
  }
  if (authorId && authorId !== identity.userId) {
    throw forbidden('You can only list your own unpublished posts');
  }
  return byAuthor(identity.userId, status);
}

// ---------------------------------------------------------------------------
// DynamoDB operations
// ---------------------------------------------------------------------------

/** Internal signal: a conditional write lost a race against another modification of the post. */
class VersionConflict extends Error {
  constructor() {
    super('The post version changed during the operation');
    this.name = 'VersionConflict';
  }
}

const MAX_WRITE_ATTEMPTS = 2; // a lost race is retried once when the client sent no If-Match

/**
 * Runs a read-check-write operation under optimistic locking. A version conflict is
 * reported as 412 when the client sent If-Match (its version is stale), otherwise the whole
 * operation is retried once and then reported as 409 CONFLICT.
 */
async function withOptimisticLock(ifMatch, operation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      if (ifMatch !== undefined) throw preconditionFailed();
      if (attempt >= MAX_WRITE_ATTEMPTS) {
        throw conflict('The post was modified by another request, please retry', 'CONFLICT');
      }
    }
  }
}

/** Errors caused by concurrent transactions on the same items become 409 (retryable by the client). */
function concurrencyError(err) {
  if (err?.name === 'TransactionConflictException' || cancellationReasons(err).includes('TransactionConflict')) {
    return conflict('The post is being modified by another request, please retry', 'CONFLICT');
  }
  return err;
}

const slugTaken = (slug) => conflict(`The slug '${slug}' is already used by another post`, 'SLUG_TAKEN');

/** Transaction item reserving a slug for a post. */
const reserveSlug = (slug, postId) => ({
  Put: {
    TableName: tableName(),
    Item: { ...keys.slug(slug), entityType: ENTITY.SLUG, slug, postId },
    ConditionExpression: 'attribute_not_exists(PK)',
  },
});

/** Transaction item releasing a slug; never deletes a slug owned by another post. */
const releaseSlug = (slug, postId) => ({
  Delete: {
    TableName: tableName(),
    Key: keys.slug(slug),
    ConditionExpression: 'attribute_not_exists(PK) OR postId = :postId',
    ExpressionAttributeValues: { ':postId': postId },
  },
});

/** UpdateItem parameters: SET of `changes` only, conditioned on the version that was read. */
function buildUpdate(postId, changes, expectedVersion) {
  const names = { '#version': 'version' };
  const values = { ':expectedVersion': expectedVersion };
  const assignments = Object.entries(changes).map(([attribute, value]) => {
    names[`#${attribute}`] = attribute;
    values[`:${attribute}`] = value;
    return `#${attribute} = :${attribute}`;
  });
  return {
    TableName: tableName(),
    Key: keys.post(postId),
    UpdateExpression: `SET ${assignments.join(', ')}`,
    ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/** Conditional UpdateItem returning the whole updated item. */
async function updatePostItem(post, changes) {
  try {
    const { Attributes } = await dynamo().send(
      new UpdateCommand({ ...buildUpdate(post.postId, changes, post.version), ReturnValues: 'ALL_NEW' }),
    );
    return Attributes;
  } catch (err) {
    if (isConditionalCheckFailed(err)) throw new VersionConflict();
    throw concurrencyError(err);
  }
}

/** Slug change: release the old slug, reserve the new one and update the post atomically. */
async function updatePostItemWithNewSlug(post, changes) {
  try {
    await dynamo().send(
      new TransactWriteCommand({
        TransactItems: [
          releaseSlug(post.slug, post.postId),
          reserveSlug(changes.slug, post.postId),
          { Update: buildUpdate(post.postId, changes, post.version) },
        ],
      }),
    );
  } catch (err) {
    const [oldSlug, newSlug, postUpdate] = cancellationReasons(err);
    // The old slug can only belong to another post if this post's slug changed meanwhile.
    if (postUpdate === 'ConditionalCheckFailed' || oldSlug === 'ConditionalCheckFailed') {
      throw new VersionConflict();
    }
    if (newSlug === 'ConditionalCheckFailed') throw slugTaken(changes.slug);
    throw concurrencyError(err);
  }
  // TransactWriteItems returns no attributes: the result is the read item plus the changes.
  return { ...post, ...changes };
}

/** Consistent read of a post the caller can see; invisible and unknown posts are 404. */
async function readPostForWrite(identity, postId) {
  const post = await getPostItem(postId, { consistent: true });
  if (!canViewPost(identity, post)) throw notFound('Post not found');
  return post;
}

/** Ownership and status rules shared by PATCH and DELETE. */
function assertCanModify(identity, post, { own, any, verb }) {
  if (!canActOn(identity, post.authorId, own, any)) throw forbidden(`You can only ${verb} your own posts`);
  if (!can(identity, any) && !AUTHOR_EDITABLE_STATUSES.has(post.status)) {
    throw forbidden(`Only editors can ${verb} a post whose status is '${post.status}'`);
  }
}

function assertVersion(post, ifMatch) {
  if (ifMatch !== undefined && ifMatch !== post.version) throw preconditionFailed();
}

/**
 * Creates a draft owned by the caller: one transaction puts the post and reserves its slug.
 * A custom slug already in use is a 409 SLUG_TAKEN; an automatic slug moves to the next candidate.
 * @param {object} identity caller (POST_CREATE required)
 * @param {object} input validated createPostSchema output
 * @returns {Promise<object>} the stored item
 */
export async function createPost(identity, input) {
  assertCan(identity, PERMISSIONS.POST_CREATE);
  const postId = uuidv7();
  const now = nowIso();
  const candidates = input.slug ? [input.slug] : autoSlugCandidates(input.title);

  for (const slug of candidates) {
    const item = buildPostItem({ postId, slug, input, author: identity, now });
    try {
      await dynamo().send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: tableName(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
            reserveSlug(slug, postId),
          ],
        }),
      );
      return item;
    } catch (err) {
      if (cancellationReasons(err)[1] !== 'ConditionalCheckFailed') throw concurrencyError(err);
      if (input.slug) throw slugTaken(input.slug);
      // The automatic slug is already used: try the next candidate.
    }
  }
  throw conflict('Could not generate a unique slug, please provide one', 'SLUG_TAKEN');
}

/** A path segment is either a post id (UUID) or a slug; anything else cannot match a post. */
async function resolvePostId(idOrSlug) {
  const value = String(idOrSlug ?? '');
  if (isUuid(value)) return value.toLowerCase();
  if (value.length > SLUG_MAX_LENGTH || !SLUG_RE.test(value)) return null;
  return getPostIdBySlug(value);
}

/**
 * Reads a post by id or slug. Posts the caller may not see (drafts of other authors…) are 404.
 * @returns {Promise<object>} the post item
 */
export async function getVisiblePost(identity, idOrSlug) {
  const postId = await resolvePostId(idOrSlug);
  const post = postId ? await getPostItem(postId) : null;
  if (!canViewPost(identity, post)) throw notFound('Post not found');
  return post;
}

/**
 * One page of posts (newest first) for GET /posts. Index items only carry the summary
 * attributes (never `content`).
 * @returns {Promise<{ items: object[], nextCursor: string|null }>}
 */
export async function listPosts(identity, { limit, cursor, status, tag, author }) {
  const plan = planPostListing(identity, { status, tag, author });
  return queryPage({ ...plan, limit, cursor, forward: false });
}

/**
 * Partial update (PATCH) under optimistic locking (optional If-Match version).
 * @returns {Promise<object>} the updated item
 */
export async function updatePost(identity, postId, patch, { ifMatch } = {}) {
  return withOptimisticLock(ifMatch, async () => {
    const post = await readPostForWrite(identity, postId);
    assertCanModify(identity, post, {
      own: PERMISSIONS.POST_UPDATE_OWN,
      any: PERMISSIONS.POST_UPDATE_ANY,
      verb: 'edit',
    });
    assertVersion(post, ifMatch);
    const changes = computePostChanges(post, patch, nowIso());
    return changes.slug ? updatePostItemWithNewSlug(post, changes) : updatePostItem(post, changes);
  });
}

/**
 * Deletes a post and releases its slug in one transaction. Comments, tag memberships and
 * search terms are removed asynchronously by the projector (stream REMOVE event).
 */
export async function deletePost(identity, postId, { ifMatch } = {}) {
  await withOptimisticLock(ifMatch, async () => {
    const post = await readPostForWrite(identity, postId);
    assertCanModify(identity, post, {
      own: PERMISSIONS.POST_DELETE_OWN,
      any: PERMISSIONS.POST_DELETE_ANY,
      verb: 'delete',
    });
    assertVersion(post, ifMatch);
    try {
      await dynamo().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: tableName(),
                Key: keys.post(post.postId),
                // The version condition also guarantees that the checks above still hold.
                ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':expectedVersion': post.version },
              },
            },
            releaseSlug(post.slug, post.postId),
          ],
        }),
      );
    } catch (err) {
      if (cancellationReasons(err).includes('ConditionalCheckFailed')) throw new VersionConflict();
      throw concurrencyError(err);
    }
  });
}

/**
 * Applies a workflow action (submit, publish, unpublish, reject, archive).
 * Errors: 404 invisible post, 403 missing permission, 412 stale If-Match,
 * 409 INVALID_STATE_TRANSITION when the current status does not allow the action.
 * @returns {Promise<object>} the updated item
 */
export async function transitionPost(identity, postId, action, { note, ifMatch } = {}) {
  const rule = WORKFLOW[action];
  if (!rule) throw new Error(`Unknown workflow action '${action}'`);
  return withOptimisticLock(ifMatch, async () => {
    const post = await readPostForWrite(identity, postId);
    if (!canTransition(identity, post, action)) {
      throw forbidden(
        action === 'submit' ? 'Only the author or an editor can submit this post' : `Only editors can ${action} posts`,
      );
    }
    assertVersion(post, ifMatch);
    if (!rule.from.includes(post.status)) {
      throw conflict(`Cannot ${action} a post whose status is '${post.status}'`, 'INVALID_STATE_TRANSITION');
    }
    return updatePostItem(post, transitionChanges(post, action, { note, now: nowIso() }));
  });
}
