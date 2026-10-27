import '../helpers/env.mjs';
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { handler, routes } from '../../src/functions/comments/index.mjs';
import { decodeCursor, encodeCursor, indexKeys, keys } from '../../src/lib/db.mjs';
import { isUuid } from '../../src/lib/ids.mjs';
import { apiEvent, lambdaContext, parse, users } from '../helpers/events.mjs';
import { installTestVerifier, signIdToken } from '../helpers/jwt.mjs';
import { apiRoutes } from '../helpers/template.mjs';

const ddb = mockClient(DynamoDBDocumentClient);

const POST_ID = '01928c5e-7a4b-7c3d-8e9f-0a1b2c3d4e5f';
const OTHER_POST_ID = '01928c5e-7a4b-7c3d-8e9f-0a1b2c3d4e60';
const COMMENT_ID = '01928c5f-1111-7000-8000-000000000001';
const SECOND_COMMENT_ID = '01928c5f-1111-7000-8000-000000000002';
const CREATED_AT = '2026-10-20T10:00:00.000Z';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Fixtures: GetCommand is served from an in-memory table, writes are asserted on their inputs.
// ---------------------------------------------------------------------------

const table = new Map();
const keyOf = ({ PK, SK }) => `${PK}|${SK}`;
const seed = (...items) => items.forEach((item) => table.set(keyOf(item), structuredClone(item)));

function postItem(overrides = {}) {
  return {
    ...keys.post(POST_ID),
    ...indexKeys.postByStatus('published', '2026-10-01T08:00:00.000Z', POST_ID),
    entityType: 'POST',
    postId: POST_ID,
    slug: 'serverless-101',
    title: 'Serverless 101',
    status: 'published',
    allowComments: true,
    authorId: users.author.userId,
    authorName: users.author.name,
    commentCount: 1,
    version: 3,
    ...overrides,
  };
}

function commentItem(overrides = {}) {
  const { commentId = COMMENT_ID, status = 'approved', postId = POST_ID } = overrides;
  return {
    ...keys.comment(postId, commentId),
    ...indexKeys.commentByStatus(status, CREATED_AT, commentId),
    entityType: 'COMMENT',
    commentId,
    postId,
    postTitle: 'Serverless 101',
    parentId: null,
    body: 'Great article!',
    authorId: null,
    authorName: 'Reader',
    authorEmail: 'reader@example.com',
    status,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    moderatedBy: null,
    moderatedAt: null,
    ...overrides,
  };
}

/** TransactionCanceledException with one cancellation reason per transaction item. */
const canceled = (...codes) =>
  new TransactionCanceledException({
    message: `Transaction cancelled, please refer cancellation reasons for specific reasons [${codes.join(', ')}]`,
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const inputs = (Command) => ddb.commandCalls(Command).map((call) => call.args[0].input);
const call = (options) => handler(apiEvent(options), lambdaContext);
const tokenOf = (user) => signIdToken(user);

const listRequest = (options = {}) => ({
  method: 'GET',
  resource: '/posts/{postId}/comments',
  params: { postId: POST_ID },
  ...options,
});
const createRequest = (body, options = {}) => ({
  method: 'POST',
  resource: '/posts/{postId}/comments',
  params: { postId: POST_ID },
  body,
  ...options,
});
const moderateRequest = (body, options = {}) => ({
  method: 'PATCH',
  resource: '/posts/{postId}/comments/{commentId}',
  params: { postId: POST_ID, commentId: COMMENT_ID },
  body,
  as: users.editor,
  ...options,
});
const deleteRequest = (options = {}) => ({
  method: 'DELETE',
  resource: '/posts/{postId}/comments/{commentId}',
  params: { postId: POST_ID, commentId: COMMENT_ID },
  ...options,
});
const queueRequest = (options = {}) => ({ method: 'GET', resource: '/comments', as: users.editor, ...options });

function assertError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode, response.body);
  if (code) assert.equal(parse(response).error.code, code);
}

before(() => installTestVerifier());

beforeEach(() => {
  ddb.reset();
  table.clear();
  ddb.on(GetCommand).callsFake((input) => ({ Item: structuredClone(table.get(keyOf(input.Key))) }));
  ddb.on(PutCommand).resolves({});
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(QueryCommand).resolves({ Items: [] });
});

// ---------------------------------------------------------------------------

test('routes match the CommentsFunction events of template.yaml (keys and auth modes)', () => {
  const templateRoutes = apiRoutes().filter((route) => route.functionId === 'CommentsFunction');
  assert.deepEqual(Object.keys(routes).sort(), templateRoutes.map((route) => route.routeKey).sort());
  for (const route of templateRoutes) {
    assert.equal(routes[route.routeKey].auth, route.publicRoute ? 'optional' : 'required', route.routeKey);
  }
});

