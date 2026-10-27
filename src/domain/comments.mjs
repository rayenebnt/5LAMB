// Comments: reader comments (threaded replies), honeypot anti-spam, moderation workflow and the
// denormalised `commentCount` of posts.
//
//   Item   PK = POST#<postId>      SK = COMMENT#<commentId>  (uuidv7: a post's comments sort chronologically)
//   GSI1   GSI1PK = COMMENTS#<status>  GSI1SK = <createdAt>#<commentId>  (moderation queue, oldest first)
//
// Invariant: post.commentCount is the number of APPROVED comments of the post. Every write that makes
// a comment enter or leave the approved status updates the counter in the same DynamoDB transaction,
// conditioned on the comment status that was read, so concurrent requests can neither lose nor
// double-count a comment.

import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo } from '../lib/aws.mjs';
import { assertCan, can, isOwner, PERMISSIONS } from '../lib/auth.mjs';
import {
  cancellationReasons,
  indexKeys,
  INDEXES,
  isTransactionCanceled,
  keys,
  queryPage,
  tableName,
} from '../lib/db.mjs';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.mjs';
import { nowIso, uuidv7 } from '../lib/ids.mjs';
import { logger } from '../lib/logger.mjs';
import { COMMENT_STATUS, ENTITY, POST_STATUS } from '../lib/schema.mjs';
import { canViewPost, getPostItem } from './post-access.mjs';

/** Pseudo-status of GET /posts/{postId}/comments that returns the comments of every status. */
export const ALL_STATUSES = 'all';

/** Statuses a moderator can assign with PATCH /posts/{postId}/comments/{commentId}. */
export const MODERATION_STATUSES = Object.freeze([
  COMMENT_STATUS.APPROVED,
  COMMENT_STATUS.REJECTED,
  COMMENT_STATUS.SPAM,
]);

const COMMENT_SK_PREFIX = 'COMMENT#';
const CONDITION_FAILED = 'ConditionalCheckFailed';
const TRANSACTION_CONFLICT = 'TransactionConflict';
const MAX_TRANSACTION_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * API representation of a comment item. The public form never exposes the author's e-mail
 * address nor moderation data; moderators (COMMENT_MODERATE) get the full form.
 * @param {object} item comment item (base table or GSI1 projection)
 * @param {{ moderator?: boolean }} [options]
 */
export function toApiComment(item, { moderator = false } = {}) {
  const comment = {
    id: item.commentId,
    postId: item.postId,
    parentId: item.parentId ?? null,
    body: item.body,
    author: { id: item.authorId ?? null, name: item.authorName },
    status: item.status,
    createdAt: item.createdAt,
  };
  if (!moderator) return comment;
  return {
    ...comment,
    authorEmail: item.authorEmail ?? null,
    postTitle: item.postTitle ?? null,
    moderatedBy: item.moderatedBy ?? null,
    moderatedAt: item.moderatedAt ?? null,
    updatedAt: item.updatedAt,
  };
}

/**
 * Status of a new comment: a filled honeypot field means spam; comments of users holding a role
 * are approved immediately; the others (anonymous readers, users without role) await moderation.
 * @param {object|null} identity
 * @param {string|null|undefined} honeypot value of the hidden `website` form field
 */
export function initialStatus(identity, honeypot) {
  if (typeof honeypot === 'string' && honeypot.trim() !== '') return COMMENT_STATUS.SPAM;
  return identity && identity.roles.length > 0 ? COMMENT_STATUS.APPROVED : COMMENT_STATUS.PENDING;
}

/**
 * Change of the post's commentCount when a comment goes from status `from` to status `to`
 * (`null` = the comment does not exist): +1 when it becomes approved, -1 when it stops being approved.
 */
export function commentCountDelta(from, to) {
  const wasApproved = from === COMMENT_STATUS.APPROVED;
  const isApproved = to === COMMENT_STATUS.APPROVED;
  if (wasApproved === isApproved) return 0;
  return isApproved ? 1 : -1;
}

// ---------------------------------------------------------------------------
// DynamoDB access
// ---------------------------------------------------------------------------

/** Reads a comment item (null when it does not exist). */
export async function getCommentItem(postId, commentId, { consistent = false } = {}) {
  const { Item } = await dynamo().send(
    new GetCommand({
      TableName: tableName(),
      Key: keys.comment(postId, commentId),
      ConsistentRead: consistent,
    }),
  );
  return Item ?? null;
}

function isTransactionConflict(err) {
  const reasons = cancellationReasons(err);
  return (
    isTransactionCanceled(err) &&
    reasons.includes(TRANSACTION_CONFLICT) &&
    !reasons.includes(CONDITION_FAILED)
  );
}

