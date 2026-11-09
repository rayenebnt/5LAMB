import '../helpers/env.mjs';
import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import {
  ALLOWED_CONTENT_TYPES,
  canManageMedia,
  canViewMedia,
  maxBytesFor,
  MEDIA_TYPES,
  mediaObjectKey,
  mediaTypeOf,
  normalizeContentType,
  sanitizeFilename,
  toApiMedia,
} from '../../src/domain/media.mjs';
import { handler, routes } from '../../src/functions/media/index.mjs';
import { decodeCursor } from '../../src/lib/db.mjs';
import { apiEvent, lambdaContext, parse, users } from '../helpers/events.mjs';
import { installTestVerifier, signIdToken } from '../helpers/jwt.mjs';
import { apiRoutes } from '../helpers/template.mjs';

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const MiB = 1024 * 1024;
const BUCKET = 'blogify-test-media';
const MEDIA_ID = '0192f5a1-7c2b-7d3e-8f40-123456789abc';
const SECOND_ID = '0192f5a1-7c2b-7d3e-8f40-123456789abd';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG_VARIABLES = [
  'MEDIA_CDN_DOMAIN',
  'MAX_IMAGE_MB',
  'MAX_VIDEO_MB',
  'UPLOAD_URL_TTL_SECONDS',
  'DOWNLOAD_URL_TTL_SECONDS',
];
/** Item attributes that must never appear in an API response. */
const INTERNAL_ATTRIBUTES = [
  'PK',
  'SK',
  'GSI1PK',
  'GSI1SK',
  'GSI2PK',
  'GSI2SK',
  'entityType',
  'expiresAt',
  's3Key',
  'mediaId',
  'ownerId',
  'ownerName',
];

const call = (options) => handler(apiEvent(options), lambdaContext);
const isNear = (actual, expected, tolerance = 5000) => Math.abs(actual - expected) <= tolerance;
const epochSeconds = () => Math.floor(Date.now() / 1000);
const tokenOf = (user) => signIdToken(user);

/** Media item as stored in DynamoDB (ready image of the guest author by default). */
function mediaItem(overrides = {}) {
  const mediaId = overrides.mediaId ?? MEDIA_ID;
  const ownerId = overrides.ownerId ?? users.author.userId;
  const createdAt = '2026-10-27T10:00:00.000Z';
  return {
    PK: `MEDIA#${mediaId}`,
    SK: 'MEDIA',
    GSI1PK: 'MEDIA',
    GSI1SK: `${createdAt}#${mediaId}`,
    GSI2PK: `USER#${ownerId}`,
    GSI2SK: `MEDIA#${createdAt}#${mediaId}`,
    entityType: 'MEDIA',
    mediaId,
    ownerId,
    ownerName: 'Gaby Guest',
    filename: 'photo.png',
    contentType: 'image/png',
    kind: 'image',
    size: 2048,
    status: 'ready',
    s3Key: `media/${mediaId}/photo.png`,
    altText: 'Une photo',
    rejectionReason: null,
    createdAt,
    updatedAt: '2026-10-27T10:00:05.000Z',
    ...overrides,
  };
}

const givenItem = (item) => ddb.on(GetCommand).resolves(item ? { Item: item } : {});
const inputsOf = (mock, command) => mock.commandCalls(command).map((c) => c.args[0].input);
const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

function assertNoInternals(media) {
  for (const name of INTERNAL_ATTRIBUTES) assert.ok(!(name in media), `${name} must not be exposed`);
}

before(() => installTestVerifier());

beforeEach(() => {
  ddb.reset();
  s3.reset();
  for (const name of CONFIG_VARIABLES) delete process.env[name];
});

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

