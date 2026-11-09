import '../helpers/env.mjs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  ProvisionedThroughputExceededException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectTaggingCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  ALLOWED_CONTENT_TYPES,
  decodeS3Key,
  detectSignature,
  matchesSignature,
  MEDIA_TYPES,
  parseMediaKey,
  uploadRejectionReason,
} from '../../src/domain/media.mjs';
import { handler } from '../../src/functions/media-processor/index.mjs';

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const MiB = 1024 * 1024;
const BUCKET = 'blogify-test-media';
const MEDIA_ID = '0192f5a1-7c2b-7d3e-8f40-123456789abc';
const KEY = `media/${MEDIA_ID}/photo.png`;

/** First 32 bytes of a file (what the processor reads), from byte arrays and latin1 strings. */
function head(...parts) {
  const bytes = Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))),
  );
  return bytes.length >= 32 ? bytes.subarray(0, 32) : Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]);
}

/** Realistic beginnings of a file of each accepted format. */
const SAMPLES = Object.freeze({
  'image/jpeg': head([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0x00, 0x01, 0x01, 0x00, 0x00, 0x48]),
  'image/png': head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d], 'IHDR'),
  'image/gif': head('GIF89a', [0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
  'image/webp': head('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 ', [0x18, 0x00, 0x00, 0x00]),
  'image/avif': head([0x00, 0x00, 0x00, 0x1c], 'ftypavif', [0x00, 0x00, 0x00, 0x00], 'avifmif1miaf'),
  'video/mp4': head([0x00, 0x00, 0x00, 0x20], 'ftypisom', [0x00, 0x00, 0x02, 0x00], 'isomiso2avc1mp41'),
  'video/webm': head([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], 'webm'),
  'video/quicktime': head([0x00, 0x00, 0x00, 0x14], 'ftypqt  ', [0x20, 0x05, 0x03, 0x00], 'qt  '),
});

/** Files that must never pass as media (scripts, documents, archives, executables...). */
const NOT_MEDIA = Object.freeze({
  svg: head('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">'),
  svgWithProlog: head('<?xml version="1.0" encoding="UTF-8"?><svg>'),
  html: head('<!DOCTYPE html><html><script>alert(1)</script>'),
  pdf: head('%PDF-1.7\n%\xe2\xe3\xcf\xd3'),
  zip: head([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
  wav: head('RIFF', [0x24, 0x08, 0x00, 0x00], 'WAVEfmt '),
  avi: head('RIFF', [0x24, 0x08, 0x00, 0x00], 'AVI LIST'),
  bmp: head('BM', [0x36, 0x00, 0x0c, 0x00, 0x00, 0x00]),
  tiff: head('II*', [0x00, 0x08, 0x00, 0x00, 0x00]),
  elf: head([0x7f], 'ELF', [0x02, 0x01, 0x01, 0x00]),
  windowsExe: head('MZ', [0x90, 0x00, 0x03, 0x00]),
  text: head('hello world, this is plain text'),
  gif88: head('GIF88a', [0x01, 0x00, 0x01, 0x00]),
  ftypWithoutBoxSize: head('ftypisom', [0x00, 0x00, 0x02, 0x00], 'isomiso2'),
  shiftedPng: head([0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  zeros: Buffer.alloc(32),
});

/** Documented ISO-BMFF overlaps: the generic MP4 rule accepts any "ftyp" brand. */
const COMPATIBLE = new Set(['image/avif>video/mp4', 'video/quicktime>video/mp4']);

function mediaItem(overrides = {}) {
  return {
    PK: `MEDIA#${MEDIA_ID}`,
    SK: 'MEDIA',
    entityType: 'MEDIA',
    mediaId: MEDIA_ID,
    ownerId: '33333333-3333-4333-8333-333333333333',
    ownerName: 'Gaby Guest',
    filename: 'photo.png',
    contentType: 'image/png',
    kind: 'image',
    size: 2048,
    status: 'pending',
    s3Key: KEY,
    altText: null,
    rejectionReason: null,
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    expiresAt: 1793095200,
    ...overrides,
  };
}

/** EventBridge "Object Created" event, as emitted by S3 (see events/s3-object-created.json). */
function s3Event(key = KEY, { bucket = BUCKET, size = 2048 } = {}) {
  return {
    version: '0',
    id: '17793124-05d4-b198-2fde-7ededc63b103',
    'detail-type': 'Object Created',
    source: 'aws.s3',
    account: '123456789012',
    time: '2026-10-27T10:00:00Z',
    region: 'eu-west-3',
    resources: [`arn:aws:s3:::${bucket}`],
    detail: {
      version: '0',
      bucket: { name: bucket },
      object: { key, size, etag: 'b1946ac92492d2347c6235b4d2611184', sequencer: '00617F08299329D189' },
      'request-id': 'N4N7GDK58NMKJ12R',
      requester: '123456789012',
      reason: 'PostObject',
    },
  };
}

const givenItem = (item) => ddb.on(GetCommand).resolves(item ? { Item: item } : {});

/** HeadObject metadata and ranged GetObject body of the uploaded object. */
function givenObject({ contentType = 'image/png', size = 2048, bytes = SAMPLES['image/png'], etag = '"etag-1"' } = {}) {
  s3.on(HeadObjectCommand).resolves({ ContentType: contentType, ContentLength: size, ETag: etag });
  s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => new Uint8Array(bytes) } });
}

const updates = () => ddb.commandCalls(UpdateCommand).map((call) => call.args[0].input);
const deletedObjects = () => s3.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input);
const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
const epochSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  ddb.reset();
  s3.reset();
  ddb.on(UpdateCommand).resolves({});
  s3.on(DeleteObjectCommand).resolves({});
});

