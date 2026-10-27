// DynamoDB Streams consumer maintaining the asynchronous projections of posts (the event source
// mapping only delivers post items, SK = POST):
//   - tag memberships and tag counters (src/domain/tags.mjs)
//   - search index terms (src/domain/search.mjs)
//   - cascade deletion of the comments and notification marker of a deleted post
//
// Records are processed one at a time, in stream order (the changes of a post must be applied in
// order). On the first failure the handler stops and reports that record: Lambda then retries
// from it (ReportBatchItemFailures). Every step is idempotent, so replaying records is harmless.

import { isDeepStrictEqual } from 'node:util';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { batchWriteAll, keys, queryAll } from '../../lib/db.mjs';
import { logger } from '../../lib/logger.mjs';
import { POST_STATUS } from '../../lib/schema.mjs';
import { projectSearchTerms } from '../../domain/search.mjs';
import { projectTags } from '../../domain/tags.mjs';

/** Post attributes on which the projections depend: changes of other attributes are skipped. */
export const RELEVANT_FIELDS = Object.freeze([
  'status',
  'title',
  'slug',
  'excerpt',
  'content',
  'tags',
  'coverImageUrl',
  'publishedAt',
  'authorName',
  'readingTimeMinutes',
  'allowComments',
]);

const POST_SK = keys.post('').SK;
const POST_PK_PREFIX = keys.post('').PK;

/**
 * False only when both images exist and none of the RELEVANT_FIELDS changed
 * (e.g. a comment counter update): such records are skipped.
 */
export function hasRelevantChange(oldImage, newImage) {
  if (!oldImage || !newImage) return true;
  return RELEVANT_FIELDS.some((field) => !isDeepStrictEqual(oldImage[field], newImage[field]));
}

/** The post item when it is published, null otherwise (absent image or other status). */
export function publishedPost(image) {
  return image?.status === POST_STATUS.PUBLISHED ? image : null;
}

/**
 * Deletes every item left in the partition of a deleted post (comments, notification marker).
 * The post item itself is never deleted here: it is already gone when its REMOVE record is
 * processed, and an item with that key could only be a newer write.
 * @returns {Promise<number>} number of deleted items
 */
export async function purgePostPartition(postId) {
  const { PK } = keys.post(postId);
  const remaining = await queryAll(
    {
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': PK },
      ProjectionExpression: 'PK, SK',
      ConsistentRead: true,
    },
    { maxItems: Number.POSITIVE_INFINITY },
  );
  const deletes = remaining
    .filter((item) => item.SK !== POST_SK)
    .map((item) => ({ DeleteRequest: { Key: { PK: item.PK, SK: item.SK } } }));
  await batchWriteAll(deletes);
  return deletes.length;
}

/**
 * Applies one stream record to the projections.
 * @returns {Promise<object>} what was done (logged by the handler)
 */
export async function processRecord(record) {
  const { eventName, dynamodb = {} } = record;
  const { PK, SK } = dynamodb.Keys ? unmarshall(dynamodb.Keys) : {};
  if (SK !== POST_SK || typeof PK !== 'string' || !PK.startsWith(POST_PK_PREFIX)) {
    return { eventName, ignored: true }; // not a post (the event filter should prevent it)
  }
  const postId = PK.slice(POST_PK_PREFIX.length);
  const oldImage = dynamodb.OldImage ? unmarshall(dynamodb.OldImage) : null;
  const newImage = dynamodb.NewImage ? unmarshall(dynamodb.NewImage) : null;
  const outcome = { eventName, postId };

  if (hasRelevantChange(oldImage, newImage)) {
    const before = publishedPost(oldImage);
    const after = publishedPost(newImage);
    outcome.tags = await projectTags(before, after);
    outcome.terms = await projectSearchTerms(before, after);
  } else {
    outcome.skipped = true;
  }

  if (eventName === 'REMOVE') outcome.purged = await purgePostPartition(postId);
  return outcome;
}

/**
 * Lambda handler (DynamoDB Streams event source with ReportBatchItemFailures).
 * @returns {Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>}
 */
export async function handler(event) {
  for (const record of event?.Records ?? []) {
    const sequenceNumber = record?.dynamodb?.SequenceNumber;
    try {
      const outcome = await processRecord(record);
      logger.info('Stream record projected', { eventID: record.eventID, sequenceNumber, ...outcome });
    } catch (err) {
      logger.error('Stream record projection failed', { eventID: record?.eventID, sequenceNumber, error: err });
      return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] };
    }
  }
  return { batchItemFailures: [] };
}
