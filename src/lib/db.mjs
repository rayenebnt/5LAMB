// DynamoDB single-table helpers: key builders, opaque pagination cursors, batch helpers.
//
// Table "blogify-<stage>" — primary key (PK, SK) + 2 overloaded GSIs:
//   GSI1 (GSI1PK, GSI1SK): listings by status / tag / moderation queue / all media
//   GSI2 (GSI2PK, GSI2SK): listings by owner (posts and media of a user)
// See docs/ARCHITECTURE.md for the full access-pattern table.

import {
  BatchGetCommand,
  BatchWriteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamo } from './aws.mjs';
import { config } from './config.mjs';
import { badRequest } from './errors.mjs';

export const INDEXES = Object.freeze({ GSI1: 'GSI1', GSI2: 'GSI2' });

/** Attributes forming a LastEvaluatedKey for the base table or an index. */
function keyNamesFor(indexName) {
  if (indexName === INDEXES.GSI1) return ['PK', 'SK', 'GSI1PK', 'GSI1SK'];
  if (indexName === INDEXES.GSI2) return ['PK', 'SK', 'GSI2PK', 'GSI2SK'];
  return ['PK', 'SK'];
}

export function tableName() {
  return config.tableName;
}

/** Primary keys of every entity stored in the table. */
export const keys = {
  post: (postId) => ({ PK: `POST#${postId}`, SK: 'POST' }),
  slug: (slug) => ({ PK: `SLUG#${slug}`, SK: 'SLUG' }),
  comment: (postId, commentId) => ({ PK: `POST#${postId}`, SK: `COMMENT#${commentId}` }),
  notification: (postId) => ({ PK: `POST#${postId}`, SK: 'NOTIFICATION' }),
  media: (mediaId) => ({ PK: `MEDIA#${mediaId}`, SK: 'MEDIA' }),
  profile: (userId) => ({ PK: `USER#${userId}`, SK: 'PROFILE' }),
  tagPost: (tag, postId) => ({ PK: `TAG#${tag}`, SK: `POST#${postId}` }),
  tagCounter: (tag) => ({ PK: 'TAGS', SK: `TAG#${tag}` }),
  term: (term, postId) => ({ PK: `TERM#${term}`, SK: `POST#${postId}` }),
};

/** Secondary index attributes (GSI1/GSI2) for each listing access pattern. */
export const indexKeys = {
  /** GSI1: posts by status, newest first (published: publishedAt, others: updatedAt). */
  postByStatus: (status, sortDate, postId) => ({
    GSI1PK: `POSTS#${status}`,
    GSI1SK: `${sortDate}#${postId}`,
  }),
  /** GSI2: posts of an author, by creation date. */
  postByAuthor: (authorId, createdAt, postId) => ({
    GSI2PK: `USER#${authorId}`,
    GSI2SK: `POST#${createdAt}#${postId}`,
  }),
  /** GSI1: published posts having a tag, by publication date (tag membership items). */
  postByTag: (tag, publishedAt, postId) => ({
    GSI1PK: `TAG#${tag}`,
    GSI1SK: `${publishedAt}#${postId}`,
  }),
  /** GSI1: moderation queue (comments by status). */
  commentByStatus: (status, createdAt, commentId) => ({
    GSI1PK: `COMMENTS#${status}`,
    GSI1SK: `${createdAt}#${commentId}`,
  }),
  /** GSI1: every media item, newest first. */
  mediaAll: (createdAt, mediaId) => ({ GSI1PK: 'MEDIA', GSI1SK: `${createdAt}#${mediaId}` }),
  /** GSI2: media uploaded by a user. */
  mediaByOwner: (ownerId, createdAt, mediaId) => ({
    GSI2PK: `USER#${ownerId}`,
    GSI2SK: `MEDIA#${createdAt}#${mediaId}`,
  }),
};

const INTERNAL_ATTRIBUTES = new Set([
  'PK',
  'SK',
  'GSI1PK',
  'GSI1SK',
  'GSI2PK',
  'GSI2SK',
  'entityType',
  'expiresAt',
]);

/** Returns a copy of an item without key / technical attributes. */
export function stripInternal(item) {
  if (!item) return item;
  return Object.fromEntries(Object.entries(item).filter(([key]) => !INTERNAL_ATTRIBUTES.has(key)));
}

// ---------------------------------------------------------------------------
// Pagination cursors: base64url(JSON(LastEvaluatedKey)) — opaque for clients.
// ---------------------------------------------------------------------------

