// DynamoDB Streams consumer: announces newly published posts to newsletter subscribers
// (Amazon SNS e-mails) and to integrations (EventBridge "PostPublished" event).
//
// The event source mapping only delivers INSERT/MODIFY records of posts whose new image is
// published (see template.yaml); the same checks are repeated here so that the function stays
// correct whatever the filter. Records are processed sequentially: on the first failure the
// handler reports that record (ReportBatchItemFailures) and stops, so Lambda retries from it and
// the per-post ordering of the stream is preserved.

import { unmarshall } from '@aws-sdk/util-dynamodb';
import { logger } from '../../lib/logger.mjs';
import { isFirstPublication, notifyPostPublished } from '../../domain/notifications.mjs';

const NOTIFIABLE_EVENTS = new Set(['INSERT', 'MODIFY']);
const IGNORED = 'ignored';

const imageOf = (attributeMap) => (attributeMap ? unmarshall(attributeMap) : null);

/** Handles one stream record; resolves to what was done ('ignored', 'notified', 'already_notified'). */
async function processRecord(record) {
  const change = record?.dynamodb ?? {};
  if (!NOTIFIABLE_EVENTS.has(record?.eventName) || change.Keys?.SK?.S !== 'POST') return IGNORED;

  const post = imageOf(change.NewImage);
  // Only the first publication is announced: edits and comment counts of a published post are not.
  if (!isFirstPublication(post, imageOf(change.OldImage))) return IGNORED;
  if (!post.postId) {
    logger.warn('Published post image without postId: ignored', { eventID: record.eventID });
    return IGNORED;
  }
  return notifyPostPublished(post);
}

/**
 * @param {{ Records?: object[] }} event DynamoDB Streams batch
 * @returns {Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>}
 */
export async function handler(event) {
  const records = event?.Records ?? [];
  const outcomes = {};
  for (const record of records) {
    let outcome;
    try {
      outcome = await processRecord(record);
    } catch (err) {
      logger.error('Post notification failed: the record will be retried', {
        eventID: record?.eventID,
        sequenceNumber: record?.dynamodb?.SequenceNumber,
        error: err,
      });
      return { batchItemFailures: [{ itemIdentifier: record?.dynamodb?.SequenceNumber }] };
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  logger.info('Notifier batch processed', { records: records.length, ...outcomes });
  return { batchItemFailures: [] };
}