/**
 * TransactWriteItems, retried a few times when DynamoDB cancels it only because another
 * transaction was writing one of the same items (typically the counter of a busy post).
 * A cancelled transaction writes nothing, so retrying is safe.
 */
async function transactWrite(transactItems) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await dynamo().send(new TransactWriteCommand({ TransactItems: transactItems }));
      return;
    } catch (err) {
      if (!isTransactionConflict(err)) throw err;
      if (attempt >= MAX_TRANSACTION_ATTEMPTS) {
        throw conflict('Too many concurrent updates of this post, please retry');
      }
      await sleep(attempt * 25 + Math.floor(Math.random() * 25));
    }
  }
}

/** Transaction item adding `delta` to the post's commentCount, only if the post still exists. */
function commentCountUpdate(postId, delta) {
  return {
    Update: {
      TableName: tableName(),
      Key: keys.post(postId),
      UpdateExpression: 'ADD commentCount :delta',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':delta': delta },
    },
  };
}

/**
 * Applies a conditional comment write (Put / Update / Delete transaction item) together with the
 * post counter update when `delta` is not 0, in a single transaction.
 * Throws 409 when the comment condition fails (concurrent change). Returns false, without having
 * written anything, when the post no longer exists; true on success.
 */
async function writeComment(commentWrite, postId, delta) {
  const transactItems = delta === 0 ? [commentWrite] : [commentWrite, commentCountUpdate(postId, delta)];
  try {
    await transactWrite(transactItems);
    return true;
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    const [commentReason, postReason] = cancellationReasons(err);
    if (commentReason === CONDITION_FAILED) {
      throw conflict('The comment was changed by a concurrent request, please retry');
    }
    if (postReason === CONDITION_FAILED) return false;
    throw err;
  }
}