describe('GET /posts/{postId}/comments', () => {
  test('anonymous readers get approved comments, oldest first, without e-mail addresses', async () => {
    seed(postItem());
    const reply = commentItem({
      commentId: SECOND_COMMENT_ID,
      parentId: COMMENT_ID,
      authorId: users.author2.userId,
      authorName: users.author2.name,
      authorEmail: users.author2.email,
      body: 'Thanks!',
    });
    ddb.on(QueryCommand).resolves({ Items: [commentItem(), reply] });

    const res = await call(listRequest());
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      items: [
        {
          id: COMMENT_ID,
          postId: POST_ID,
          parentId: null,
          body: 'Great article!',
          author: { id: null, name: 'Reader' },
          status: 'approved',
          createdAt: CREATED_AT,
        },
        {
          id: SECOND_COMMENT_ID,
          postId: POST_ID,
          parentId: COMMENT_ID,
          body: 'Thanks!',
          author: { id: users.author2.userId, name: users.author2.name },
          status: 'approved',
          createdAt: CREATED_AT,
        },
      ],
      nextCursor: null,
    });
    assert.ok(!res.body.includes('@example.com'), 'e-mail addresses must never be public');
    assert.match(res.headers['Cache-Control'], /^public/);

    const [query] = inputs(QueryCommand);
    assert.equal(query.TableName, 'blogify-test');
    assert.equal(query.IndexName, undefined);
    assert.equal(query.KeyConditionExpression, 'PK = :pk AND begins_with(SK, :prefix)');
    assert.deepEqual(query.ExpressionAttributeValues, {
      ':pk': `POST#${POST_ID}`,
      ':prefix': 'COMMENT#',
      ':status': 'approved',
    });
    assert.deepEqual(query.ExpressionAttributeNames, { '#status': 'status' });
    assert.equal(query.FilterExpression, '#status = :status');
    assert.equal(query.ScanIndexForward, true);
  });

  test('pagination: opaque cursor out, ExclusiveStartKey in', async () => {
    seed(postItem());
    const lastKey = keys.comment(POST_ID, COMMENT_ID);
    ddb.on(QueryCommand).resolves({ Items: [commentItem()], LastEvaluatedKey: lastKey });

    const first = await call(listRequest({ query: { limit: '1' } }));
    assert.equal(first.statusCode, 200, first.body);
    const { nextCursor } = parse(first);
    assert.deepEqual(decodeCursor(nextCursor), lastKey);

    const second = await call(listRequest({ query: { limit: '1', cursor: nextCursor } }));
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(inputs(QueryCommand)[1].ExclusiveStartKey, lastKey);
  });

  test('the post id must be a UUID (slugs are not accepted)', async () => {
    const res = await call(listRequest({ params: { postId: 'serverless-101' } }));
    assertError(res, 400, 'VALIDATION_ERROR');
    assert.equal(parse(res).error.details[0].field, 'postId');
    assert.equal(ddb.commandCalls(GetCommand).length, 0);
  });

  test('unknown posts and posts invisible to the caller are reported as 404', async () => {
    assertError(await call(listRequest()), 404, 'NOT_FOUND');

    seed(postItem({ status: 'draft' }));
    assertError(await call(listRequest()), 404, 'NOT_FOUND');
    assertError(await call(listRequest({ token: tokenOf(users.author2) })), 404, 'NOT_FOUND');
    assert.equal(ddb.commandCalls(QueryCommand).length, 0);

    // The author of the post and editors (POST_READ_ANY) can see it.
    const own = await call(listRequest({ token: tokenOf(users.author) }));
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.headers['Cache-Control'], 'private, no-store');
    const editor = await call(listRequest({ token: tokenOf(users.editor) }));
    assert.equal(editor.statusCode, 200, editor.body);
  });

  test('statuses other than approved are reserved to moderators', async () => {
    seed(postItem());
    for (const status of ['pending', 'rejected', 'spam', 'all']) {
      assertError(await call(listRequest({ query: { status } })), 401, 'UNAUTHORIZED');
      assertError(await call(listRequest({ query: { status }, token: tokenOf(users.author) })), 403, 'FORBIDDEN');
      assertError(await call(listRequest({ query: { status }, token: tokenOf(users.noRole) })), 403, 'FORBIDDEN');
    }
    assert.equal(ddb.commandCalls(QueryCommand).length, 0);

    ddb.on(QueryCommand).resolves({ Items: [commentItem({ status: 'pending' })] });
    const res = await call(listRequest({ query: { status: 'pending' }, token: tokenOf(users.editor) }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(inputs(QueryCommand)[0].ExpressionAttributeValues[':status'], 'pending');
    const [item] = parse(res).items;
    assert.equal(item.status, 'pending');
    assert.equal(item.authorEmail, 'reader@example.com', 'moderators see the moderator representation');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
  });

  test('status=all lists every status without filter', async () => {
    seed(postItem());
    ddb.on(QueryCommand).resolves({
      Items: [commentItem({ status: 'spam' }), commentItem({ commentId: SECOND_COMMENT_ID, status: 'approved' })],
    });
    const res = await call(listRequest({ query: { status: 'all', limit: '50' }, token: tokenOf(users.admin) }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res).items.map((item) => item.status), ['spam', 'approved']);
    const [query] = inputs(QueryCommand);
    assert.equal(query.FilterExpression, undefined);
    assert.equal(query.ExpressionAttributeNames, undefined);
    assert.deepEqual(query.ExpressionAttributeValues, { ':pk': `POST#${POST_ID}`, ':prefix': 'COMMENT#' });
    assert.equal(query.Limit, 50);
  });

  test('moderators get the moderator representation, other signed-in users the public one', async () => {
    seed(postItem());
    const moderated = commentItem({ moderatedBy: users.editor.userId, moderatedAt: '2026-10-21T09:00:00.000Z' });
    ddb.on(QueryCommand).resolves({ Items: [moderated] });

    const asEditor = await call(listRequest({ token: tokenOf(users.editor) }));
    assert.deepEqual(parse(asEditor).items[0], {
      id: COMMENT_ID,
      postId: POST_ID,
      parentId: null,
      body: 'Great article!',
      author: { id: null, name: 'Reader' },
      status: 'approved',
      createdAt: CREATED_AT,
      authorEmail: 'reader@example.com',
      postTitle: 'Serverless 101',
      moderatedBy: users.editor.userId,
      moderatedAt: '2026-10-21T09:00:00.000Z',
      updatedAt: CREATED_AT,
    });

    const asAuthor = await call(listRequest({ token: tokenOf(users.author) }));
    assert.deepEqual(Object.keys(parse(asAuthor).items[0]).sort(), [
      'author', 'body', 'createdAt', 'id', 'parentId', 'postId', 'status',
    ]);
  });

  test('query string validation', async () => {
    seed(postItem());
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: 'ten' },
      { limit: '2.5' },
      { status: 'deleted' },
      { status: 'APPROVED' },
      { order: 'desc' },
    ]) {
      assertError(await call(listRequest({ query })), 400, 'VALIDATION_ERROR');
    }
    assertError(await call(listRequest({ query: { cursor: 'not-a-cursor' } })), 400, 'BAD_REQUEST');
    // A GSI1 cursor (moderation queue) is not valid on the base table.
    const gsiCursor = encodeCursor({ ...keys.comment(POST_ID, COMMENT_ID), GSI1PK: 'COMMENTS#pending', GSI1SK: 'x' });
    assertError(await call(listRequest({ query: { cursor: gsiCursor } })), 400, 'BAD_REQUEST');

    const max = await call(listRequest({ query: { limit: '100' } }));
    assert.equal(max.statusCode, 200, max.body);
  });

  test('an invalid token is rejected even though the route is public', async () => {
    seed(postItem());
    const expired = signIdToken(users.author, { expiresIn: -60 });
    assertError(await call(listRequest({ token: expired })), 401, 'UNAUTHORIZED');
  });
});

