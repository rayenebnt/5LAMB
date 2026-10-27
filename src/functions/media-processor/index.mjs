// Media processor: validates every object uploaded to the media bucket.
// Trigger: EventBridge rule on S3 "Object Created" events (key prefix media/, see template.yaml),
// with retries and a dead-letter queue: unexpected errors are rethrown on purpose.
// The validation rules live in src/domain/media.mjs (processUploadedObject).

import { decodeS3Key, PROCESSING_OUTCOME, processUploadedObject } from '../../domain/media.mjs';
import { config } from '../../lib/config.mjs';
import { logger } from '../../lib/logger.mjs';

/** Outcomes that may reveal an abuse attempt or a client bug: logged as warnings. */
const NOTABLE_OUTCOMES = new Set([
  PROCESSING_OUTCOME.REJECTED,
  PROCESSING_OUTCOME.ORPHAN_DELETED,
  PROCESSING_OUTCOME.STRAY_DELETED,
]);

/**
 * EventBridge event: `{ source: 'aws.s3', 'detail-type': 'Object Created',
 * detail: { bucket: { name }, object: { key, size } } }`.
 * @returns {Promise<{ outcome: string, mediaId?: string, reason?: string }>}
 */
export async function handler(event) {
  const bucket = event?.detail?.bucket?.name;
  const rawKey = event?.detail?.object?.key;
  if (typeof bucket !== 'string' || typeof rawKey !== 'string' || rawKey === '') {
    logger.warn('Ignoring malformed S3 event', { eventId: event?.id });
    return { outcome: PROCESSING_OUTCOME.IGNORED };
  }
  if (bucket !== config.mediaBucket) {
    // Never touch (or delete) objects of a bucket this function does not manage.
    logger.warn('Ignoring S3 event of an unexpected bucket', { eventId: event.id, bucket });
    return { outcome: PROCESSING_OUTCOME.IGNORED };
  }

  const key = decodeS3Key(rawKey);
  const result = await processUploadedObject({ bucket, key });
  const log = NOTABLE_OUTCOMES.has(result.outcome) ? logger.warn : logger.info;
  log('Media object processed', { eventId: event.id, key, ...result });
  return result;
}
