import '../helpers/env.mjs';
import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../../src/functions/posts-query/index.mjs';
import { decodeCursor, encodeCursor } from '../../src/lib/db.mjs';
import { apiEvent, lambdaContext, parse, users } from '../helpers/events.mjs';
import { installTestVerifier, signIdToken } from '../helpers/jwt.mjs';

const ddb = mockClient(DynamoDBDocumentClient);
before(() => installTestVerifier());
beforeEach(() => ddb.reset());

const TABLE = 'blogify-test';
const POST_ID = '0192f5a1-7c2b-7d3e-8f40-000000000001';
const CREATED = '2026-10-01T10:00:00.000Z';
const PUBLISHED = '2026-10-02T08:00:00.000Z';
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const NO_STORE = 'private, no-store';

function postItem(overrides = {}) {
  return {
    PK: `POST#${POST_ID}`,
    SK: 'POST',
    GSI1PK: 'POSTS#published',
    GSI1SK: `${PUBLISHED}#${POST_ID}`,
    GSI2PK: `USER#${users.author.userId}`,
    GSI2SK: `POST#${CREATED}#${POST_ID}`,
    entityType: 'POST',
    postId: POST_ID,
    slug: 'mon-article',
    title: 'Mon article',
    content: '# Bonjour\n\nLe **contenu** complet.',
    excerpt: 'Bonjour Le contenu complet.',
    customExcerpt: false,
    coverImageUrl: null,
    tags: ['aws', 'serverless'],
    status: 'published',
    allowComments: true,
    authorId: users.author.userId,
    authorName: users.author.name,
    readingTimeMinutes: 1,
    commentCount: 2,
    reviewNote: null,
    createdAt: CREATED,
    updatedAt: PUBLISHED,
    submittedAt: CREATED,
    publishedAt: PUBLISHED,
    version: 3,
    ...overrides,
  };
}

/** Index entry of a post (GSI INCLUDE projection: no content, no customExcerpt). */
function summaryItem(n, overrides = {}) {
  const postId = `0192f5a1-7c2b-7d3e-8f40-${String(n).padStart(12, '0')}`;
  const { content, customExcerpt, ...summary } = postItem({
    PK: `POST#${postId}`,
    postId,
    slug: `article-${n}`,
    title: `Article ${n}`,
    GSI1SK: `${PUBLISHED}#${postId}`,
    ...overrides,
  });
  return summary;
}

const call = (options) => handler(apiEvent(options), lambdaContext);
const getPost = (postId, options = {}) => call({ resource: '/posts/{postId}', params: { postId }, ...options });
const list = (query, options = {}) => call({ resource: '/posts', query, ...options });
const tokenOf = (user) => signIdToken(user);
const queries = () => ddb.commandCalls(QueryCommand).map((c) => c.args[0].input);
const gets = () => ddb.commandCalls(GetCommand).map((c) => c.args[0].input);

function assertError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode, response.body);
  if (code) assert.equal(parse(response).error.code, code);
}

// ---------------------------------------------------------------------------
// GET /posts/{postId}
// ---------------------------------------------------------------------------