describe('POST /posts/{postId}/comments', () => {
  test('anonymous comment: trimmed, stored pending with a simple Put, e-mail kept private', async () => {
    seed(postItem());
    const res = await call(
      createRequest({ body: '  Très clair, merci !  ', authorName: ' Lectrice ', authorEmail: ' Lectrice@Example.COM ' }),
    );
    assert.equal(res.statusCode, 201, res.body);
    const comment = parse(res);
    assert.ok(isUuid(comment.id));
    assert.equal(comment.id[14], '7', 'comment ids are UUID v7 (chronological sort keys)');
    assert.match(comment.createdAt, ISO_RE);
    assert.deepEqual(comment, {
      id: comment.id,
      postId: POST_ID,
      parentId: null,
      body: 'Très clair, merci !',
      author: { id: null, name: 'Lectrice' },
      status: 'pending',
      createdAt: comment.createdAt,
    });
    assert.equal(res.headers.Location, `/posts/${POST_ID}/comments/${comment.id}`);
    assert.ok(!res.body.includes('example.com'));

    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
    const [put] = inputs(PutCommand);
    assert.equal(put.TableName, 'blogify-test');
    assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)');
    assert.deepEqual(put.Item, {
      PK: `POST#${POST_ID}`,
      SK: `COMMENT#${comment.id}`,
      GSI1PK: 'COMMENTS#pending',
      GSI1SK: `${comment.createdAt}#${comment.id}`,
      entityType: 'COMMENT',
      commentId: comment.id,
      postId: POST_ID,
      postTitle: 'Serverless 101',
      parentId: null,
      body: 'Très clair, merci !',
      authorId: null,
      authorName: 'Lectrice',
      authorEmail: 'lectrice@example.com',
      status: 'pending',
      createdAt: comment.createdAt,
      updatedAt: comment.createdAt,
      moderatedBy: null,
      moderatedAt: null,
    });

    const [postRead] = inputs(GetCommand);
    assert.deepEqual(postRead.Key, keys.post(POST_ID));
    assert.equal(postRead.ConsistentRead, true);
  });

  test('signed-in users with a role are approved at once: comment and counter in one transaction', async () => {
    seed(postItem());
    const res = await call(
      createRequest(
        { body: 'Merci pour cet article', authorName: 'Someone Else', authorEmail: 'spoof@evil.test' },
        { token: tokenOf(users.author2) },
      ),
    );
    assert.equal(res.statusCode, 201, res.body);
    const comment = parse(res);
    assert.equal(comment.status, 'approved');
    assert.deepEqual(comment.author, { id: users.author2.userId, name: users.author2.name });

    assert.equal(ddb.commandCalls(PutCommand).length, 0);
    const [{ TransactItems: items }] = inputs(TransactWriteCommand);
    assert.equal(items.length, 2);
    const { Put: put } = items[0];
    assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)');
    assert.equal(put.Item.status, 'approved');
    assert.equal(put.Item.GSI1PK, 'COMMENTS#approved');
    assert.equal(put.Item.authorId, users.author2.userId);
    assert.equal(put.Item.authorName, users.author2.name, 'body authorName is ignored for signed-in users');
    assert.equal(put.Item.authorEmail, users.author2.email, 'body authorEmail is ignored for signed-in users');
    assert.deepEqual(items[1], {
      Update: {
        TableName: 'blogify-test',
        Key: keys.post(POST_ID),
        UpdateExpression: 'ADD commentCount :delta',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':delta': 1 },
      },
    });
  });

  test('signed-in users without any role are moderated like anonymous readers', async () => {
    seed(postItem());
    const res = await call(createRequest({ body: 'Hello' }, { token: tokenOf(users.noRole) }));
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).status, 'pending');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
    const [put] = inputs(PutCommand);
    assert.equal(put.Item.authorId, users.noRole.userId);
    assert.equal(put.Item.authorName, users.noRole.name);
    assert.equal(put.Item.authorEmail, users.noRole.email);
  });

  test('replies must reference an approved comment of the same post', async () => {
    const PARENT_ID = '01928c5f-2222-7000-8000-000000000001';
    seed(
      postItem(),
      commentItem({ commentId: PARENT_ID }),
      commentItem({ commentId: SECOND_COMMENT_ID, status: 'pending' }),
      commentItem({ commentId: COMMENT_ID, postId: OTHER_POST_ID }),
    );
    const reply = (parentId) => call(createRequest({ body: 'Reply', authorName: 'Bob', parentId }));

    const ok = await reply(PARENT_ID);
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal(parse(ok).parentId, PARENT_ID);
    assert.equal(inputs(PutCommand)[0].Item.parentId, PARENT_ID);
    const parentRead = inputs(GetCommand).find((input) => input.Key.SK === `COMMENT#${PARENT_ID}`);
    assert.deepEqual(parentRead.Key, keys.comment(POST_ID, PARENT_ID));
    assert.equal(parentRead.ConsistentRead, true);

    assertError(await reply('01928c5f-9999-7000-8000-000000000009'), 400, 'INVALID_PARENT'); // unknown
    assertError(await reply(SECOND_COMMENT_ID), 400, 'INVALID_PARENT'); // pending parent
    assertError(await reply(COMMENT_ID), 400, 'INVALID_PARENT'); // approved, but on another post
    assertError(await reply('not-a-uuid'), 400, 'VALIDATION_ERROR');
    assert.equal(ddb.commandCalls(PutCommand).length, 1);

    // null or blank parentId = top-level comment
    for (const parentId of [null, '']) {
      const res = await reply(parentId);
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(parse(res).parentId, null);
    }
  });

  test('honeypot: a filled website field is stored as spam but answered like a pending comment', async () => {
    seed(postItem());
    const legit = await call(createRequest({ body: 'Nice', authorName: 'Bob' }));
    const bot = await call(createRequest({ body: 'Nice', authorName: 'Bob', website: 'https://cheap-pills.example' }));
    assert.equal(bot.statusCode, 201, bot.body);
    assert.equal(bot.headers.Location, `/posts/${POST_ID}/comments/${parse(bot).id}`);
    const { id: legitId, createdAt: legitDate, ...legitRest } = parse(legit);
    const { id: botId, createdAt: botDate, ...botRest } = parse(bot);
    assert.deepEqual(botRest, legitRest, 'the bot cannot tell it was detected');
    assert.equal(botRest.status, 'pending');

    const stored = inputs(PutCommand).map((put) => put.Item);
    assert.equal(stored[0].status, 'pending');
    assert.equal(stored[1].status, 'spam');
    assert.equal(stored[1].GSI1PK, 'COMMENTS#spam', 'visible in the spam moderation queue');
    assert.equal(stored[1].website, undefined, 'the honeypot value is not stored');

    // Even an account with a role is not auto-approved when the honeypot is filled.
    const editor = await call(createRequest({ body: 'Nice', website: 'x' }, { token: tokenOf(users.editor) }));
    assert.equal(parse(editor).status, 'pending');
    assert.equal(inputs(PutCommand)[2].Item.status, 'spam');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0, 'spam is never counted');
  });

  test('a blank honeypot (whitespace, null) is not spam', async () => {
    seed(postItem());
    for (const website of ['   ', null, '']) {
      const res = await call(createRequest({ body: 'Nice', authorName: 'Bob', website }));
      assert.equal(res.statusCode, 201, res.body);
    }
    assert.deepEqual(inputs(PutCommand).map((put) => put.Item.status), ['pending', 'pending', 'pending']);
  });

  test('comment body validation (1-2000 characters after trimming, strict object)', async () => {
    seed(postItem());
    const invalid = [
      {},
      { authorName: 'Bob' },
      { body: '    ', authorName: 'Bob' },
      { body: 'a'.repeat(2001), authorName: 'Bob' },
      { body: 42, authorName: 'Bob' },
      { body: 'Hi', authorName: 'Bob', status: 'approved' }, // cannot self-approve
      { body: 'Hi', authorName: 'Bob', authorId: users.admin.userId }, // cannot impersonate
      { body: 'Hi', authorName: 'Bob', website: 123 },
    ];
    for (const body of invalid) {
      assertError(await call(createRequest(body)), 400, 'VALIDATION_ERROR');
    }
    assertError(await call(createRequest('{not json')), 400, 'BAD_REQUEST');
    assertError(await call(createRequest('[]')), 400, 'BAD_REQUEST');
    assert.equal(ddb.commandCalls(PutCommand).length, 0);

    const longest = await call(createRequest({ body: ` ${'a'.repeat(2000)} `, authorName: 'Bob' }));
    assert.equal(longest.statusCode, 201, longest.body);
    assert.equal(parse(longest).body.length, 2000);
  });

  test('anonymous authors must give a name (1-80); the e-mail is optional but must be valid', async () => {
    seed(postItem());
    const missing = await call(createRequest({ body: 'Hi' }));
    assertError(missing, 400, 'VALIDATION_ERROR');
    assert.deepEqual(parse(missing).error.details, [
      { field: 'authorName', message: 'authorName is required for anonymous comments' },
    ]);
    for (const body of [
      { body: 'Hi', authorName: '   ' },
      { body: 'Hi', authorName: 'x'.repeat(81) },
      { body: 'Hi', authorName: null },
      { body: 'Hi', authorName: 'Bob', authorEmail: 'not-an-email' },
      { body: 'Hi', authorName: 'Bob', authorEmail: 42 },
    ]) {
      assertError(await call(createRequest(body)), 400, 'VALIDATION_ERROR');
    }

    const longest = await call(createRequest({ body: 'Hi', authorName: 'x'.repeat(80) }));
    assert.equal(longest.statusCode, 201, longest.body);
    const blankEmail = await call(createRequest({ body: 'Hi', authorName: 'Bob', authorEmail: '' }));
    assert.equal(blankEmail.statusCode, 201, blankEmail.body);
    assert.deepEqual(inputs(PutCommand).map((put) => put.Item.authorEmail), [null, null]);
  });

  test('signed-in users may send name/e-mail fields of any shape: they are ignored', async () => {
    seed(postItem());
    const res = await call(
      createRequest({ body: 'Hi', authorName: '', authorEmail: 'not-an-email' }, { token: tokenOf(users.author) }),
    );
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(parse(res).author, { id: users.author.userId, name: users.author.name });
  });

  test('the post must exist, be published and accept comments', async () => {
    const body = { body: 'Hi', authorName: 'Bob' };
    assertError(await call(createRequest(body, { params: { postId: 'serverless-101' } })), 400, 'VALIDATION_ERROR');
    assertError(await call(createRequest(body)), 404, 'NOT_FOUND');

    for (const status of ['draft', 'in_review', 'archived']) {
      seed(postItem({ status }));
      assertError(await call(createRequest(body)), 404, 'NOT_FOUND');
      // Not even the author of the post or an editor can comment an unpublished post.
      assertError(await call(createRequest({ body: 'Hi' }, { token: tokenOf(users.author) })), 404, 'NOT_FOUND');
      assertError(await call(createRequest({ body: 'Hi' }, { token: tokenOf(users.editor) })), 404, 'NOT_FOUND');
    }

    seed(postItem({ allowComments: false }));
    assertError(await call(createRequest(body)), 403, 'COMMENTS_DISABLED');
    assertError(await call(createRequest({ body: 'Hi' }, { token: tokenOf(users.admin) })), 403, 'COMMENTS_DISABLED');
    assert.equal(ddb.commandCalls(PutCommand).length + ddb.commandCalls(TransactWriteCommand).length, 0);

    // Posts written before the allowComments attribute existed accept comments.
    const legacy = postItem();
    delete legacy.allowComments;
    seed(legacy);
    assert.equal((await call(createRequest(body))).statusCode, 201);
  });

  test('post deleted between the read and the transaction: 404, nothing written', async () => {
    seed(postItem());
    ddb.on(TransactWriteCommand).rejects(canceled('None', 'ConditionalCheckFailed'));
    const res = await call(createRequest({ body: 'Hi' }, { token: tokenOf(users.author) }));
    assertError(res, 404, 'NOT_FOUND');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 1);
  });

  test('transaction conflicts on a busy post are retried, then reported as 409', async () => {
    seed(postItem());
    ddb.on(TransactWriteCommand).rejectsOnce(canceled('None', 'TransactionConflict')).resolves({});
    const retried = await call(createRequest({ body: 'Hi' }, { token: tokenOf(users.author) }));
    assert.equal(retried.statusCode, 201, retried.body);
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 2);

    ddb.on(TransactWriteCommand).rejects(canceled('None', 'TransactionConflict'));
    const busy = await call(createRequest({ body: 'Hi' }, { token: tokenOf(users.author) }));
    assertError(busy, 409, 'CONFLICT');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 2 + 3);
  });

  test('unexpected DynamoDB errors become a generic 500 without internals', async () => {
    seed(postItem());
    ddb.on(PutCommand).rejects(new Error('Requested resource not found: Table: blogify-test not found'));
    const res = await call(createRequest({ body: 'Hi', authorName: 'Bob' }));
    assertError(res, 500, 'INTERNAL_ERROR');
    assert.ok(!res.body.includes('blogify-test'));
  });
});