describe('media helpers', () => {
  test('accepted types map to a kind and a fixed extension; SVG is refused', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(MEDIA_TYPES).map(([type, { kind, extension }]) => [type, `${kind}/${extension}`])),
      {
        'image/jpeg': 'image/jpg',
        'image/png': 'image/png',
        'image/gif': 'image/gif',
        'image/webp': 'image/webp',
        'image/avif': 'image/avif',
        'video/mp4': 'video/mp4',
        'video/webm': 'video/webm',
        'video/quicktime': 'video/mov',
      },
    );
    assert.deepEqual(ALLOWED_CONTENT_TYPES, Object.keys(MEDIA_TYPES));
    assert.ok(Object.isFrozen(MEDIA_TYPES) && Object.isFrozen(MEDIA_TYPES['image/png']));
    for (const refused of ['image/svg+xml', 'text/html', 'application/pdf', 'image/jpg', '', 'constructor', '__proto__']) {
      assert.equal(mediaTypeOf(refused), null, refused);
    }
  });

  test('normalizeContentType lowercases and drops parameters', () => {
    assert.equal(normalizeContentType(' Image/PNG ; charset=binary'), 'image/png');
    assert.equal(normalizeContentType('VIDEO/QuickTime'), 'video/quicktime');
    assert.equal(normalizeContentType(undefined), '');
  });

  test('maxBytesFor follows MAX_IMAGE_MB / MAX_VIDEO_MB', () => {
    assert.equal(maxBytesFor('image'), 10 * MiB);
    assert.equal(maxBytesFor('video'), 200 * MiB);
    process.env.MAX_IMAGE_MB = '2';
    process.env.MAX_VIDEO_MB = '500';
    assert.equal(maxBytesFor('image'), 2 * MiB);
    assert.equal(maxBytesFor('video'), 500 * MiB);
  });

  test('sanitizeFilename keeps a slug of the base name and the extension of the content type', () => {
    const cases = [
      [['Mon Schéma.PNG', 'png'], 'mon-schema.png'],
      [['C:\\Users\\moi\\Vacances été 2026.jpeg', 'jpg'], 'vacances-ete-2026.jpg'],
      [['../../etc/passwd', 'png'], 'passwd.png'],
      [['index.html', 'gif'], 'index.gif'],
      [['archive.tar.gz', 'webp'], 'archive-tar.webp'],
      [['Photo (1) — final!!.JPG', 'jpg'], 'photo-1-final.jpg'],
      [['.htaccess', 'png'], 'htaccess.png'],
      [['no-extension', 'mp4'], 'no-extension.mp4'],
      [['...', 'gif'], 'file.gif'],
      [['🚀🚀.png', 'png'], 'file.png'],
      [['', 'mov'], 'file.mov'],
      [['dossier/', 'png'], 'file.png'],
    ];
    for (const [[filename, extension], expected] of cases) {
      assert.equal(sanitizeFilename(filename, extension), expected, filename);
    }
    const long = sanitizeFilename(`${'mot '.repeat(60)}.png`, 'png');
    assert.ok(long.length <= 84, long);
    assert.match(long, /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/);
    assert.equal(mediaObjectKey(MEDIA_ID, 'photo.png'), `media/${MEDIA_ID}/photo.png`);
  });

  test('toApiMedia exposes the public representation only', () => {
    const ready = toApiMedia(mediaItem(), { url: 'https://cdn.example.com/x', urlExpiresAt: '2026-10-27T11:00:00.000Z' });
    assert.deepEqual(ready, {
      id: MEDIA_ID,
      filename: 'photo.png',
      contentType: 'image/png',
      kind: 'image',
      size: 2048,
      status: 'ready',
      altText: 'Une photo',
      url: 'https://cdn.example.com/x',
      urlExpiresAt: '2026-10-27T11:00:00.000Z',
      owner: { id: users.author.userId, name: 'Gaby Guest' },
      createdAt: '2026-10-27T10:00:00.000Z',
      updatedAt: '2026-10-27T10:00:05.000Z',
    });
    assertNoInternals(ready);

    const pending = toApiMedia(mediaItem({ status: 'pending', altText: undefined, expiresAt: 1 }));
    assert.equal(pending.url, null);
    assert.equal(pending.altText, null);
    assert.ok(!('urlExpiresAt' in pending) && !('rejectionReason' in pending));

    const rejected = toApiMedia(mediaItem({ status: 'rejected', rejectionReason: 'Too big' }));
    assert.equal(rejected.rejectionReason, 'Too big');
    assert.equal(rejected.url, null);
  });

  test('visibility and management rules', () => {
    const ready = mediaItem();
    const pending = mediaItem({ status: 'pending' });
    const rejected = mediaItem({ status: 'rejected' });
    assert.equal(canViewMedia(null, ready), true);
    assert.equal(canViewMedia(users.author2, ready), true);
    for (const item of [pending, rejected]) {
      assert.equal(canViewMedia(null, item), false);
      assert.equal(canViewMedia(users.author2, item), false);
      assert.equal(canViewMedia(users.noRole, item), false);
      assert.equal(canViewMedia(users.author, item), true);
      assert.equal(canViewMedia(users.editor, item), true);
      assert.equal(canViewMedia(users.admin, item), true);
    }
    assert.equal(canViewMedia(users.admin, null), false);

    assert.equal(canManageMedia(users.author, ready), true);
    assert.equal(canManageMedia(users.editor, ready), true);
    assert.equal(canManageMedia(users.admin, ready), true);
    assert.equal(canManageMedia(users.author2, ready), false);
    assert.equal(canManageMedia(null, ready), false);
    // An owner who lost the right to upload (no role any more) cannot manage their media.
    assert.equal(canManageMedia(users.noRole, mediaItem({ ownerId: users.noRole.userId })), false);
  });
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

test('routes match the MediaFunction API events of template.yaml', () => {
  const templateRoutes = apiRoutes().filter((route) => route.codeUri === 'dist/media/');
  assert.deepEqual(Object.keys(routes).sort(), templateRoutes.map((route) => route.routeKey).sort());
  for (const route of templateRoutes) {
    assert.equal(routes[route.routeKey].auth, route.publicRoute ? 'optional' : 'required', route.routeKey);
  }
});

// ---------------------------------------------------------------------------
// POST /media
// ---------------------------------------------------------------------------