afterEach(() => {
  delete process.env.MAX_IMAGE_MB;
  delete process.env.MAX_VIDEO_MB;
});

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

describe('detectSignature / matchesSignature', () => {
  test('every accepted format is recognised from its first bytes', () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...ALLOWED_CONTENT_TYPES].sort());
    for (const [contentType, bytes] of Object.entries(SAMPLES)) {
      assert.equal(detectSignature(bytes), contentType, contentType);
      assert.equal(matchesSignature(bytes, contentType), true, contentType);
    }
  });

  test('signature variants of each format', () => {
    const variants = [
      ['image/jpeg', head([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x18], 'Exif')], // EXIF (camera)
      ['image/jpeg', head([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43])], // raw JPEG
      ['image/jpeg', head([0xff, 0xd8, 0xff, 0xee])], // Adobe
      ['image/gif', head('GIF87a', [0x01, 0x00])],
      ['image/avif', head([0x00, 0x00, 0x00, 0x20], 'ftypavis', [0, 0, 0, 0], 'avismsf1')], // animated AVIF
      ['image/avif', head([0x00, 0x00, 0x00, 0x18], 'ftypmif1', [0, 0, 0, 0], 'mif1avif')],
      ['video/mp4', head([0x00, 0x00, 0x00, 0x18], 'ftypmp42', [0, 0, 0, 0], 'mp42isom')],
      ['video/mp4', head([0x00, 0x00, 0x00, 0x1c], 'ftypM4V ', [0, 0, 0, 1], 'M4V M4A ')],
      ['video/mp4', head([0x00, 0x00, 0x00, 0x18], 'ftypdash', [0, 0, 0, 0], 'iso6')],
      ['video/quicktime', head([0x00, 0x00, 0x00, 0x08], 'wide', [0x00, 0x2d, 0x6a, 0x5b], 'mdat')],
      ['video/quicktime', head([0x00, 0x00, 0x6d, 0x1e], 'mdat')],
      ['video/quicktime', head([0x00, 0x00, 0x01, 0x00], 'moov', [0x00, 0x00, 0x00, 0x6c], 'mvhd')],
      ['video/quicktime', head([0x00, 0x00, 0x00, 0x10], 'free')],
    ];
    for (const [contentType, bytes] of variants) {
      assert.equal(detectSignature(bytes), contentType, bytes.toString('latin1', 0, 12));
      assert.equal(matchesSignature(bytes, contentType), true, bytes.toString('latin1', 0, 12));
    }
  });

  test('scripts, documents, archives and executables are not media', () => {
    for (const [name, bytes] of Object.entries(NOT_MEDIA)) {
      assert.equal(detectSignature(bytes), null, name);
      for (const contentType of ALLOWED_CONTENT_TYPES) {
        assert.equal(matchesSignature(bytes, contentType), false, `${name} as ${contentType}`);
      }
    }
  });

  test('truncated or empty input never matches', () => {
    assert.equal(detectSignature(SAMPLES['image/png'].subarray(0, 7)), null);
    assert.equal(detectSignature(SAMPLES['image/jpeg'].subarray(0, 2)), null);
    assert.equal(detectSignature(SAMPLES['image/gif'].subarray(0, 5)), null);
    assert.equal(detectSignature(SAMPLES['image/webp'].subarray(0, 11)), null);
    assert.equal(detectSignature(SAMPLES['video/webm'].subarray(0, 3)), null);
    assert.equal(detectSignature(SAMPLES['video/quicktime'].subarray(0, 7)), null);
    assert.equal(detectSignature(Buffer.alloc(0)), null);
    assert.equal(detectSignature(new Uint8Array(0)), null);
    assert.equal(detectSignature(undefined), null);
    assert.equal(detectSignature(null), null);
    assert.equal(matchesSignature(undefined, 'image/png'), false);
  });

  test('a declared type only accepts its own signature (except documented ISO-BMFF overlaps)', () => {
    for (const [actual, bytes] of Object.entries(SAMPLES)) {
      for (const declared of ALLOWED_CONTENT_TYPES) {
        const expected = actual === declared || COMPATIBLE.has(`${actual}>${declared}`);
        assert.equal(matchesSignature(bytes, declared), expected, `${actual} bytes declared as ${declared}`);
      }
    }
  });

  test('ISO-BMFF brands: AVIF and QuickTime are detected before the generic MP4 rule', () => {
    // An MP4 may use any brand (spec), so AVIF / QuickTime "ftyp" files are valid MP4 containers...
    assert.equal(matchesSignature(SAMPLES['image/avif'], 'video/mp4'), true);
    assert.equal(matchesSignature(SAMPLES['video/quicktime'], 'video/mp4'), true);
    // ...but the detection reports the most specific format.
    assert.equal(detectSignature(SAMPLES['image/avif']), 'image/avif');
    assert.equal(detectSignature(SAMPLES['video/quicktime']), 'video/quicktime');
    // Classic QuickTime atoms are not MP4, and generic MP4 brands are neither AVIF nor QuickTime.
    const moov = head([0x00, 0x00, 0x01, 0x00], 'moov');
    assert.equal(matchesSignature(moov, 'video/mp4'), false);
    assert.equal(matchesSignature(SAMPLES['video/mp4'], 'image/avif'), false);
    assert.equal(matchesSignature(SAMPLES['video/mp4'], 'video/quicktime'), false);
    // HEIC photos (brand "heic") are not accepted as AVIF.
    const heic = head([0x00, 0x00, 0x00, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic');
    assert.equal(matchesSignature(heic, 'image/avif'), false);
  });

  test('accepts Buffer, Uint8Array and plain byte arrays', () => {
    const png = SAMPLES['image/png'];
    assert.equal(detectSignature(new Uint8Array(png)), 'image/png');
    assert.equal(detectSignature([...png]), 'image/png');
    assert.equal(detectSignature(png.subarray(0, 8)), 'image/png');
    assert.equal(matchesSignature([0x1a, 0x45, 0xdf, 0xa3], 'video/webm'), true);
  });

  test('refused or unknown declared types never match (no prototype lookups)', () => {
    assert.equal(matchesSignature(NOT_MEDIA.svg, 'image/svg+xml'), false);
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', undefined]) {
      assert.equal(matchesSignature(SAMPLES['image/png'], type), false, String(type));
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helpers used by the processor
// ---------------------------------------------------------------------------

describe('uploadRejectionReason', () => {
  const png = { contentType: 'image/png', kind: 'image' };
  const mp4 = { contentType: 'video/mp4', kind: 'video' };

  test('a valid object has no rejection reason', () => {
    assert.equal(uploadRejectionReason(png, { contentType: 'image/png', size: 2048, bytes: SAMPLES['image/png'] }), null);
    // MIME types are case-insensitive and parameters are ignored.
    assert.equal(
      uploadRejectionReason(png, { contentType: 'Image/PNG; charset=binary', size: 1, bytes: SAMPLES['image/png'] }),
      null,
    );
  });

  test('the stored content type must equal the declared one', () => {
    assert.equal(
      uploadRejectionReason(png, { contentType: 'image/jpeg', size: 10, bytes: SAMPLES['image/png'] }),
      "Content type 'image/jpeg' does not match the declared type 'image/png'",
    );
    assert.equal(
      uploadRejectionReason(png, { contentType: undefined, size: 10, bytes: SAMPLES['image/png'] }),
      "Content type 'unknown' does not match the declared type 'image/png'",
    );
  });

  test('the size limit of the kind is inclusive and configurable', () => {
    const object = (size) => ({ contentType: 'image/png', size, bytes: SAMPLES['image/png'] });
    assert.equal(uploadRejectionReason(png, object(10 * MiB)), null);
    assert.equal(
      uploadRejectionReason(png, object(10 * MiB + 1)),
      'File size (10485761 bytes) exceeds the 10 MB limit for image files',
    );
    const video = (size) => ({ contentType: 'video/mp4', size, bytes: SAMPLES['video/mp4'] });
    assert.equal(uploadRejectionReason(mp4, video(150 * MiB)), null);
    assert.match(uploadRejectionReason(mp4, video(200 * MiB + 1)), /exceeds the 200 MB limit for video files/);
    process.env.MAX_VIDEO_MB = '50';
    assert.match(uploadRejectionReason(mp4, video(150 * MiB)), /exceeds the 50 MB limit for video files/);
  });

  test('the magic bytes must match the declared format', () => {
    assert.equal(
      uploadRejectionReason(png, { contentType: 'image/png', size: 10, bytes: SAMPLES['image/jpeg'] }),
      'File content is not a valid image/png file (detected: image/jpeg)',
    );
    assert.equal(
      uploadRejectionReason(png, { contentType: 'image/png', size: 10, bytes: NOT_MEDIA.html }),
      'File content is not a valid image/png file (detected: unknown format)',
    );
  });
});

describe('object keys', () => {
  test('parseMediaKey only accepts media/<uuid>/<file>', () => {
    assert.equal(parseMediaKey(`media/${MEDIA_ID}/photo.png`), MEDIA_ID);
    assert.equal(parseMediaKey(`media/${MEDIA_ID}/nested/photo.png`), MEDIA_ID);
    assert.equal(parseMediaKey(`media/${MEDIA_ID}/`), null);
    assert.equal(parseMediaKey(`media/${MEDIA_ID}`), null);
    assert.equal(parseMediaKey('media/not-a-uuid/photo.png'), null);
    assert.equal(parseMediaKey('media/photo.png'), null);
    assert.equal(parseMediaKey(`uploads/${MEDIA_ID}/photo.png`), null);
    assert.equal(parseMediaKey(`/media/${MEDIA_ID}/photo.png`), null);
    assert.equal(parseMediaKey(undefined), null);
  });

  test('decodeS3Key decodes URL-encoded keys ("+" is a space)', () => {
    assert.equal(decodeS3Key(KEY), KEY);
    assert.equal(decodeS3Key('media/x/mon+fichier+%281%29.png'), 'media/x/mon fichier (1).png');
    assert.equal(decodeS3Key('media/x/caf%C3%A9.png'), 'media/x/café.png');
    assert.equal(decodeS3Key('media/x/a%2Bb.png'), 'media/x/a+b.png');
    assert.equal(decodeS3Key('media/x/100%.png'), 'media/x/100%.png'); // invalid encoding: unchanged
    assert.equal(decodeS3Key(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// Processor (EventBridge "Object Created" events)
// ---------------------------------------------------------------------------

describe('media processor', () => {
  test('a valid upload becomes ready with its real size', async () => {
    givenItem(mediaItem());
    givenObject({ size: 1900 });

    const result = await handler(s3Event(KEY, { size: 1900 }));

    assert.deepEqual(result, { outcome: 'ready', mediaId: MEDIA_ID });
    const get = ddb.commandCalls(GetCommand)[0].args[0].input;
    assert.deepEqual(get, {
      TableName: 'blogify-test',
      Key: { PK: `MEDIA#${MEDIA_ID}`, SK: 'MEDIA' },
      ConsistentRead: true,
    });
    assert.deepEqual(s3.commandCalls(HeadObjectCommand)[0].args[0].input, { Bucket: BUCKET, Key: KEY });
    assert.deepEqual(s3.commandCalls(GetObjectCommand)[0].args[0].input, {
      Bucket: BUCKET,
      Key: KEY,
      Range: 'bytes=0-31',
      IfMatch: '"etag-1"',
    });
    const [update] = updates();
    assert.equal(update.TableName, 'blogify-test');
    assert.deepEqual(update.Key, { PK: `MEDIA#${MEDIA_ID}`, SK: 'MEDIA' });
    assert.equal(update.UpdateExpression, 'SET #status = :ready, #size = :size, updatedAt = :now REMOVE expiresAt');
    assert.equal(update.ConditionExpression, '#status = :pending');
    assert.deepEqual(update.ExpressionAttributeNames, { '#status': 'status', '#size': 'size' });
    const { ':now': now, ...values } = update.ExpressionAttributeValues;
    assert.deepEqual(values, { ':ready': 'ready', ':pending': 'pending', ':size': 1900 });
    assert.ok(Math.abs(Date.parse(now) - Date.now()) < 5000);
    assert.equal(updates().length, 1);
    assert.deepEqual(deletedObjects(), []);
  });

  test('every accepted format with matching magic bytes becomes ready', async () => {
    for (const contentType of ALLOWED_CONTENT_TYPES) {
      ddb.reset();
      s3.reset();
      ddb.on(UpdateCommand).resolves({});
      const { kind, extension } = MEDIA_TYPES[contentType];
      const key = `media/${MEDIA_ID}/file.${extension}`;
      givenItem(mediaItem({ contentType, kind, filename: `file.${extension}`, s3Key: key, size: 5 * MiB }));
      givenObject({ contentType, size: 5 * MiB, bytes: SAMPLES[contentType] });

      const result = await handler(s3Event(key));

      assert.equal(result.outcome, 'ready', contentType);
      assert.equal(updates()[0].ExpressionAttributeValues[':ready'], 'ready', contentType);
      assert.equal(s3.commandCalls(DeleteObjectCommand).length, 0, contentType);
    }
  });

  test('URL-encoded keys are decoded before every S3 and DynamoDB call', async () => {
    const decodedKey = `media/${MEDIA_ID}/mon fichier (1).png`;
    givenItem(mediaItem({ s3Key: decodedKey }));
    givenObject();

    const result = await handler(s3Event(`media/${MEDIA_ID}/mon+fichier+%281%29.png`));

    assert.equal(result.outcome, 'ready');
    assert.equal(s3.commandCalls(HeadObjectCommand)[0].args[0].input.Key, decodedKey);
    assert.equal(s3.commandCalls(GetObjectCommand)[0].args[0].input.Key, decodedKey);
  });

  test('wrong content type: the media is rejected for 7 days, then the object is deleted', async () => {
    givenItem(mediaItem());
    givenObject({ contentType: 'image/jpeg', bytes: SAMPLES['image/jpeg'] });
    const order = [];
    s3.on(DeleteObjectCommand).callsFake(() => {
      order.push('delete-object');
      return {};
    });
    ddb.on(UpdateCommand).callsFake(() => {
      order.push('update-item');
      return {};
    });

    const result = await handler(s3Event());

    assert.deepEqual(result, {
      outcome: 'rejected',
      mediaId: MEDIA_ID,
      reason: "Content type 'image/jpeg' does not match the declared type 'image/png'",
    });
    assert.deepEqual(order, ['update-item', 'delete-object']);
    assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: KEY }]);
    const [update] = updates();
    assert.equal(
      update.UpdateExpression,
      'SET #status = :rejected, rejectionReason = :reason, updatedAt = :now, expiresAt = :expiresAt',
    );
    assert.equal(update.ConditionExpression, '#status IN (:pending, :ready)');
    assert.deepEqual(update.ExpressionAttributeNames, { '#status': 'status' });
    const values = update.ExpressionAttributeValues;
    assert.equal(values[':rejected'], 'rejected');
    assert.equal(values[':pending'], 'pending');
    assert.equal(values[':ready'], 'ready');
    assert.equal(values[':reason'], result.reason);
    assert.ok(Math.abs(values[':expiresAt'] - (epochSeconds() + 7 * 24 * 3600)) <= 5);
    assert.ok(Math.abs(Date.parse(values[':now']) - Date.now()) < 5000);
  });

  test('disguised files (HTML, SVG, executable) declared as images are rejected', async () => {
    for (const name of ['html', 'svg', 'svgWithProlog', 'windowsExe', 'zeros']) {
      ddb.reset();
      s3.reset();
      ddb.on(UpdateCommand).resolves({});
      s3.on(DeleteObjectCommand).resolves({});
      givenItem(mediaItem());
      givenObject({ bytes: NOT_MEDIA[name] });

      const result = await handler(s3Event());

      assert.equal(result.outcome, 'rejected', name);
      assert.equal(result.reason, 'File content is not a valid image/png file (detected: unknown format)', name);
      assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: KEY }], name);
      assert.equal(updates()[0].ExpressionAttributeValues[':rejected'], 'rejected', name);
    }
  });

  test('a real file of another format than the declared one is rejected', async () => {
    givenItem(mediaItem());
    givenObject({ bytes: SAMPLES['image/gif'] });

    const result = await handler(s3Event());

    assert.equal(result.outcome, 'rejected');
    assert.equal(result.reason, 'File content is not a valid image/png file (detected: image/gif)');
  });

  test('too big: images above MAX_IMAGE_MB are rejected', async () => {
    givenItem(mediaItem());
    givenObject({ size: 10 * MiB + 1 });

    const result = await handler(s3Event());

    assert.equal(result.outcome, 'rejected');
    assert.equal(result.reason, 'File size (10485761 bytes) exceeds the 10 MB limit for image files');
    assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: KEY }]);

    ddb.resetHistory();
    s3.resetHistory();
    process.env.MAX_IMAGE_MB = '1';
    givenObject({ size: 2 * MiB });
    const configured = await handler(s3Event());
    assert.equal(configured.outcome, 'rejected');
    assert.match(configured.reason, /exceeds the 1 MB limit for image files/);
  });

  test('videos use the video limit (MAX_VIDEO_MB)', async () => {
    const key = `media/${MEDIA_ID}/clip.mp4`;
    const video = mediaItem({ contentType: 'video/mp4', kind: 'video', filename: 'clip.mp4', s3Key: key, size: 200 * MiB });
    givenItem(video);
    givenObject({ contentType: 'video/mp4', size: 150 * MiB, bytes: SAMPLES['video/mp4'] });
    assert.equal((await handler(s3Event(key))).outcome, 'ready');
    assert.equal(updates()[0].ExpressionAttributeValues[':size'], 150 * MiB);

    ddb.resetHistory();
    givenObject({ contentType: 'video/mp4', size: 200 * MiB + 1, bytes: SAMPLES['video/mp4'] });
    const tooBig = await handler(s3Event(key));
    assert.equal(tooBig.outcome, 'rejected');
    assert.match(tooBig.reason, /exceeds the 200 MB limit for video files/);
  });

  test('an empty object is rejected without a ranged read', async () => {
    givenItem(mediaItem());
    givenObject({ size: 0 });

    const result = await handler(s3Event());

    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /not a valid image\/png file/);
    assert.equal(s3.commandCalls(GetObjectCommand).length, 0);
  });

  test('orphan object (no media item): deleted, nothing else', async () => {
    givenItem(null);

    const result = await handler(s3Event());

    assert.deepEqual(result, { outcome: 'orphan_deleted' });
    assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: KEY }]);
    assert.equal(s3.commandCalls(HeadObjectCommand).length, 0);
    assert.equal(updates().length, 0);
  });

  test('orphan with an URL-encoded key: the decoded key is deleted', async () => {
    givenItem(null);

    await handler(s3Event(`media/${MEDIA_ID}/Mon+Sch%C3%A9ma.png`));

    assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: `media/${MEDIA_ID}/Mon Schéma.png` }]);
  });

  test('objects outside the media/<mediaId>/ layout are deleted without a lookup', async () => {
    for (const key of ['media/not-a-uuid/photo.png', 'media/photo.png', `media/${MEDIA_ID}/`]) {
      ddb.resetHistory();
      s3.resetHistory();

      const result = await handler(s3Event(key));

      assert.equal(result.outcome, 'orphan_deleted', key);
      assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: key }], key);
      assert.equal(ddb.commandCalls(GetCommand).length, 0, key);
    }
  });

  test('an object stored under another key than the media s3Key is an orphan', async () => {
    givenItem(mediaItem());

    const result = await handler(s3Event(`media/${MEDIA_ID}/other.png`));

    assert.equal(result.outcome, 'orphan_deleted');
    assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: `media/${MEDIA_ID}/other.png` }]);
    assert.equal(updates().length, 0);
  });

  test('already processed: a duplicate event for a ready media changes nothing', async () => {
    givenItem(mediaItem({ status: 'ready', size: 2048 }));
    givenObject({ size: 2048 });

    const result = await handler(s3Event());

    assert.deepEqual(result, { outcome: 'unchanged', mediaId: MEDIA_ID });
    assert.equal(updates().length, 0);
    assert.deepEqual(deletedObjects(), []);
  });

  test('already processed: a ready media overwritten with invalid content is rejected', async () => {
    // The presigned POST form stays usable until it expires: the object may be replaced.
    givenItem(mediaItem({ status: 'ready' }));
    givenObject({ bytes: NOT_MEDIA.html });

    const result = await handler(s3Event());

    assert.equal(result.outcome, 'rejected');
    assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: KEY }]);
    assert.equal(updates()[0].ConditionExpression, '#status IN (:pending, :ready)');
  });

  test('already processed: a ready media overwritten with another valid file keeps its status', async () => {
    givenItem(mediaItem({ status: 'ready', size: 2048 }));
    givenObject({ size: 4096 });

    const result = await handler(s3Event());

    assert.equal(result.outcome, 'unchanged');
    const [update] = updates();
    assert.equal(update.UpdateExpression, 'SET #size = :size, updatedAt = :now');
    assert.equal(update.ConditionExpression, '#status = :ready');
    assert.equal(update.ExpressionAttributeValues[':size'], 4096);
    assert.deepEqual(deletedObjects(), []);
  });

  test('already processed: an object uploaded again for a rejected media is deleted', async () => {
    givenItem(mediaItem({ status: 'rejected', rejectionReason: 'File content is not a valid image/png file' }));

    const result = await handler(s3Event());

    assert.deepEqual(result, { outcome: 'stray_deleted', mediaId: MEDIA_ID });
    assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: KEY }]);
    assert.equal(s3.commandCalls(HeadObjectCommand).length, 0);
    assert.equal(updates().length, 0);
  });

  test('a status changed concurrently (lost conditional update) is not an error', async () => {
    givenItem(mediaItem());
    givenObject();
    ddb.on(UpdateCommand).rejects(conditionFailed());
    assert.deepEqual(await handler(s3Event()), { outcome: 'skipped', mediaId: MEDIA_ID });

    givenObject({ bytes: NOT_MEDIA.html });
    const rejected = await handler(s3Event());
    assert.equal(rejected.outcome, 'skipped');
    assert.equal(deletedObjects().length, 1);
  });

  test('an object deleted in the meantime is not an error', async () => {
    givenItem(mediaItem());
    s3.on(HeadObjectCommand).rejects(new NotFound({ message: 'Not Found', $metadata: { httpStatusCode: 404 } }));
    assert.deepEqual(await handler(s3Event()), { outcome: 'object_missing', mediaId: MEDIA_ID });

    s3.on(HeadObjectCommand).resolves({ ContentType: 'image/png', ContentLength: 2048 });
    s3.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'The specified key does not exist.', $metadata: { httpStatusCode: 404 } }),
    );
    assert.deepEqual(await handler(s3Event()), { outcome: 'object_missing', mediaId: MEDIA_ID });
    assert.equal(updates().length, 0);
    assert.deepEqual(deletedObjects(), []);
  });

  test('other errors are rethrown so that EventBridge retries the event', async () => {
    const accessDenied = new S3ServiceException({
      name: 'AccessDenied',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
      message: 'Access Denied',
    });
    givenItem(mediaItem());
    s3.on(HeadObjectCommand).rejects(accessDenied);
    await assert.rejects(handler(s3Event()), { name: 'AccessDenied' });

    givenObject();
    ddb.on(UpdateCommand).rejects(new Error('DynamoDB unavailable'));
    await assert.rejects(handler(s3Event()), /DynamoDB unavailable/);

    ddb.on(GetCommand).rejects(
      new ProvisionedThroughputExceededException({ message: 'Rate exceeded', $metadata: {} }),
    );
    await assert.rejects(handler(s3Event()), { name: 'ProvisionedThroughputExceededException' });

    givenItem(null);
    s3.on(DeleteObjectCommand).rejects(new Error('S3 unavailable'));
    await assert.rejects(handler(s3Event()), /S3 unavailable/);
  });

  test('events of another bucket are ignored (nothing read or deleted)', async () => {
    const result = await handler(s3Event(KEY, { bucket: 'someone-elses-bucket' }));

    assert.deepEqual(result, { outcome: 'ignored' });
    assert.equal(ddb.calls().length, 0);
    assert.equal(s3.calls().length, 0);
  });

  test('malformed events are ignored', async () => {
    const malformed = [
      undefined,
      {},
      { detail: {} },
      { detail: { bucket: { name: BUCKET }, object: {} } },
      { detail: { bucket: { name: BUCKET }, object: { key: '' } } },
      { detail: { bucket: {}, object: { key: KEY } } },
      { detail: { bucket: { name: BUCKET }, object: { key: 42 } } },
    ];
    for (const event of malformed) {
      assert.deepEqual(await handler(event), { outcome: 'ignored' }, JSON.stringify(event));
    }
    assert.equal(ddb.calls().length, 0);
    assert.equal(s3.calls().length, 0);
  });
});