describe('PATCH /posts/{postId}/comments/{commentId}', () => {
  test('requires authentication (401) and the moderation permission (403)', async () => {
    seed(commentItem({ status: 'pending' }));
    assertError(await call(moderateRequest({ status: 'approved' }, { as: undefined })), 401, 'UNAUTHORIZED');
    assertError(await call(moderateRequest({ status: 'approved' }, { as: users.author })), 403, 'FORBIDDEN');
    assertError(await call(moderateRequest({ status: 'approved' }, { as: users.noRole })), 403, 'FORBIDDEN');
    assert.equal(ddb.commandCalls(GetCommand).length, 0);
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
  });

  test('approving a pending comment moves it to the approved queue and increments the counter atomically', async () => {
    seed(commentItem({ status: 'pending' }));
    const res = await call(moderateRequest({ status: 'approved' }));
    assert.equal(res.statusCode, 200, res.body);
    const comment = parse(res);
    assert.match(comment.moderatedAt, ISO_RE);
    assert.deepEqual(comment, {
      id: COMMENT_ID,
      postId: POST_ID,
      parentId: null,
      body: 'Great article!',
      author: { id: null, name: 'Reader' },
      status: 'approved',
      createdAt: CREATED_AT,
      authorEmail: 'reader@example.com',
      postTitle: 'Serverless 101',
      moderatedBy: users.editor.userId,
      moderatedAt: comment.moderatedAt,
      updatedAt: comment.moderatedAt,
    });

    const [read] = inputs(GetCommand);
    assert.deepEqual(read.Key, keys.comment(POST_ID, COMMENT_ID));
    assert.equal(read.ConsistentRead, true);

    const [{ TransactItems: items }] = inputs(TransactWriteCommand);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      Update: {
        TableName: 'blogify-test',
        Key: keys.comment(POST_ID, COMMENT_ID),
        UpdateExpression:
          'SET #status = :status, GSI1PK = :queue, moderatedBy = :moderator, moderatedAt = :now, updatedAt = :now',
        ConditionExpression: '#status = :current',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'approved',
          ':queue': 'COMMENTS#approved',
          ':moderator': users.editor.userId,
          ':now': comment.moderatedAt,
          ':current': 'pending',
        },
      },
    });
    assert.ok(!items[0].Update.UpdateExpression.includes('GSI1SK'), 'the queue sort key is unchanged');
    assert.equal(items[1].Update.UpdateExpression, 'ADD commentCount :delta');
    assert.deepEqual(items[1].Update.Key, keys.post(POST_ID));
    assert.equal(items[1].Update.ConditionExpression, 'attribute_exists(PK)');
    assert.deepEqual(items[1].Update.ExpressionAttributeValues, { ':delta': 1 });
  });

  test('a comment leaving the approved status decrements the counter', async () => {
    for (const status of ['rejected', 'spam']) {
      ddb.resetHistory();
      seed(commentItem({ status: 'approved' }));
      const res = await call(moderateRequest({ status }, { as: users.admin }));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(parse(res).status, status);
      const [{ TransactItems: items }] = inputs(TransactWriteCommand);
      assert.equal(items[0].Update.ExpressionAttributeValues[':queue'], `COMMENTS#${status}`);
      assert.deepEqual(items[1].Update.ExpressionAttributeValues, { ':delta': -1 });
    }
  });

  test('transitions that do not involve approved leave the counter untouched', async () => {
    seed(commentItem({ status: 'pending' }));
    const res = await call(moderateRequest({ status: 'spam' }));
    assert.equal(res.statusCode, 200, res.body);
    const [{ TransactItems: items }] = inputs(TransactWriteCommand);
    assert.equal(items.length, 1);
    assert.equal(items[0].Update.ExpressionAttributeValues[':queue'], 'COMMENTS#spam');
  });

  test('applying the current status again returns the comment unchanged without writing', async () => {
    seed(commentItem({ status: 'approved' }));
    const res = await call(moderateRequest({ status: 'approved' }));
    assert.equal(res.statusCode, 200, res.body);
    const comment = parse(res);
    assert.equal(comment.status, 'approved');
    assert.equal(comment.moderatedBy, null);
    assert.equal(comment.updatedAt, CREATED_AT);
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
  });

  test('unknown comments (or comments of another post) are 404', async () => {
    assertError(await call(moderateRequest({ status: 'approved' })), 404, 'NOT_FOUND');
    seed(commentItem({ status: 'pending' }));
    const otherPost = { postId: OTHER_POST_ID, commentId: COMMENT_ID };
    assertError(await call(moderateRequest({ status: 'approved' }, { params: otherPost })), 404, 'NOT_FOUND');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
  });

  test('input validation', async () => {
    seed(commentItem({ status: 'pending' }));
    for (const body of [{}, { status: 'pending' }, { status: 'deleted' }, { status: 'approved', note: 'ok' }]) {
      assertError(await call(moderateRequest(body)), 400, 'VALIDATION_ERROR');
    }
    const badId = { postId: POST_ID, commentId: 'abc' };
    assertError(await call(moderateRequest({ status: 'approved' }, { params: badId })), 400, 'VALIDATION_ERROR');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
  });

  test('a concurrent status change is reported as 409', async () => {
    seed(commentItem({ status: 'pending' }));
    ddb.on(TransactWriteCommand).rejects(canceled('ConditionalCheckFailed', 'None'));
    assertError(await call(moderateRequest({ status: 'approved' })), 409, 'CONFLICT');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 1, 'condition failures are not retried');
  });

  test('moderating a comment whose post was deleted is 404', async () => {
    seed(commentItem({ status: 'pending' }));
    ddb.on(TransactWriteCommand).rejects(canceled('None', 'ConditionalCheckFailed'));
    assertError(await call(moderateRequest({ status: 'approved' })), 404, 'NOT_FOUND');
  });
});