async function assertApprovedParent(postId, parentId) {
  const parent = await getCommentItem(postId, parentId, { consistent: true });
  if (parent?.status !== COMMENT_STATUS.APPROVED) {
    throw new AppError(400, 'INVALID_PARENT', 'parentId must reference an approved comment of the same post');
  }
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

/**
 * Lists the comments of a post visible to the caller, oldest first.
 * Statuses other than 'approved' ('pending', 'rejected', 'spam', 'all') are reserved to moderators.
 * @param {object|null} identity
 * @param {string} postId
 * @param {{ status?: string, limit: number, cursor?: string }} options
 * @returns {Promise<{ items: object[], nextCursor: string|null }>} comment items
 */
export async function listPostComments(identity, postId, { status = COMMENT_STATUS.APPROVED, limit, cursor }) {
  if (status !== COMMENT_STATUS.APPROVED) {
    assertCan(identity, PERMISSIONS.COMMENT_MODERATE, 'Only moderators can list comments that are not approved');
  }
  const post = await getPostItem(postId);
  if (!canViewPost(identity, post)) throw notFound('Post not found');

  const filtered = status !== ALL_STATUSES;
  return queryPage({
    keyCondition: 'PK = :pk AND begins_with(SK, :prefix)',
    values: {
      ':pk': keys.post(postId).PK,
      ':prefix': COMMENT_SK_PREFIX,
      ...(filtered ? { ':status': status } : {}),
    },
    names: filtered ? { '#status': 'status' } : undefined,
    filter: filtered ? '#status = :status' : undefined,
    limit,
    cursor,
    forward: true,
  });
}

/**
 * Adds a comment to a published post that accepts comments.
 * Signed-in users sign with their identity; anonymous readers provide `authorName` (+ optional
 * `authorEmail`). An approved comment and the counter increment are written atomically.
 * @param {object|null} identity
 * @param {string} postId
 * @param {{ body: string, authorName?: string, authorEmail?: string, parentId?: string|null, website?: string|null }} input
 *   validated input (`authorName` is required when `identity` is null)
 * @returns {Promise<object>} the stored comment item (status 'spam' when the honeypot was filled)
 */
export async function createComment(identity, postId, input) {
  const post = await getPostItem(postId, { consistent: true });
  if (post?.status !== POST_STATUS.PUBLISHED) throw notFound('Post not found');
  if (post.allowComments === false) {
    throw new AppError(403, 'COMMENTS_DISABLED', 'Comments are disabled for this post');
  }
  const parentId = input.parentId ?? null;
  if (parentId) await assertApprovedParent(postId, parentId);

  const status = initialStatus(identity, input.website);
  const commentId = uuidv7();
  const now = nowIso();
  const item = {
    ...keys.comment(postId, commentId),
    ...indexKeys.commentByStatus(status, now, commentId),
    entityType: ENTITY.COMMENT,
    commentId,
    postId,
    postTitle: post.title,
    parentId,
    body: input.body,
    authorId: identity?.userId ?? null,
    authorName: identity ? identity.name : input.authorName,
    authorEmail: (identity ? identity.email : input.authorEmail) ?? null,
    status,
    createdAt: now,
    updatedAt: now,
    moderatedBy: null,
    moderatedAt: null,
  };
  const put = { TableName: tableName(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' };

  if (status === COMMENT_STATUS.APPROVED) {
    const written = await writeComment({ Put: put }, postId, commentCountDelta(null, status));
    if (!written) throw notFound('Post not found');
  } else {
    await dynamo().send(new PutCommand(put));
  }
  if (status === COMMENT_STATUS.SPAM) {
    logger.warn('Comment classified as spam (honeypot field filled)', { postId, commentId });
  }
  return item;
}

/**
 * Sets the moderation status of a comment (moderators only). Re-applying the current status is a
 * no-op. Fails with 409 when the comment status changed concurrently.
 * @param {object|null} identity
 * @param {string} postId
 * @param {string} commentId
 * @param {'approved'|'rejected'|'spam'} status
 * @returns {Promise<object>} the comment item after moderation
 */
export async function moderateComment(identity, postId, commentId, status) {
  assertCan(identity, PERMISSIONS.COMMENT_MODERATE, 'Only moderators can moderate comments');
  const comment = await getCommentItem(postId, commentId, { consistent: true });
  if (!comment) throw notFound('Comment not found');
  if (comment.status === status) return comment;

  const now = nowIso();
  // Only the queue partition moves: GSI1SK (<createdAt>#<commentId>) stays unchanged.
  const { GSI1PK } = indexKeys.commentByStatus(status, comment.createdAt, comment.commentId);
  const update = {
    Update: {
      TableName: tableName(),
      Key: keys.comment(postId, commentId),
      UpdateExpression:
        'SET #status = :status, GSI1PK = :queue, moderatedBy = :moderator, moderatedAt = :now, updatedAt = :now',
      ConditionExpression: '#status = :current',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':queue': GSI1PK,
        ':moderator': identity.userId,
        ':now': now,
        ':current': comment.status,
      },
    },
  };
  const written = await writeComment(update, postId, commentCountDelta(comment.status, status));
  if (!written) throw notFound('Post not found');

  logger.info('Comment moderated', {
    postId,
    commentId,
    from: comment.status,
    to: status,
    moderatorId: identity.userId,
  });
  return { ...comment, status, GSI1PK, moderatedBy: identity.userId, moderatedAt: now, updatedAt: now };
}

/**
 * Deletes a comment. Allowed to moderators and to the signed-in author of the comment; the post's
 * commentCount is decremented in the same transaction when the comment was approved.
 * @param {object|null} identity
 * @param {string} postId
 * @param {string} commentId
 */
export async function deleteComment(identity, postId, commentId) {
  const comment = await getCommentItem(postId, commentId, { consistent: true });
  if (!comment) throw notFound('Comment not found');
  if (!can(identity, PERMISSIONS.COMMENT_MODERATE) && !isOwner(identity, comment.authorId)) {
    // Comments that are not approved are invisible to other users: do not reveal that they exist.
    if (comment.status !== COMMENT_STATUS.APPROVED) throw notFound('Comment not found');
    throw forbidden('Only moderators and the author of a comment can delete it');
  }

  const remove = {
    Delete: {
      TableName: tableName(),
      Key: keys.comment(postId, commentId),
      // The status read above decides the counter update: it must still be the current one.
      ConditionExpression: 'attribute_exists(PK) AND #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': comment.status },
    },
  };
  const written = await writeComment(remove, postId, commentCountDelta(comment.status, null));
  if (!written) {
    // The post has been deleted meanwhile (the projector purges its comments): delete the comment alone.
    await writeComment(remove, postId, 0);
  }
  logger.info('Comment deleted', { postId, commentId, status: comment.status, by: identity?.userId });
}

/**
 * Moderation queue: comments of every post having `status`, oldest first (GSI1 COMMENTS#<status>).
 * @param {object|null} identity
 * @param {{ status?: string, limit: number, cursor?: string }} options
 * @returns {Promise<{ items: object[], nextCursor: string|null }>} comment items (GSI1 projection)
 */
export async function listModerationQueue(identity, { status = COMMENT_STATUS.PENDING, limit, cursor }) {
  assertCan(identity, PERMISSIONS.COMMENT_MODERATE, 'Only moderators can access the moderation queue');
  return queryPage({
    indexName: INDEXES.GSI1,
    keyCondition: 'GSI1PK = :queue',
    values: { ':queue': `COMMENTS#${status}` },
    limit,
    cursor,
    forward: true,
  });
}