describe('GET /posts/{postId}', () => {
  test('anonymous readers get a published post by id, with content, ETag and public caching', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    const res = await getPost(POST_ID);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers.ETag, '"v3"');
    assert.equal(res.headers['Cache-Control'], PUBLIC_CACHE);
    const post = parse(res);
    assert.equal(post.id, POST_ID);
    assert.equal(post.content, '# Bonjour\n\nLe **contenu** complet.');
    assert.deepEqual(post.author, { id: users.author.userId, name: users.author.name });
    for (const key of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entityType', 'customExcerpt']) {
      assert.equal(key in post, false, key);
    }
    assert.deepEqual(gets(), [{ TableName: TABLE, Key: { PK: `POST#${POST_ID}`, SK: 'POST' }, ConsistentRead: false }]);
  });

  test('a slug is resolved through its SLUG# item', async () => {
    ddb.on(GetCommand, { Key: { PK: 'SLUG#mon-article', SK: 'SLUG' } }).resolves({
      Item: { PK: 'SLUG#mon-article', SK: 'SLUG', entityType: 'SLUG', slug: 'mon-article', postId: POST_ID },
    });
    ddb.on(GetCommand, { Key: { PK: `POST#${POST_ID}`, SK: 'POST' } }).resolves({ Item: postItem() });
    const res = await getPost('mon-article');
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).id, POST_ID);
    assert.deepEqual(gets().map((input) => input.Key.PK), ['SLUG#mon-article', `POST#${POST_ID}`]);
  });

  test('unknown slug or id: 404', async () => {
    ddb.on(GetCommand).resolves({});
    assertError(await getPost('inconnu'), 404, 'NOT_FOUND');
    assert.equal(gets().length, 1);
    assertError(await getPost(POST_ID), 404, 'NOT_FOUND');
  });

  test('a slug pointing to a missing post: 404', async () => {
    ddb.on(GetCommand, { Key: { PK: 'SLUG#orphelin', SK: 'SLUG' } }).resolves({ Item: { postId: POST_ID } });
    ddb.on(GetCommand, { Key: { PK: `POST#${POST_ID}`, SK: 'POST' } }).resolves({});
    assertError(await getPost('orphelin'), 404, 'NOT_FOUND');
  });

  test('values that are neither a UUID nor a slug are 404 without database access', async () => {
    for (const value of ['Mon Article', 'UPPER', 'a--b', 'a'.repeat(81), '-x-']) {
      assertError(await getPost(value), 404, 'NOT_FOUND');
    }
    assert.equal(ddb.calls().length, 0);
  });

  test('upper-case ids are normalised', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    assert.equal((await getPost(POST_ID.toUpperCase())).statusCode, 200);
    assert.equal(gets()[0].Key.PK, `POST#${POST_ID}`);
  });

  test('unpublished posts: 404 for anonymous readers and other authors, visible to the author and editors', async () => {
    for (const status of ['draft', 'in_review', 'archived']) {
      ddb.reset();
      ddb.on(GetCommand).resolves({ Item: postItem({ status, GSI1PK: `POSTS#${status}` }) });
      assertError(await getPost(POST_ID), 404, 'NOT_FOUND');
      assertError(await getPost(POST_ID, { token: tokenOf(users.author2) }), 404, 'NOT_FOUND');
      assertError(await getPost(POST_ID, { token: tokenOf(users.noRole) }), 404, 'NOT_FOUND');
      for (const reader of [users.author, users.editor, users.admin]) {
        const res = await getPost(POST_ID, { token: tokenOf(reader) });
        assert.equal(res.statusCode, 200, `${status} / ${reader.name}`);
        assert.equal(res.headers['Cache-Control'], NO_STORE);
        assert.equal(parse(res).status, status);
      }
    }
  });

  test('authenticated readers of a published post get a private response', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    const res = await getPost(POST_ID, { token: tokenOf(users.author2) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], NO_STORE);
  });

  test('an invalid or expired token is a 401 (optional authentication)', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    assertError(await getPost(POST_ID, { token: signIdToken(users.author, { expiresIn: -60 }) }), 401, 'UNAUTHORIZED');
    assertError(await getPost(POST_ID, { headers: { Authorization: 'Bearer not-a-jwt' } }), 401, 'UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// GET /posts
// ---------------------------------------------------------------------------

describe('GET /posts', () => {
  test('default: published posts from GSI1, newest first, summaries only, public caching', async () => {
    const page = Array.from({ length: 10 }, (_, i) => summaryItem(i + 1));
    const lastKey = { PK: page[9].PK, SK: 'POST', GSI1PK: 'POSTS#published', GSI1SK: page[9].GSI1SK };
    ddb.on(QueryCommand).resolves({ Items: page, LastEvaluatedKey: lastKey });
    const res = await list(null);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['Cache-Control'], PUBLIC_CACHE);
    const body = parse(res);
    assert.deepEqual(Object.keys(body).sort(), ['items', 'nextCursor']);
    assert.deepEqual(body.items.map((p) => p.id), page.map((item) => item.postId));
    assert.equal(body.items[0].slug, 'article-1');
    assert.equal(queries().length, 1, 'a full page needs a single query');
    for (const item of body.items) {
      assert.equal('content' in item, false);
      assert.equal('PK' in item, false);
      assert.equal('GSI1PK' in item, false);
    }
    assert.deepEqual(decodeCursor(body.nextCursor, 'GSI1'), lastKey);

    const [query] = queries();
    assert.equal(query.TableName, TABLE);
    assert.equal(query.IndexName, 'GSI1');
    assert.equal(query.KeyConditionExpression, 'GSI1PK = :pk');
    assert.deepEqual(query.ExpressionAttributeValues, { ':pk': 'POSTS#published' });
    assert.equal(query.ScanIndexForward, false);
    assert.equal(query.Limit, 10);
    assert.equal(query.FilterExpression, undefined);
    assert.equal(query.ExclusiveStartKey, undefined);
  });

  test('limit and cursor are forwarded; the last page has a null cursor', async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryItem(1)] });
    const start = { PK: 'POST#a', SK: 'POST', GSI1PK: 'POSTS#published', GSI1SK: `${PUBLISHED}#a` };
    const res = await list({ limit: '5', cursor: encodeCursor(start) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).nextCursor, null);
    const [query] = queries();
    assert.equal(query.Limit, 5);
    assert.deepEqual(query.ExclusiveStartKey, start);
  });

  test('tag filter: tag memberships of GSI1 (normalised tag), mapped like posts', async () => {
    const membership = {
      ...summaryItem(1),
      PK: 'TAG#serverless-aws',
      SK: `POST#${summaryItem(1).postId}`,
      GSI1PK: 'TAG#serverless-aws',
      entityType: 'TAG_POST',
      tag: 'serverless-aws',
    };
    ddb.on(QueryCommand).resolves({ Items: [membership] });
    const res = await list({ tag: 'Serverless AWS' });
    assert.equal(res.statusCode, 200, res.body);
    const [item] = parse(res).items;
    assert.equal(item.id, summaryItem(1).postId);
    assert.equal('tag' in item, false);
    const [query] = queries();
    assert.equal(query.IndexName, 'GSI1');
    assert.deepEqual(query.ExpressionAttributeValues, { ':pk': 'TAG#serverless-aws' });
    assert.equal(query.FilterExpression, undefined);
  });

  test('tag + author: filtered on authorId', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    const res = await list({ tag: 'aws', author: users.author.userId });
    assert.equal(res.statusCode, 200, res.body);
    const [query] = queries();
    assert.equal(query.FilterExpression, 'authorId = :authorId');
    assert.deepEqual(query.ExpressionAttributeValues, { ':pk': 'TAG#aws', ':authorId': users.author.userId });
  });

  test('author: GSI2 of the author restricted to posts, filtered on the status', async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryItem(1)] });
    const res = await list({ author: users.author.userId });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['Cache-Control'], PUBLIC_CACHE);
    const [query] = queries();
    assert.equal(query.IndexName, 'GSI2');
    assert.equal(query.KeyConditionExpression, 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)');
    assert.equal(query.FilterExpression, '#status = :status');
    assert.deepEqual(query.ExpressionAttributeNames, { '#status': 'status' });
    assert.deepEqual(query.ExpressionAttributeValues, {
      ':pk': `USER#${users.author.userId}`,
      ':prefix': 'POST#',
      ':status': 'published',
    });
    assert.equal(query.ScanIndexForward, false);
  });

  test('author=me requires a token and lists the caller\'s posts (private response)', async () => {
    assertError(await list({ author: 'me' }), 401, 'UNAUTHORIZED');
    ddb.on(QueryCommand).resolves({ Items: [] });
    const res = await list({ author: 'me' }, { token: tokenOf(users.author2) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['Cache-Control'], NO_STORE);
    assert.equal(queries()[0].ExpressionAttributeValues[':pk'], `USER#${users.author2.userId}`);
  });

  test('unpublished statuses require a token', async () => {
    for (const status of ['draft', 'in_review', 'archived']) {
      assertError(await list({ status }), 401, 'UNAUTHORIZED');
    }
    assert.equal(ddb.calls().length, 0);
  });

  test('guest authors list their own unpublished posts only', async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryItem(1, { status: 'draft' })] });
    const token = tokenOf(users.author);
    for (const query of [{ status: 'draft' }, { status: 'draft', author: 'me' }, { status: 'draft', author: users.author.userId }]) {
      const res = await list(query, { token });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers['Cache-Control'], NO_STORE);
      assert.equal(parse(res).items[0].status, 'draft');
    }
    for (const input of queries()) {
      assert.equal(input.IndexName, 'GSI2');
      assert.equal(input.ExpressionAttributeValues[':pk'], `USER#${users.author.userId}`);
      assert.equal(input.ExpressionAttributeValues[':status'], 'draft');
    }
    assertError(await list({ status: 'draft', author: users.author2.userId }, { token }), 403, 'FORBIDDEN');
  });

  test('editors list any status (review queue) or any author', async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryItem(1, { status: 'in_review' })] });
    const token = tokenOf(users.editor);
    const queue = await list({ status: 'in_review' }, { token });
    assert.equal(queue.statusCode, 200, queue.body);
    assert.equal(parse(queue).items[0].status, 'in_review');
    assert.equal(parse(queue).items[0].content, undefined);
    assert.deepEqual(queries()[0].ExpressionAttributeValues, { ':pk': 'POSTS#in_review' });
    assert.equal(queries()[0].IndexName, 'GSI1');

    const byAuthor = await list({ status: 'archived', author: users.author.userId }, { token });
    assert.equal(byAuthor.statusCode, 200, byAuthor.body);
    assert.equal(queries()[1].IndexName, 'GSI2');
    assert.equal(queries()[1].ExpressionAttributeValues[':status'], 'archived');
  });

  test('the tag filter with an unpublished status is a 400', async () => {
    assertError(await list({ status: 'draft', tag: 'aws' }, { token: tokenOf(users.editor) }), 400, 'VALIDATION_ERROR');
    assert.equal(ddb.calls().length, 0);
  });

  test('authenticated published listings are private', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    const res = await list({ status: 'published' }, { token: tokenOf(users.author) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], NO_STORE);
  });

  test('invalid query strings are 400', async () => {
    const invalid = [
      { limit: '0' },
      { limit: '51' },
      { limit: 'abc' },
      { status: 'deleted' },
      { author: 'bob' },
      { tag: '!!!' },
      { tag: 'x'.repeat(41) },
      { sort: 'asc' },
    ];
    for (const query of invalid) {
      assertError(await list(query), 400, 'VALIDATION_ERROR');
    }
    assertError(await list({ cursor: 'not-a-cursor' }), 400, 'BAD_REQUEST');
    // A GSI2 cursor cannot be replayed on a GSI1 listing.
    const gsi2Cursor = encodeCursor({ PK: 'POST#a', SK: 'POST', GSI2PK: 'USER#u', GSI2SK: 'POST#x' });
    assertError(await list({ cursor: gsi2Cursor }), 400, 'BAD_REQUEST');
    assert.equal(ddb.calls().length, 0);
  });
});