describe('DELETE /posts/{postId}/comments/{commentId}', () => {
  test('the author deletes an approved comment: delete + counter decrement in one transaction', async () => {
    seed(commentItem({ authorId: users.author.userId, authorName: users.author.name }));
    const res = await call(deleteRequest({ as: users.author }));
    assert.equal(res.statusCode, 204, res.body);
    assert.equal(res.body, '');

    const [read] = inputs(GetCommand);
    assert.equal(read.ConsistentRead, true);
    const [{ TransactItems: items }] = inputs(TransactWriteCommand);
    assert.deepEqual(items, [
      {
        Delete: {
          TableName: 'blogify-test',
          Key: keys.comment(POST_ID, COMMENT_ID),
          ConditionExpression: 'attribute_exists(PK) AND #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': 'approved' },
        },
      },
      {
        Update: {
          TableName: 'blogify-test',
          Key: keys.post(POST_ID),
          UpdateExpression: 'ADD commentCount :delta',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':delta': -1 },
        },
      },
    ]);
  });

  test('deleting a comment that is not approved does not touch the counter', async () => {
    seed(commentItem({ status: 'pending', authorId: users.noRole.userId }));
    // A user without any role can still delete their own (pending) comment.
    const res = await call(deleteRequest({ as: users.noRole }));
    assert.equal(res.statusCode, 204, res.body);
    const [{ TransactItems: items }] = inputs(TransactWriteCommand);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].Delete.ExpressionAttributeValues, { ':status': 'pending' });
  });

  test('moderators can delete any comment', async () => {
    for (const status of ['approved', 'spam']) {
      ddb.resetHistory();
      seed(commentItem({ status }));
      const res = await call(deleteRequest({ as: users.editor }));
      assert.equal(res.statusCode, 204, res.body);
      const [{ TransactItems: items }] = inputs(TransactWriteCommand);
      assert.equal(items.length, status === 'approved' ? 2 : 1);
    }
  });

  test('other users: 403 on visible comments, 404 on comments they cannot see', async () => {
    seed(commentItem({ status: 'approved', authorId: users.author.userId }));
    assertError(await call(deleteRequest({ as: users.author2 })), 403, 'FORBIDDEN');
    assertError(await call(deleteRequest({ as: users.noRole })), 403, 'FORBIDDEN');

    // Anonymous comments have no owner: only moderators can delete them.
    seed(commentItem({ status: 'approved', authorId: null }));
    assertError(await call(deleteRequest({ as: users.author })), 403, 'FORBIDDEN');

    for (const status of ['pending', 'rejected', 'spam']) {
      seed(commentItem({ status, authorId: users.author.userId }));
      assertError(await call(deleteRequest({ as: users.author2 })), 404, 'NOT_FOUND');
    }
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
  });

  test('anonymous callers get 401, unknown comments 404, malformed ids 400', async () => {
    seed(commentItem());
    assertError(await call(deleteRequest()), 401, 'UNAUTHORIZED');
    const unknown = { postId: POST_ID, commentId: SECOND_COMMENT_ID };
    assertError(await call(deleteRequest({ as: users.editor, params: unknown })), 404, 'NOT_FOUND');
    const malformed = { postId: 'x', commentId: COMMENT_ID };
    assertError(await call(deleteRequest({ as: users.editor, params: malformed })), 400, 'VALIDATION_ERROR');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
  });

  test('post deleted meanwhile: the comment is deleted alone', async () => {
    seed(commentItem({ authorId: users.author.userId }));
    ddb.on(TransactWriteCommand).rejectsOnce(canceled('None', 'ConditionalCheckFailed')).resolves({});
    const res = await call(deleteRequest({ as: users.author }));
    assert.equal(res.statusCode, 204, res.body);
    const [first, retry] = inputs(TransactWriteCommand);
    assert.equal(first.TransactItems.length, 2);
    assert.deepEqual(retry.TransactItems, [first.TransactItems[0]]);
  });

  test('a comment changed or deleted concurrently is reported as 409', async () => {
    seed(commentItem({ authorId: users.author.userId }));
    ddb.on(TransactWriteCommand).rejects(canceled('ConditionalCheckFailed', 'None'));
    assertError(await call(deleteRequest({ as: users.author })), 409, 'CONFLICT');

    // Same when the retry without counter finds the comment changed.
    ddb.reset();
    ddb.on(GetCommand).callsFake((input) => ({ Item: structuredClone(table.get(keyOf(input.Key))) }));
    ddb.on(TransactWriteCommand)
      .rejectsOnce(canceled('None', 'ConditionalCheckFailed'))
      .rejectsOnce(canceled('ConditionalCheckFailed'));
    assertError(await call(deleteRequest({ as: users.author })), 409, 'CONFLICT');
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 2);
  });
});