export function encodeCursor(lastEvaluatedKey) {
  if (!lastEvaluatedKey) return null;
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

export function decodeCursor(cursor, indexName) {
  if (cursor === undefined || cursor === null || cursor === '') return undefined;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
  const expected = keyNamesFor(indexName);
  const valid =
    decoded &&
    typeof decoded === 'object' &&
    !Array.isArray(decoded) &&
    Object.keys(decoded).length === expected.length &&
    expected.every((name) => typeof decoded[name] === 'string' && decoded[name].length > 0);
  if (!valid) throw badRequest('Invalid pagination cursor');
  return decoded;
}

function cursorFromItem(item, indexName) {
  const names = keyNamesFor(indexName);
  return Object.fromEntries(names.map((name) => [name, item[name]]));
}

/**
 * Runs a Query and returns one page of results: `{ items, nextCursor }`.
 *
 * When a FilterExpression is used, DynamoDB applies `Limit` before filtering, so this helper
 * keeps querying (bounded by `maxRounds`) until the page is full or the partition is exhausted,
 * and builds the next cursor from the last returned item.
 *
 * @param {object} options
 * @param {string} [options.indexName] 'GSI1' | 'GSI2' | undefined (base table)
 * @param {string} options.keyCondition KeyConditionExpression
 * @param {Record<string, unknown>} options.values ExpressionAttributeValues
 * @param {Record<string, string>} [options.names] ExpressionAttributeNames
 * @param {string} [options.filter] FilterExpression
 * @param {string} [options.projection] ProjectionExpression (must include the key attributes)
 * @param {number} options.limit page size
 * @param {string} [options.cursor] opaque cursor from a previous page
 * @param {boolean} [options.forward=true] ScanIndexForward
 * @param {boolean} [options.consistentRead=false] only allowed on the base table
 * @param {number} [options.maxRounds=10]
 */
export async function queryPage({
  indexName,
  keyCondition,
  values,
  names,
  filter,
  projection,
  limit,
  cursor,
  forward = true,
  consistentRead = false,
  maxRounds = 10,
}) {
  const items = [];
  let exclusiveStartKey = decodeCursor(cursor, indexName);
  let rounds = 0;
  let lastEvaluatedKey;

  do {
    const remaining = limit - items.length;
    const pageLimit = filter ? Math.min(Math.max(remaining * 3, 25), 200) : remaining;
    let response;
    try {
      response = await dynamo().send(
        new QueryCommand({
          TableName: tableName(),
          IndexName: indexName,
          KeyConditionExpression: keyCondition,
          ExpressionAttributeValues: values,
          ExpressionAttributeNames: names,
          FilterExpression: filter,
          ProjectionExpression: projection,
          ScanIndexForward: forward,
          ConsistentRead: indexName ? undefined : consistentRead || undefined,
          Limit: pageLimit,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
    } catch (err) {
      if (err?.name === 'ValidationException' && exclusiveStartKey) {
        throw badRequest('Invalid pagination cursor');
      }
      throw err;
    }
    const pageItems = response.Items ?? [];
    lastEvaluatedKey = response.LastEvaluatedKey;
    rounds += 1;

    if (items.length + pageItems.length > limit) {
      // More matching items than requested: keep `limit` and resume after the last kept one.
      const kept = pageItems.slice(0, limit - items.length);
      items.push(...kept);
      return { items, nextCursor: encodeCursor(cursorFromItem(kept[kept.length - 1], indexName)) };
    }
    items.push(...pageItems);
    exclusiveStartKey = lastEvaluatedKey;
  } while (items.length < limit && lastEvaluatedKey && rounds < maxRounds);

  return { items, nextCursor: encodeCursor(lastEvaluatedKey) };
}

/** Reads every item of a query (all pages), up to `maxItems`. */
export async function queryAll(params, { maxItems = 1000 } = {}) {
  const items = [];
  let exclusiveStartKey;
  do {
    const response = await dynamo().send(
      new QueryCommand({ TableName: tableName(), ...params, ExclusiveStartKey: exclusiveStartKey }),
    );
    items.push(...(response.Items ?? []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey && items.length < maxItems);
  return items.slice(0, maxItems);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

function requestKey(request) {
  const key = request.PutRequest
    ? { PK: request.PutRequest.Item.PK, SK: request.PutRequest.Item.SK }
    : request.DeleteRequest.Key;
  return `${key.PK}|${key.SK}`;
}

/**
 * BatchWriteItem with chunking (25 requests), de-duplication (last request wins for a key)
 * and exponential back-off on UnprocessedItems.
 * @param {Array<{PutRequest?: {Item: object}, DeleteRequest?: {Key: object}}>} requests
 */
export async function batchWriteAll(requests, { maxAttempts = 8 } = {}) {
  const unique = new Map();
  for (const request of requests) unique.set(requestKey(request), request);

  for (const group of chunk([...unique.values()], 25)) {
    let pending = group;
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      if (attempt >= maxAttempts) {
        throw new Error(`BatchWrite: ${pending.length} item(s) still unprocessed after ${maxAttempts} attempts`);
      }
      if (attempt > 0) await sleep(Math.min(50 * 2 ** attempt, 2000));
      const response = await dynamo().send(
        new BatchWriteCommand({ RequestItems: { [tableName()]: pending } }),
      );
      pending = response.UnprocessedItems?.[tableName()] ?? [];
    }
  }
}

/**
 * BatchGetItem with chunking (100 keys) and retries on UnprocessedKeys.
 * Returns the found items (order is not guaranteed).
 */
export async function batchGetAll(keyList, { projection, names, maxAttempts = 8 } = {}) {
  const seen = new Set();
  const uniqueKeys = keyList.filter((key) => {
    const id = `${key.PK}|${key.SK}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const results = [];
  for (const group of chunk(uniqueKeys, 100)) {
    let pending = group;
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      if (attempt >= maxAttempts) {
        throw new Error(`BatchGet: ${pending.length} key(s) still unprocessed after ${maxAttempts} attempts`);
      }
      if (attempt > 0) await sleep(Math.min(50 * 2 ** attempt, 2000));
      const response = await dynamo().send(
        new BatchGetCommand({
          RequestItems: {
            [tableName()]: {
              Keys: pending,
              ProjectionExpression: projection,
              ExpressionAttributeNames: names,
            },
          },
        }),
      );
      results.push(...(response.Responses?.[tableName()] ?? []));
      pending = response.UnprocessedKeys?.[tableName()]?.Keys ?? [];
    }
  }
  return results;
}

/** Cancellation reason codes of a TransactionCanceledException (e.g. ['None', 'ConditionalCheckFailed']). */
export function cancellationReasons(err) {
  return (err?.CancellationReasons ?? []).map((reason) => reason?.Code ?? 'None');
}

export function isConditionalCheckFailed(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

export function isTransactionCanceled(err) {
  return err?.name === 'TransactionCanceledException';
}
