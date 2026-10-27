// Identifier helpers.
// UUID v7 (RFC 9562) identifiers are time-ordered: their string form sorts chronologically,
// which makes them good DynamoDB sort keys (e.g. comments ordered by creation time).

import { randomBytes } from 'node:crypto';

let lastTimestamp = -1;
let sequence = 0;

/**
 * Generates a UUID v7. Within a single process, identifiers are strictly increasing,
 * even when several are generated during the same millisecond (12-bit counter in rand_a).
 */
export function uuidv7(now = Date.now()) {
  let timestamp = now;
  if (timestamp <= lastTimestamp) {
    timestamp = lastTimestamp;
    sequence += 1;
    if (sequence > 0xfff) {
      timestamp += 1;
      sequence = 0;
    }
  } else {
    sequence = 0;
  }
  lastTimestamp = timestamp;

  const bytes = randomBytes(16);
  const ts = BigInt(timestamp);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f); // version 7 + high bits of the counter
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Current time as an ISO-8601 string (UTC, millisecond precision). */
export function nowIso() {
  return new Date().toISOString();
}

/** Epoch seconds `seconds` from now (DynamoDB TTL attribute format). */
export function ttlFromNow(seconds) {
  return Math.floor(Date.now() / 1000) + seconds;
}