describe('POST /media', () => {
  const upload = (body, as = users.author) => call({ method: 'POST', resource: '/media', body, as });
  const decodePolicy = (fields) => JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8'));

  beforeEach(() => ddb.on(PutCommand).resolves({}));

  test('registers a pending media and returns a presigned POST form', async () => {
    const res = await upload({
      filename: 'Mon Schéma.PNG',
      contentType: 'image/png',
      size: 2048,
      altText: '  Schéma de l’architecture  ',
    });

    assert.equal(res.statusCode, 201, res.body);
    const { upload: form, createdAt, updatedAt, ...media } = parse(res);
    assert.match(media.id, UUID_V7);
    assert.equal(res.headers.Location, `/media/${media.id}`);
    assert.deepEqual(media, {
      id: media.id,
      filename: 'mon-schema.png',
      contentType: 'image/png',
      kind: 'image',
      size: 2048,
      status: 'pending',
      altText: 'Schéma de l’architecture',
      url: null,
      owner: { id: users.author.userId, name: users.author.name },
    });
    assert.equal(createdAt, updatedAt);
    assert.ok(isNear(Date.parse(createdAt), Date.now()));

    const [put] = inputsOf(ddb, PutCommand);
    assert.equal(put.TableName, 'blogify-test');
    assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)');
    const { expiresAt, ...item } = put.Item;
    assert.deepEqual(item, {
      PK: `MEDIA#${media.id}`,
      SK: 'MEDIA',
      GSI1PK: 'MEDIA',
      GSI1SK: `${createdAt}#${media.id}`,
      GSI2PK: `USER#${users.author.userId}`,
      GSI2SK: `MEDIA#${createdAt}#${media.id}`,
      entityType: 'MEDIA',
      mediaId: media.id,
      ownerId: users.author.userId,
      ownerName: users.author.name,
      filename: 'mon-schema.png',
      contentType: 'image/png',
      kind: 'image',
      size: 2048,
      status: 'pending',
      s3Key: `media/${media.id}/mon-schema.png`,
      altText: 'Schéma de l’architecture',
      rejectionReason: null,
      createdAt,
      updatedAt,
    });
    assert.ok(isNear(expiresAt, epochSeconds() + 24 * 3600, 5), 'pending uploads expire after one day');

    assert.equal(form.method, 'POST');
    const url = new URL(form.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(url.hostname.startsWith(`${BUCKET}.s3`), url.hostname);
    assert.equal(form.fields.key, `media/${media.id}/mon-schema.png`);
    assert.equal(form.fields['Content-Type'], 'image/png');
    assert.equal(form.fields['X-Amz-Algorithm'], 'AWS4-HMAC-SHA256');
    assert.match(form.fields['X-Amz-Signature'], /^[0-9a-f]{64}$/);
    assert.ok(isNear(Date.parse(form.expiresAt), Date.now() + 900 * 1000));
    assertNoInternals(media);
  });

  test('the presigned POST policy pins the bucket, the key, the content type and the size', async () => {
    const res = await upload({ filename: 'clip.mov', contentType: 'video/quicktime', size: 5 * MiB });

    const { id, upload: form } = parse(res);
    const policy = decodePolicy(form.fields);
    const arrays = policy.conditions.filter(Array.isArray);
    assert.deepEqual(
      arrays.find((condition) => condition[0] === 'content-length-range'),
      ['content-length-range', 1, 5 * MiB],
    );
    assert.deepEqual(
      arrays.find((condition) => condition[0] === 'eq'),
      ['eq', '$Content-Type', 'video/quicktime'],
    );
    const exact = Object.assign({}, ...policy.conditions.filter((condition) => !Array.isArray(condition)));
    assert.equal(exact.bucket, BUCKET);
    assert.equal(exact.key, `media/${id}/clip.mov`);
    assert.equal(exact['Content-Type'], 'video/quicktime');
    assert.ok(isNear(Date.parse(policy.expiration), Date.now() + 900 * 1000));
    assert.ok(Date.parse(policy.expiration) >= Date.parse(form.expiresAt) - 1000);
  });

  test('the upload form lifetime follows UPLOAD_URL_TTL_SECONDS', async () => {
    process.env.UPLOAD_URL_TTL_SECONDS = '120';

    const { upload: form } = parse(await upload({ filename: 'a.gif', contentType: 'image/gif', size: 10 }));

    assert.ok(isNear(Date.parse(decodePolicy(form.fields).expiration), Date.now() + 120 * 1000));
    assert.ok(isNear(Date.parse(form.expiresAt), Date.now() + 120 * 1000));
  });

  test('videos may exceed the image limit, up to the video limit', async () => {
    const res = await upload({ filename: 'Démo.MP4', contentType: 'video/mp4', size: 150 * MiB });

    assert.equal(res.statusCode, 201, res.body);
    const body = parse(res);
    assert.equal(body.kind, 'video');
    assert.equal(body.filename, 'demo.mp4');
    assert.deepEqual(
      decodePolicy(body.upload.fields).conditions.find((c) => c[0] === 'content-length-range'),
      ['content-length-range', 1, 150 * MiB],
    );
  });

  test('content types are case-insensitive and the stored name never keeps the client extension', async () => {
    const jpeg = parse(await upload({ filename: 'Vacances.JPEG', contentType: ' IMAGE/JPEG ', size: 10 }));
    assert.equal(jpeg.contentType, 'image/jpeg');
    assert.equal(jpeg.filename, 'vacances.jpg');
    assert.equal(jpeg.upload.fields['Content-Type'], 'image/jpeg');

    assert.equal(parse(await upload({ filename: '../../etc/passwd', contentType: 'image/png', size: 10 })).filename, 'passwd.png');
    assert.equal(parse(await upload({ filename: 'evil.html', contentType: 'image/gif', size: 10 })).filename, 'evil.gif');
    assert.equal(parse(await upload({ filename: '🚀.webp', contentType: 'image/webp', size: 10 })).filename, 'file.webp');
  });

  test('editors and administrators can upload; the media belongs to them', async () => {
    for (const user of [users.editor, users.admin]) {
      const res = await upload({ filename: 'a.avif', contentType: 'image/avif', size: 10 }, user);
      assert.equal(res.statusCode, 201, user.name);
      assert.deepEqual(parse(res).owner, { id: user.userId, name: user.name });
    }
  });

  test('unsupported content types (including SVG) -> 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const refused = [
      'image/svg+xml',
      'text/html',
      'application/pdf',
      'application/octet-stream',
      'image/jpg',
      'image/heic',
      'constructor',
      '__proto__',
    ];
    for (const contentType of refused) {
      const res = await upload({ filename: 'x.png', contentType, size: 10 });
      assert.equal(res.statusCode, 415, contentType);
      const { error } = parse(res);
      assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE', contentType);
      assert.match(error.message, /image\/jpeg, image\/png/);
    }
    assert.equal(ddb.commandCalls(PutCommand).length, 0);
  });

  test('declared sizes above the limit of the kind -> 413 PAYLOAD_TOO_LARGE (limits are inclusive)', async () => {
    assert.equal((await upload({ filename: 'a.png', contentType: 'image/png', size: 10 * MiB })).statusCode, 201);
    const image = await upload({ filename: 'a.png', contentType: 'image/png', size: 10 * MiB + 1 });
    assert.equal(image.statusCode, 413);
    assert.deepEqual(parse(image).error, {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The maximum size of image files is 10 MB (10485760 bytes)',
    });

    assert.equal((await upload({ filename: 'v.webm', contentType: 'video/webm', size: 200 * MiB })).statusCode, 201);
    assert.equal((await upload({ filename: 'v.webm', contentType: 'video/webm', size: 200 * MiB + 1 })).statusCode, 413);

    process.env.MAX_IMAGE_MB = '1';
    const configured = await upload({ filename: 'a.png', contentType: 'image/png', size: 2 * MiB });
    assert.equal(configured.statusCode, 413);
    assert.match(parse(configured).error.message, /1 MB/);
    assert.equal(ddb.commandCalls(PutCommand).length, 2);
  });

  test('invalid bodies -> 400 VALIDATION_ERROR listing every faulty field', async () => {
    const valid = { filename: 'a.png', contentType: 'image/png', size: 10 };
    const cases = [
      [{}, ['contentType', 'filename', 'size']],
      [{ ...valid, filename: '   ' }, ['filename']],
      [{ ...valid, filename: 'x'.repeat(201) }, ['filename']],
      [{ ...valid, filename: 42 }, ['filename']],
      [{ ...valid, contentType: '' }, ['contentType']],
      [{ ...valid, contentType: 'x'.repeat(101) }, ['contentType']],
      [{ ...valid, size: 0 }, ['size']],
      [{ ...valid, size: -5 }, ['size']],
      [{ ...valid, size: 1.5 }, ['size']],
      [{ ...valid, size: '2048' }, ['size']],
      [{ ...valid, size: null }, ['size']],
      [{ ...valid, altText: 'x'.repeat(301) }, ['altText']],
      [{ ...valid, altText: 42 }, ['altText']],
      [{ ...valid, status: 'ready' }, ['(root)']],
      [{ ...valid, ownerId: users.admin.userId }, ['(root)']],
      [{ ...valid, s3Key: 'media/x/evil.html' }, ['(root)']],
    ];
    for (const [body, fields] of cases) {
      const res = await upload(body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      const { error } = parse(res);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.deepEqual([...new Set(error.details.map((d) => d.field))].sort(), fields, JSON.stringify(body));
    }
    assert.equal(ddb.commandCalls(PutCommand).length, 0);
  });

  test('malformed JSON -> 400, non-JSON content type -> 415', async () => {
    assert.equal((await upload('{"filename": ')).statusCode, 400);
    assert.equal((await upload('["a.png"]')).statusCode, 400);
    const form = await call({
      method: 'POST',
      resource: '/media',
      body: 'filename=a.png',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      as: users.author,
    });
    assert.equal(form.statusCode, 415);
  });

  test('blank or null alternative texts are stored as null', async () => {
    for (const altText of ['   ', null]) {
      ddb.resetHistory();
      const res = await upload({ filename: 'a.png', contentType: 'image/png', size: 10, altText });
      assert.equal(parse(res).altText, null);
      assert.equal(inputsOf(ddb, PutCommand)[0].Item.altText, null);
    }
  });

  test('anonymous -> 401; users without MEDIA_UPLOAD -> 403', async () => {
    const body = { filename: 'a.png', contentType: 'image/png', size: 10 };
    const anonymous = await call({ method: 'POST', resource: '/media', body });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(parse(anonymous).error.code, 'UNAUTHORIZED');

    const noRole = await upload(body, users.noRole);
    assert.equal(noRole.statusCode, 403);
    assert.equal(parse(noRole).error.code, 'FORBIDDEN');
    assert.equal(ddb.commandCalls(PutCommand).length, 0);
  });

  test('unexpected DynamoDB errors -> 500 without internal details', async () => {
    ddb.on(PutCommand).rejects(new Error('arn:aws:dynamodb:eu-west-3:123456789012:table/secret'));

    const res = await upload({ filename: 'a.png', contentType: 'image/png', size: 10 });

    assert.equal(res.statusCode, 500);
    assert.equal(parse(res).error.code, 'INTERNAL_ERROR');
    assert.ok(!res.body.includes('secret'));
  });
});