describe('GET /comments (moderation queue)', () => {
  test('requires authentication (401) and the moderation permission (403)', async () => {
    assertError(await call(queueRequest({ as: undefined })), 401, 'UNAUTHORIZED');
    assertError(await call(queueRequest({ as: users.author })), 403, 'FORBIDDEN');
    assertError(await call(queueRequest({ as: users.noRole })), 403, 'FORBIDDEN');
    assert.equal(ddb.commandCalls(QueryCommand).length, 0);
  });

  test('pending comments of every post by default, oldest first, moderator representation', async () => {
    const queued = [
      commentItem({ status: 'pending' }),
      commentItem({ status: 'pending', commentId: SECOND_COMMENT_ID, postId: OTHER_POST_ID, postTitle: 'Other' }),
    ];
    ddb.on(QueryCommand).resolves({ Items: queued });
    const res = await call(queueRequest());
    assert.equal(res.statusCode, 200, res.body);
    const body = parse(res);
    assert.deepEqual(body.items.map((item) => [item.id, item.postId, item.postTitle]), [
      [COMMENT_ID, POST_ID, 'Serverless 101'],
      [SECOND_COMMENT_ID, OTHER_POST_ID, 'Other'],
    ]);
    assert.equal(body.items[0].authorEmail, 'reader@example.com');
    assert.equal(body.nextCursor, null);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    for (const item of body.items) {
      assert.ok(!('PK' in item) && !('GSI1PK' in item) && !('entityType' in item), 'no internal attributes');
    }

    const [query] = inputs(QueryCommand);
    assert.equal(query.IndexName, 'GSI1');
    assert.equal(query.KeyConditionExpression, 'GSI1PK = :queue');
    assert.deepEqual(query.ExpressionAttributeValues, { ':queue': 'COMMENTS#pending' });
    assert.equal(query.FilterExpression, undefined);
    assert.equal(query.ScanIndexForward, true);
    assert.equal(query.Limit, 20);
  });

  test('status selects the queue; cursors round-trip', async () => {
    const lastKey = { ...keys.comment(POST_ID, COMMENT_ID), ...indexKeys.commentByStatus('spam', CREATED_AT, COMMENT_ID) };
    ddb.on(QueryCommand).resolves({ Items: [commentItem({ status: 'spam' })], LastEvaluatedKey: lastKey });
    const cursor = encodeCursor({ ...lastKey, SK: `COMMENT#${SECOND_COMMENT_ID}` });

    const res = await call(queueRequest({ query: { status: 'spam', limit: '1', cursor }, as: users.admin }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(decodeCursor(parse(res).nextCursor, 'GSI1'), lastKey);
    const [query] = inputs(QueryCommand);
    assert.deepEqual(query.ExpressionAttributeValues, { ':queue': 'COMMENTS#spam' });
    assert.deepEqual(query.ExclusiveStartKey, decodeCursor(cursor, 'GSI1'));
    assert.equal(query.Limit, 1);
  });

  test('query string validation', async () => {
    for (const query of [{ status: 'all' }, { status: 'deleted' }, { limit: '0' }, { limit: '101' }, { postId: POST_ID }]) {
      assertError(await call(queueRequest({ query })), 400, 'VALIDATION_ERROR');
    }
    // A base-table cursor (post comments listing) is not valid on GSI1.
    const baseCursor = encodeCursor(keys.comment(POST_ID, COMMENT_ID));
    assertError(await call(queueRequest({ query: { cursor: baseCursor } })), 400, 'BAD_REQUEST');
    assert.equal(ddb.commandCalls(QueryCommand).length, 0);
  });
});