describe('validated objects and retries', () => {
  test('a valid upload is tagged (CloudFront serves tagged objects only) before the media becomes ready', async () => {
    givenItem(mediaItem());
    givenObject({ contentType: 'image/png', bytes: SAMPLES['image/png'] });
    const order = [];
    s3.on(PutObjectTaggingCommand).callsFake((input) => {
      order.push(['tag', input]);
      return {};
    });
    ddb.on(UpdateCommand).callsFake(() => {
      order.push(['update-item']);
      return {};
    });

    const result = await handler(s3Event());
    assert.equal(result.outcome, 'ready');
    assert.deepEqual(order.map(([step]) => step), ['tag', 'update-item']);
    assert.deepEqual(order[0][1], {
      Bucket: BUCKET,
      Key: KEY,
      Tagging: { TagSet: [{ Key: 'blogify-status', Value: 'ready' }] },
    });
  });

  test('a failed rejection update is retried: the second attempt ends rejected with the object deleted', async () => {
    givenItem(mediaItem());
    givenObject({ contentType: 'image/jpeg', bytes: SAMPLES['image/jpeg'] });
    ddb.on(UpdateCommand).rejectsOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' })).resolves({});

    await assert.rejects(handler(s3Event()), /throttled/);
    assert.equal(s3.commandCalls(DeleteObjectCommand).length, 0, 'the object is kept until the media is marked');

    const result = await handler(s3Event());
    assert.equal(result.outcome, 'rejected');
    assert.deepEqual(deletedObjects(), [{ Bucket: BUCKET, Key: KEY }]);
  });
});