// ---------------------------------------------------------------------------
// GET /media/{mediaId}
// ---------------------------------------------------------------------------

describe('GET /media/{mediaId}', () => {
  const getMedia = (mediaId, options = {}) => call({ resource: '/media/{mediaId}', params: { mediaId }, ...options });

  test('a ready media is public and served by the CDN when configured', async () => {
    process.env.MEDIA_CDN_DOMAIN = 'cdn.example.com';
    givenItem(mediaItem());

    const res = await getMedia(MEDIA_ID);

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      id: MEDIA_ID,
      filename: 'photo.png',
      contentType: 'image/png',
      kind: 'image',
      size: 2048,
      status: 'ready',
      altText: 'Une photo',
      url: `https://cdn.example.com/media/${MEDIA_ID}/photo.png`,
      owner: { id: users.author.userId, name: 'Gaby Guest' },
      createdAt: '2026-10-27T10:00:00.000Z',
      updatedAt: '2026-10-27T10:00:05.000Z',
    });
    assert.match(res.headers['Cache-Control'], /^public, max-age=60/);
    assert.deepEqual(inputsOf(ddb, GetCommand)[0], {
      TableName: 'blogify-test',
      Key: { PK: `MEDIA#${MEDIA_ID}`, SK: 'MEDIA' },
      ConsistentRead: false,
    });
  });

  test('a CDN domain configured with a scheme or a trailing slash still gives a clean URL', async () => {
    process.env.MEDIA_CDN_DOMAIN = 'https://d111111abcdef8.cloudfront.net/';
    givenItem(mediaItem());

    const { url } = parse(await getMedia(MEDIA_ID));

    assert.equal(url, `https://d111111abcdef8.cloudfront.net/media/${MEDIA_ID}/photo.png`);
  });

  test('without CDN, ready media get a presigned S3 GET URL and its expiry date', async () => {
    givenItem(mediaItem());

    const body = parse(await getMedia(MEDIA_ID));

    const url = new URL(body.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(url.hostname.startsWith(`${BUCKET}.s3`), url.hostname);
    assert.equal(url.pathname, `/media/${MEDIA_ID}/photo.png`);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
    assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
    assert.ok(isNear(Date.parse(body.urlExpiresAt), Date.now() + 3600 * 1000));
    assert.equal(s3.calls().length, 0, 'presigning is local, S3 is not called');

    process.env.DOWNLOAD_URL_TTL_SECONDS = '600';
    const shorter = parse(await getMedia(MEDIA_ID));
    assert.equal(new URL(shorter.url).searchParams.get('X-Amz-Expires'), '600');
    assert.ok(isNear(Date.parse(shorter.urlExpiresAt), Date.now() + 600 * 1000));
  });

  test('authenticated readers get private cache headers', async () => {
    givenItem(mediaItem());

    const res = await getMedia(MEDIA_ID, { token: tokenOf(users.author2) });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
  });

  test('pending media: visible to the owner and to editors/admins only (404 otherwise)', async () => {
    givenItem(mediaItem({ status: 'pending', altText: null, expiresAt: 1793095200 }));

    assert.equal((await getMedia(MEDIA_ID)).statusCode, 404);
    for (const user of [users.author2, users.noRole]) {
      const res = await getMedia(MEDIA_ID, { token: tokenOf(user) });
      assert.equal(res.statusCode, 404, user.name);
      assert.equal(parse(res).error.code, 'NOT_FOUND');
    }

    const owner = await getMedia(MEDIA_ID, { token: tokenOf(users.author) });
    assert.equal(owner.statusCode, 200);
    const body = parse(owner);
    assert.equal(body.status, 'pending');
    assert.equal(body.url, null);
    assert.ok(!('urlExpiresAt' in body) && !('rejectionReason' in body));
    assertNoInternals(body);
    assert.equal(owner.headers['Cache-Control'], 'private, no-store');

    for (const user of [users.editor, users.admin]) {
      assert.equal((await getMedia(MEDIA_ID, { token: tokenOf(user) })).statusCode, 200, user.name);
    }
  });

  test('rejected media: the owner sees the rejection reason, anonymous readers get 404', async () => {
    givenItem(mediaItem({ status: 'rejected', rejectionReason: 'File content is not a valid image/png file' }));

    assert.equal((await getMedia(MEDIA_ID)).statusCode, 404);
    const owner = parse(await getMedia(MEDIA_ID, { token: tokenOf(users.author) }));
    assert.equal(owner.status, 'rejected');
    assert.equal(owner.rejectionReason, 'File content is not a valid image/png file');
    assert.equal(owner.url, null);
  });

  test('unknown media -> 404; malformed id -> 400 without lookup; invalid token -> 401', async () => {
    givenItem(null);
    const unknown = await getMedia(MEDIA_ID);
    assert.equal(unknown.statusCode, 404);
    assert.equal(parse(unknown).error.code, 'NOT_FOUND');

    ddb.resetHistory();
    const malformed = await getMedia('not-a-uuid');
    assert.equal(malformed.statusCode, 400);
    assert.equal(parse(malformed).error.code, 'VALIDATION_ERROR');
    assert.equal(ddb.commandCalls(GetCommand).length, 0);

    const expired = signIdToken(users.author, { expiresIn: -60 });
    assert.equal((await getMedia(MEDIA_ID, { token: expired })).statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /media
// ---------------------------------------------------------------------------

describe('GET /media', () => {
  const list = (as, query = null) => call({ resource: '/media', as, query });
  const queries = () => inputsOf(ddb, QueryCommand);

  test('guest authors list their own media through GSI2, newest first', async () => {
    process.env.MEDIA_CDN_DOMAIN = 'cdn.example.com';
    ddb.on(QueryCommand).resolves({
      Items: [
        mediaItem({ mediaId: SECOND_ID, status: 'pending', altText: null }),
        mediaItem(),
        mediaItem({ mediaId: '0192f5a1-7c2b-7d3e-8f40-123456789abe', status: 'rejected', rejectionReason: 'Too big' }),
      ],
    });

    for (const query of [null, { owner: 'me' }, { owner: users.author.userId }]) {
      ddb.resetHistory();
      const res = await list(users.author, query);

      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers['Cache-Control'], 'private, no-store');
      const [input] = queries();
      assert.equal(input.TableName, 'blogify-test');
      assert.equal(input.IndexName, 'GSI2');
      assert.equal(input.KeyConditionExpression, 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)');
      assert.deepEqual(input.ExpressionAttributeValues, { ':pk': `USER#${users.author.userId}`, ':prefix': 'MEDIA#' });
      assert.equal(input.ScanIndexForward, false);
      assert.equal(input.Limit, 20);

      const page = parse(res);
      assert.equal(page.nextCursor, null);
      assert.deepEqual(page.items.map((m) => [m.id, m.status, m.url]), [
        [SECOND_ID, 'pending', null],
        [MEDIA_ID, 'ready', `https://cdn.example.com/media/${MEDIA_ID}/photo.png`],
        ['0192f5a1-7c2b-7d3e-8f40-123456789abe', 'rejected', null],
      ]);
      assert.equal(page.items[2].rejectionReason, 'Too big');
      page.items.forEach(assertNoInternals);
    }
  });

  test('presigned URLs are generated for every ready media of a page when there is no CDN', async () => {
    ddb.on(QueryCommand).resolves({ Items: [mediaItem(), mediaItem({ mediaId: SECOND_ID, s3Key: `media/${SECOND_ID}/photo.png` })] });

    const { items } = parse(await list(users.author));

    assert.deepEqual(items.map((m) => new URL(m.url).pathname), [`/media/${MEDIA_ID}/photo.png`, `/media/${SECOND_ID}/photo.png`]);
    assert.ok(items.every((m) => isNear(Date.parse(m.urlExpiresAt), Date.now() + 3600 * 1000)));
  });

  test('without MEDIA_READ_ANY, listing the media of another user -> 403', async () => {
    const res = await list(users.author, { owner: users.author2.userId });

    assert.equal(res.statusCode, 403);
    assert.equal(parse(res).error.code, 'FORBIDDEN');
    assert.equal(queries().length, 0);
  });

  test('users without any role can list their own (empty) library', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    const res = await list(users.noRole);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(parse(res), { items: [], nextCursor: null });
    assert.equal(queries()[0].ExpressionAttributeValues[':pk'], `USER#${users.noRole.userId}`);
  });

  test('editors list every media through GSI1, or one owner through GSI2', async () => {
    ddb.on(QueryCommand).resolves({ Items: [mediaItem()] });

    await list(users.editor);
    const [all] = queries();
    assert.equal(all.IndexName, 'GSI1');
    assert.equal(all.KeyConditionExpression, 'GSI1PK = :pk');
    assert.deepEqual(all.ExpressionAttributeValues, { ':pk': 'MEDIA' });
    assert.equal(all.ScanIndexForward, false);

    ddb.resetHistory();
    await list(users.editor, { owner: users.author.userId });
    assert.equal(queries()[0].IndexName, 'GSI2');
    assert.equal(queries()[0].ExpressionAttributeValues[':pk'], `USER#${users.author.userId}`);

    ddb.resetHistory();
    await list(users.admin, { owner: 'me' });
    assert.equal(queries()[0].IndexName, 'GSI2');
    assert.equal(queries()[0].ExpressionAttributeValues[':pk'], `USER#${users.admin.userId}`);
  });

  test('pagination with limit and an opaque cursor', async () => {
    const lastKey = {
      PK: `MEDIA#${SECOND_ID}`,
      SK: 'MEDIA',
      GSI2PK: `USER#${users.author.userId}`,
      GSI2SK: `MEDIA#2026-10-27T09:00:00.000Z#${SECOND_ID}`,
    };
    ddb.on(QueryCommand).resolves({ Items: [mediaItem(), mediaItem({ mediaId: SECOND_ID })], LastEvaluatedKey: lastKey });

    const first = parse(await list(users.author, { limit: '2' }));

    assert.equal(first.items.length, 2);
    assert.equal(queries()[0].Limit, 2);
    assert.deepEqual(decodeCursor(first.nextCursor, 'GSI2'), lastKey);

    ddb.resetHistory();
    await list(users.author, { limit: '2', cursor: first.nextCursor });
    assert.deepEqual(queries()[0].ExclusiveStartKey, lastKey);
  });

  test('invalid query strings -> 400', async () => {
    const cases = [
      { limit: '0' },
      { limit: '101' },
      { limit: 'abc' },
      { limit: '2.5' },
      { owner: 'bob' },
      { owner: '' },
      { sort: 'asc' },
      { cursor: 'not-a-valid-cursor' },
    ];
    for (const query of cases) {
      const res = await list(users.editor, query);
      assert.equal(res.statusCode, 400, JSON.stringify(query));
    }
    assert.equal(queries().length, 0);
  });

  test('anonymous -> 401', async () => {
    const res = await call({ resource: '/media' });

    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /media/{mediaId}
// ---------------------------------------------------------------------------

describe('PATCH /media/{mediaId}', () => {
  const patch = (mediaId, body, as) =>
    call({ method: 'PATCH', resource: '/media/{mediaId}', params: { mediaId }, body, as });

  test('the owner sets the alternative text', async () => {
    process.env.MEDIA_CDN_DOMAIN = 'cdn.example.com';
    givenItem(mediaItem());
    const updated = mediaItem({ altText: 'Nouveau texte', updatedAt: '2026-10-27T11:00:00.000Z' });
    ddb.on(UpdateCommand).resolves({ Attributes: updated });

    const res = await patch(MEDIA_ID, { altText: '  Nouveau texte  ' }, users.author);

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), toApiMedia(updated, { url: `https://cdn.example.com/media/${MEDIA_ID}/photo.png` }));
    assert.equal(inputsOf(ddb, GetCommand)[0].ConsistentRead, true);
    const [update] = inputsOf(ddb, UpdateCommand);
    assert.deepEqual(update.Key, { PK: `MEDIA#${MEDIA_ID}`, SK: 'MEDIA' });
    assert.equal(update.UpdateExpression, 'SET altText = :altText, updatedAt = :now');
    assert.equal(update.ConditionExpression, 'attribute_exists(PK)');
    assert.equal(update.ExpressionAttributeValues[':altText'], 'Nouveau texte');
    assert.ok(isNear(Date.parse(update.ExpressionAttributeValues[':now']), Date.now()));
    assert.equal(update.ReturnValues, 'ALL_NEW');
  });

  test('null or blank alternative texts clear it', async () => {
    givenItem(mediaItem());
    ddb.on(UpdateCommand).resolves({ Attributes: mediaItem({ altText: null }) });

    for (const altText of [null, '   ']) {
      ddb.resetHistory();
      const res = await patch(MEDIA_ID, { altText }, users.author);
      assert.equal(res.statusCode, 200);
      assert.equal(parse(res).altText, null);
      assert.equal(inputsOf(ddb, UpdateCommand)[0].ExpressionAttributeValues[':altText'], null);
    }
  });

  test('editors and administrators can edit any media, including pending ones', async () => {
    givenItem(mediaItem({ status: 'pending' }));
    ddb.on(UpdateCommand).resolves({ Attributes: mediaItem({ status: 'pending', altText: 'Revu' }) });

    for (const user of [users.editor, users.admin]) {
      const res = await patch(MEDIA_ID, { altText: 'Revu' }, user);
      assert.equal(res.statusCode, 200, user.name);
      assert.equal(parse(res).altText, 'Revu');
    }
  });

  test('other users: 403 on a public media, 404 on a media they cannot see', async () => {
    givenItem(mediaItem());
    const forbidden = await patch(MEDIA_ID, { altText: 'Pirate' }, users.author2);
    assert.equal(forbidden.statusCode, 403);
    assert.equal(parse(forbidden).error.code, 'FORBIDDEN');

    givenItem(mediaItem({ status: 'pending' }));
    assert.equal((await patch(MEDIA_ID, { altText: 'Pirate' }, users.author2)).statusCode, 404);

    // The owner lost the guest-author role: no MEDIA_UPLOAD any more.
    givenItem(mediaItem({ ownerId: users.noRole.userId }));
    assert.equal((await patch(MEDIA_ID, { altText: 'Texte' }, users.noRole)).statusCode, 403);
    assert.equal(ddb.commandCalls(UpdateCommand).length, 0);
  });

  test('unknown media -> 404; media deleted during the update -> 404', async () => {
    givenItem(null);
    assert.equal((await patch(MEDIA_ID, { altText: 'Texte' }, users.admin)).statusCode, 404);
    assert.equal(ddb.commandCalls(UpdateCommand).length, 0);

    givenItem(mediaItem());
    ddb.on(UpdateCommand).rejects(conditionFailed());
    const res = await patch(MEDIA_ID, { altText: 'Texte' }, users.author);
    assert.equal(res.statusCode, 404);
    assert.equal(parse(res).error.code, 'NOT_FOUND');
  });

  test('invalid requests -> 400 (body and path), anonymous -> 401', async () => {
    givenItem(mediaItem());
    const bodies = [
      {},
      { altText: 'x'.repeat(301) },
      { altText: 42 },
      { altText: 'ok', filename: 'evil.html' },
      { status: 'ready' },
    ];
    for (const body of bodies) {
      const res = await patch(MEDIA_ID, body, users.author);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(parse(res).error.code, 'VALIDATION_ERROR');
    }
    assert.equal((await patch('42', { altText: 'ok' }, users.author)).statusCode, 400);
    assert.equal(ddb.commandCalls(UpdateCommand).length, 0);

    const anonymous = await call({ method: 'PATCH', resource: '/media/{mediaId}', params: { mediaId: MEDIA_ID }, body: { altText: 'x' } });
    assert.equal(anonymous.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// DELETE /media/{mediaId}
// ---------------------------------------------------------------------------

describe('DELETE /media/{mediaId}', () => {
  const remove = (mediaId, as) => call({ method: 'DELETE', resource: '/media/{mediaId}', params: { mediaId }, as });

  beforeEach(() => {
    s3.on(DeleteObjectCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});
  });

  test('the owner deletes the S3 object, then the item', async () => {
    givenItem(mediaItem());
    const order = [];
    s3.on(DeleteObjectCommand).callsFake(() => {
      order.push('s3:DeleteObject');
      return {};
    });
    ddb.on(DeleteCommand).callsFake(() => {
      order.push('dynamodb:DeleteItem');
      return {};
    });

    const res = await remove(MEDIA_ID, users.author);

    assert.equal(res.statusCode, 204);
    assert.equal(res.body, '');
    assert.deepEqual(order, ['s3:DeleteObject', 'dynamodb:DeleteItem']);
    assert.deepEqual(inputsOf(s3, DeleteObjectCommand), [{ Bucket: BUCKET, Key: `media/${MEDIA_ID}/photo.png` }]);
    assert.deepEqual(inputsOf(ddb, DeleteCommand), [
      { TableName: 'blogify-test', Key: { PK: `MEDIA#${MEDIA_ID}`, SK: 'MEDIA' } },
    ]);
    assert.equal(inputsOf(ddb, GetCommand)[0].ConsistentRead, true);
  });

  test('editors and administrators delete media of other users, including pending ones', async () => {
    givenItem(mediaItem({ status: 'pending' }));

    for (const user of [users.editor, users.admin]) {
      assert.equal((await remove(MEDIA_ID, user)).statusCode, 204, user.name);
    }
    assert.equal(ddb.commandCalls(DeleteCommand).length, 2);
  });

  test('other users: 403 on a public media, 404 on a media they cannot see', async () => {
    givenItem(mediaItem());
    assert.equal((await remove(MEDIA_ID, users.author2)).statusCode, 403);

    givenItem(mediaItem({ status: 'rejected' }));
    assert.equal((await remove(MEDIA_ID, users.author2)).statusCode, 404);

    givenItem(mediaItem({ ownerId: users.noRole.userId }));
    assert.equal((await remove(MEDIA_ID, users.noRole)).statusCode, 403);

    assert.equal(s3.commandCalls(DeleteObjectCommand).length, 0);
    assert.equal(ddb.commandCalls(DeleteCommand).length, 0);
  });

  test('unknown media -> 404 without touching S3', async () => {
    givenItem(null);

    const res = await remove(MEDIA_ID, users.admin);

    assert.equal(res.statusCode, 404);
    assert.equal(s3.commandCalls(DeleteObjectCommand).length, 0);
  });

  test('an S3 failure keeps the item so that the deletion can be retried', async () => {
    givenItem(mediaItem());
    s3.on(DeleteObjectCommand).rejects(
      new S3ServiceException({ name: 'InternalError', $fault: 'server', $metadata: { httpStatusCode: 500 }, message: 'boom' }),
    );

    const res = await remove(MEDIA_ID, users.author);

    assert.equal(res.statusCode, 500);
    assert.equal(ddb.commandCalls(DeleteCommand).length, 0);
  });

  test('anonymous -> 401; malformed id -> 400', async () => {
    assert.equal((await call({ method: 'DELETE', resource: '/media/{mediaId}', params: { mediaId: MEDIA_ID } })).statusCode, 401);
    assert.equal((await remove('not-a-uuid', users.author)).statusCode, 400);
    assert.equal(ddb.calls().length, 0);
  });
});
