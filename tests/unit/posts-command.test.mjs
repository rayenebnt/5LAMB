import '../helpers/env.mjs';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  TransactionConflictException,
} from '@aws-sdk/client-dynamodb';
import { handler } from '../../src/functions/posts-command/index.mjs';
import { isUuid } from '../../src/lib/ids.mjs';
import { apiEvent, lambdaContext, parse, users } from '../helpers/events.mjs';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

const TABLE = 'blogify-test';
const POST_ID = '0192f5a1-7c2b-7d3e-8f40-000000000001';
const CREATED = '2026-10-01T10:00:00.000Z';
const FIRST_PUBLISHED = '2026-10-02T08:00:00.000Z';

/** A stored post item (draft of users.author, version 4, 3 approved comments). */
function postItem(overrides = {}) {
  const status = overrides.status ?? 'draft';
  const publishedAt = overrides.publishedAt ?? (status === 'published' ? FIRST_PUBLISHED : null);
  return {
    PK: `POST#${POST_ID}`,
    SK: 'POST',
    GSI1PK: `POSTS#${status}`,
    GSI1SK: `${status === 'published' ? publishedAt : CREATED}#${POST_ID}`,
    GSI2PK: `USER#${users.author.userId}`,
    GSI2SK: `POST#${CREATED}#${POST_ID}`,
    entityType: 'POST',
    postId: POST_ID,
    slug: 'mon-article',
    title: 'Mon article',
    content: 'Contenu **initial** du billet.',
    excerpt: 'Contenu initial du billet.',
    customExcerpt: false,
    coverImageUrl: null,
    tags: ['aws'],
    allowComments: true,
    authorId: users.author.userId,
    authorName: users.author.name,
    readingTimeMinutes: 1,
    commentCount: 3,
    reviewNote: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    submittedAt: null,
    version: 4,
    ...overrides,
    status,
    publishedAt,
  };
}

const call = (options) => handler(apiEvent(options), lambdaContext);
const callOnPost = (method, suffix, options = {}) =>
  call({ method, resource: `/posts/{postId}${suffix}`, params: { postId: POST_ID }, ...options });

const txCanceled = (...codes) =>
  new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

/** Applies the `SET #a = :a, …` expressions built by the domain to an item (UpdateItem ALL_NEW). */
function applyUpdate(item, input) {
  const next = { ...item };
  for (const assignment of input.UpdateExpression.replace(/^SET /, '').split(', ')) {
    const [name, value] = assignment.split(' = ');
    next[input.ExpressionAttributeNames[name]] = input.ExpressionAttributeValues[value];
  }
  return next;
}

/** Serves `item` to GetCommand and answers UpdateCommand like DynamoDB (ReturnValues ALL_NEW). */
function givenPost(item) {
  ddb.on(GetCommand).resolves({ Item: item });
  ddb.on(UpdateCommand).callsFake((input) => ({ Attributes: applyUpdate(item, input) }));
  return item;
}

const inputs = (Command) => ddb.commandCalls(Command).map((call) => call.args[0].input);

/** Attribute names assigned by an UpdateItem input. */
const setAttributes = (input) =>
  input.UpdateExpression.replace(/^SET /, '')
    .split(', ')
    .map((assignment) => input.ExpressionAttributeNames[assignment.split(' = ')[0]])
    .sort();

/** Attribute values assigned by an UpdateItem input, by attribute name. */
const setValues = (input) =>
  Object.fromEntries(
    input.UpdateExpression.replace(/^SET /, '')
      .split(', ')
      .map((assignment) => assignment.split(' = '))
      .map(([name, value]) => [input.ExpressionAttributeNames[name], input.ExpressionAttributeValues[value]]),
  );

function assertError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode, response.body);
  if (code) assert.equal(parse(response).error.code, code);
}

// ---------------------------------------------------------------------------
// POST /posts
// ---------------------------------------------------------------------------

describe('POST /posts', () => {
  const create = (body, as = users.author) => call({ method: 'POST', resource: '/posts', body, as });

  test('creates a draft and reserves its slug in a single transaction', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await create({
      title: 'Architecture Serverless : Lambda & DynamoDB',
      content: '# Introduction\n\nUn article sur **DynamoDB**.',
      tags: ['AWS', 'Serverless', 'aws'],
    });

    assert.equal(res.statusCode, 201, res.body);
    const post = parse(res);
    assert.ok(isUuid(post.id));
    assert.equal(res.headers.Location, `/posts/${post.id}`);
    assert.equal(res.headers.ETag, '"v1"');
    assert.deepEqual(post, {
      id: post.id,
      slug: 'architecture-serverless-lambda-dynamodb',
      title: 'Architecture Serverless : Lambda & DynamoDB',
      excerpt: 'Introduction Un article sur DynamoDB.',
      content: '# Introduction\n\nUn article sur **DynamoDB**.',
      coverImageUrl: null,
      tags: ['aws', 'serverless'],
      status: 'draft',
      allowComments: true,
      author: { id: users.author.userId, name: users.author.name },
      readingTimeMinutes: 1,
      commentCount: 0,
      reviewNote: null,
      createdAt: post.createdAt,
      updatedAt: post.createdAt,
      submittedAt: null,
      publishedAt: null,
      version: 1,
    });
    assert.match(post.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const [tx] = inputs(TransactWriteCommand);
    assert.equal(tx.TransactItems.length, 2);
    const [{ Put: postPut }, { Put: slugPut }] = tx.TransactItems;
    assert.equal(postPut.TableName, TABLE);
    assert.equal(postPut.ConditionExpression, 'attribute_not_exists(PK)');
    assert.deepEqual(
      {
        PK: postPut.Item.PK,
        SK: postPut.Item.SK,
        GSI1PK: postPut.Item.GSI1PK,
        GSI1SK: postPut.Item.GSI1SK,
        GSI2PK: postPut.Item.GSI2PK,
        GSI2SK: postPut.Item.GSI2SK,
        entityType: postPut.Item.entityType,
        customExcerpt: postPut.Item.customExcerpt,
      },
      {
        PK: `POST#${post.id}`,
        SK: 'POST',
        GSI1PK: 'POSTS#draft',
        GSI1SK: `${post.createdAt}#${post.id}`,
        GSI2PK: `USER#${users.author.userId}`,
        GSI2SK: `POST#${post.createdAt}#${post.id}`,
        entityType: 'POST',
        customExcerpt: false,
      },
    );
    assert.deepEqual(slugPut, {
      TableName: TABLE,
      Item: { PK: 'SLUG#architecture-serverless-lambda-dynamodb', SK: 'SLUG', entityType: 'SLUG', slug: 'architecture-serverless-lambda-dynamodb', postId: post.id },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
  });

  test('stores a custom excerpt, slug, cover image and comment setting', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await create(
      {
        title: 'Titre',
        excerpt: '  Mon résumé  ',
        slug: 'mon-slug',
        coverImageUrl: 'https://cdn.example.com/cover.png',
        allowComments: false,
      },
      users.editor,
    );
    assert.equal(res.statusCode, 201, res.body);
    const post = parse(res);
    assert.equal(post.slug, 'mon-slug');
    assert.equal(post.excerpt, 'Mon résumé');
    assert.equal(post.content, '');
    assert.equal(post.coverImageUrl, 'https://cdn.example.com/cover.png');
    assert.equal(post.allowComments, false);
    assert.deepEqual(post.author, { id: users.editor.userId, name: users.editor.name });
    const [{ Put: postPut }] = inputs(TransactWriteCommand)[0].TransactItems;
    assert.equal(postPut.Item.customExcerpt, true);
  });

  test('a custom slug already in use is a 409 SLUG_TAKEN (no retry)', async () => {
    ddb.on(TransactWriteCommand).rejects(txCanceled('None', 'ConditionalCheckFailed'));
    const res = await create({ title: 'Titre', slug: 'deja-pris' });
    assertError(res, 409, 'SLUG_TAKEN');
    assert.match(parse(res).error.message, /deja-pris/);
    assert.equal(inputs(TransactWriteCommand).length, 1);
  });

  test('an automatic slug already in use moves to the next suffix (same post id)', async () => {
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(txCanceled('None', 'ConditionalCheckFailed'))
      .rejectsOnce(txCanceled('None', 'ConditionalCheckFailed'))
      .resolves({});
    const res = await create({ title: 'Hello World' });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).slug, 'hello-world-3');
    const attempts = inputs(TransactWriteCommand);
    assert.deepEqual(attempts.map((tx) => tx.TransactItems[1].Put.Item.slug), ['hello-world', 'hello-world-2', 'hello-world-3']);
    assert.deepEqual(attempts.map((tx) => tx.TransactItems[0].Put.Item.slug), ['hello-world', 'hello-world-2', 'hello-world-3']);
    assert.equal(new Set(attempts.map((tx) => tx.TransactItems[0].Put.Item.postId)).size, 1);
  });

  test('after -5 a random 6-hex suffix is used', async () => {
    const taken = txCanceled('None', 'ConditionalCheckFailed');
    ddb.on(TransactWriteCommand)
      .rejectsOnce(taken).rejectsOnce(taken).rejectsOnce(taken).rejectsOnce(taken).rejectsOnce(taken)
      .resolves({});
    const res = await create({ title: 'Hello World' });
    assert.equal(res.statusCode, 201, res.body);
    assert.match(parse(res).slug, /^hello-world-[0-9a-f]{6}$/);
    assert.equal(inputs(TransactWriteCommand).length, 6);
  });

  test('gives up with 409 SLUG_TAKEN when every candidate is taken', async () => {
    ddb.on(TransactWriteCommand).rejects(txCanceled('None', 'ConditionalCheckFailed'));
    const res = await create({ title: 'Hello World' });
    assertError(res, 409, 'SLUG_TAKEN');
    assert.equal(inputs(TransactWriteCommand).length, 8);
  });

  test('a title without letters or digits gets the "post" slug', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await create({ title: '!!! ???' });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).slug, 'post');
  });

  test('concurrent transactions are reported as 409 CONFLICT', async () => {
    ddb.on(TransactWriteCommand).rejects(txCanceled('None', 'TransactionConflict'));
    assertError(await create({ title: 'Titre' }), 409, 'CONFLICT');
  });

  test('unexpected failures are 500 without internal details', async () => {
    ddb.on(TransactWriteCommand).rejects(new Error('secret table details'));
    const res = await create({ title: 'Titre' });
    assertError(res, 500, 'INTERNAL_ERROR');
    assert.ok(!res.body.includes('secret'));
  });

  test('anonymous callers get 401, users without POST_CREATE get 403', async () => {
    assertError(await call({ method: 'POST', resource: '/posts', body: { title: 'T' } }), 401, 'UNAUTHORIZED');
    assertError(await create({ title: 'T' }, users.noRole), 403, 'FORBIDDEN');
    assert.equal(ddb.calls().length, 0);
  });

  test('invalid bodies are rejected with 400 before any database access', async () => {
    const invalid = [
      {},
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: 'T', status: 'published' },
      { title: 'T', authorId: users.admin.userId },
      { title: 'T', tags: ['ok', '!!!'] },
      { title: 'T', tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) },
      { title: 'T', slug: 'Pas Un Slug' },
      { title: 'T', slug: POST_ID },
      { title: 'T', coverImageUrl: 'javascript:alert(1)' },
      { title: 'T', content: 'x'.repeat(100_001) },
      { title: 'T', allowComments: 'yes' },
    ];
    for (const body of invalid) {
      assertError(await create(body), 400, 'VALIDATION_ERROR');
    }
    assertError(await create('{not json'), 400, 'BAD_REQUEST');
    assertError(await create('["T"]'), 400, 'BAD_REQUEST');
    assertError(
      await call({ method: 'POST', resource: '/posts', body: 'title=T', headers: { 'Content-Type': 'text/plain' }, as: users.author }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
    assert.equal(ddb.calls().length, 0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /posts/{postId}
// ---------------------------------------------------------------------------

describe('PATCH /posts/{postId}', () => {
  const patch = (body, { as = users.author, headers } = {}) => callOnPost('PATCH', '', { body, as, headers });

  test('the author edits a draft: consistent read, SET of the changed fields, version check', async () => {
    givenPost(postItem());
    const res = await patch({ title: '  Nouveau titre ', content: 'Nouveau **contenu**' }, { headers: { 'If-Match': '"v4"' } });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers.ETag, '"v5"');
    const post = parse(res);
    assert.equal(post.title, 'Nouveau titre');
    assert.equal(post.content, 'Nouveau **contenu**');
    assert.equal(post.excerpt, 'Nouveau contenu');
    assert.equal(post.version, 5);
    assert.equal(post.commentCount, 3, 'comment count comes from the stored item');
    assert.equal(post.slug, 'mon-article');

    const [get] = inputs(GetCommand);
    assert.deepEqual(get, { TableName: TABLE, Key: { PK: `POST#${POST_ID}`, SK: 'POST' }, ConsistentRead: true });

    const [update] = inputs(UpdateCommand);
    assert.equal(update.TableName, TABLE);
    assert.deepEqual(update.Key, { PK: `POST#${POST_ID}`, SK: 'POST' });
    assert.equal(update.ConditionExpression, 'attribute_exists(PK) AND #version = :expectedVersion');
    assert.equal(update.ExpressionAttributeValues[':expectedVersion'], 4);
    assert.equal(update.ReturnValues, 'ALL_NEW');
    assert.deepEqual(setAttributes(update), ['GSI1SK', 'content', 'excerpt', 'readingTimeMinutes', 'title', 'updatedAt', 'version']);
    const values = setValues(update);
    assert.equal(values.version, 5);
    assert.equal(values.GSI1SK, `${values.updatedAt}#${POST_ID}`);
    assert.ok(values.updatedAt > CREATED);
    assert.ok(!JSON.stringify(update).includes('commentCount'), 'commentCount is never rewritten');
  });

  test('custom excerpt, then back to the automatic excerpt with null', async () => {
    givenPost(postItem());
    const custom = await patch({ excerpt: '  Mon résumé  ' });
    assert.equal(custom.statusCode, 200, custom.body);
    assert.equal(parse(custom).excerpt, 'Mon résumé');
    assert.equal(setValues(inputs(UpdateCommand)[0]).customExcerpt, true);

    ddb.reset();
    givenPost(postItem({ excerpt: 'Mon résumé', customExcerpt: true }));
    const contentOnly = await patch({ content: 'Tout autre chose' });
    assert.equal(parse(contentOnly).excerpt, 'Mon résumé', 'a custom excerpt is kept when the content changes');
    assert.ok(!setAttributes(inputs(UpdateCommand)[0]).includes('excerpt'));

    ddb.reset();
    givenPost(postItem({ excerpt: 'Mon résumé', customExcerpt: true }));
    const automatic = await patch({ excerpt: null });
    assert.equal(parse(automatic).excerpt, 'Contenu initial du billet.');
    assert.equal(setValues(inputs(UpdateCommand)[0]).customExcerpt, false);
  });

  test('normalises tags, clears the cover image and toggles comments', async () => {
    givenPost(postItem({ coverImageUrl: 'https://cdn.example.com/old.png' }));
    const res = await patch({ tags: ['Cloud Native', 'AWS', 'aws'], coverImageUrl: null, allowComments: false });
    assert.equal(res.statusCode, 200, res.body);
    const post = parse(res);
    assert.deepEqual(post.tags, ['cloud-native', 'aws']);
    assert.equal(post.coverImageUrl, null);
    assert.equal(post.allowComments, false);
  });

  test('editors may edit published posts, whose GSI1 sort key (publication date) is kept', async () => {
    givenPost(postItem({ status: 'published' }));
    const res = await patch({ title: 'Corrigé' }, { as: users.editor });
    assert.equal(res.statusCode, 200, res.body);
    const update = inputs(UpdateCommand)[0];
    assert.ok(!setAttributes(update).includes('GSI1SK'));
    assert.ok(!setAttributes(update).includes('GSI1PK'));
    assert.equal(parse(res).publishedAt, FIRST_PUBLISHED);
  });

  test('authors may edit posts in review but not published or archived ones (403)', async () => {
    givenPost(postItem({ status: 'in_review' }));
    assert.equal((await patch({ title: 'X' })).statusCode, 200);
    for (const status of ['published', 'archived']) {
      ddb.reset();
      givenPost(postItem({ status }));
      assertError(await patch({ title: 'X' }), 403, 'FORBIDDEN');
      assert.equal(inputs(UpdateCommand).length, 0);
    }
  });

  test("another author's draft is invisible (404), their published post is forbidden (403)", async () => {
    givenPost(postItem());
    assertError(await patch({ title: 'Pirate' }, { as: users.author2 }), 404, 'NOT_FOUND');
    assertError(await patch({ title: 'Pirate' }, { as: users.noRole }), 404, 'NOT_FOUND');
    ddb.reset();
    givenPost(postItem({ status: 'published' }));
    assertError(await patch({ title: 'Pirate' }, { as: users.author2 }), 403, 'FORBIDDEN');
    assertError(await patch({ title: 'Pirate' }, { as: users.noRole }), 403, 'FORBIDDEN');
    assert.equal(inputs(UpdateCommand).length, 0);
  });

  test('editors and admins may edit any draft', async () => {
    givenPost(postItem());
    assert.equal((await patch({ title: 'Relu' }, { as: users.editor })).statusCode, 200);
    assert.equal((await patch({ title: 'Relu' }, { as: users.admin })).statusCode, 200);
  });

  test('unknown post: 404', async () => {
    ddb.on(GetCommand).resolves({});
    assertError(await patch({ title: 'X' }), 404, 'NOT_FOUND');
  });

  test('a stale If-Match is a 412 without any write', async () => {
    givenPost(postItem());
    assertError(await patch({ title: 'X' }, { headers: { 'If-Match': '"v3"' } }), 412, 'PRECONDITION_FAILED');
    assert.equal(inputs(UpdateCommand).length, 0);
  });

  test('If-Match accepts weak and bare forms, rejects malformed values', async () => {
    givenPost(postItem());
    assert.equal((await patch({ title: 'X' }, { headers: { 'if-match': 'W/"v4"' } })).statusCode, 200);
    assert.equal((await patch({ title: 'X' }, { headers: { 'If-Match': '4' } })).statusCode, 200);
    assert.equal((await patch({ title: 'X' }, { headers: { 'If-Match': '*' } })).statusCode, 200);
    assertError(await patch({ title: 'X' }, { headers: { 'If-Match': 'version-4' } }), 400, 'BAD_REQUEST');
  });

  test('a lost race (no If-Match) is retried once on a fresh read', async () => {
    const fresh = postItem({ version: 5, title: 'Modifié entre-temps' });
    ddb.on(GetCommand).resolvesOnce({ Item: postItem() }).resolves({ Item: fresh });
    ddb.on(UpdateCommand)
      .rejectsOnce(conditionFailed())
      .callsFake((input) => ({ Attributes: applyUpdate(fresh, input) }));
    const res = await patch({ content: 'Nouveau' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).version, 6);
    assert.equal(parse(res).title, 'Modifié entre-temps');
    const updates = inputs(UpdateCommand);
    assert.deepEqual(updates.map((u) => u.ExpressionAttributeValues[':expectedVersion']), [4, 5]);
    assert.equal(inputs(GetCommand).length, 2);
  });

  test('two lost races: 409 CONFLICT', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    ddb.on(UpdateCommand).rejects(conditionFailed());
    assertError(await patch({ title: 'X' }), 409, 'CONFLICT');
    assert.equal(inputs(UpdateCommand).length, 2);
  });

  test('a lost race with If-Match: 412 without retry', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    ddb.on(UpdateCommand).rejects(conditionFailed());
    assertError(await patch({ title: 'X' }, { headers: { 'If-Match': '"v4"' } }), 412, 'PRECONDITION_FAILED');
    assert.equal(inputs(UpdateCommand).length, 1);
  });

  test('the retry re-checks the rules on the fresh item', async () => {
    ddb.on(GetCommand)
      .resolvesOnce({ Item: postItem() })
      .resolves({ Item: postItem({ status: 'published', version: 5 }) });
    ddb.on(UpdateCommand).rejects(conditionFailed());
    assertError(await patch({ title: 'X' }), 403, 'FORBIDDEN');
    assert.equal(inputs(UpdateCommand).length, 1);
  });

  test('an item locked by another transaction: 409 CONFLICT', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    ddb.on(UpdateCommand).rejects(new TransactionConflictException({ message: 'conflict', $metadata: {} }));
    assertError(await patch({ title: 'X' }), 409, 'CONFLICT');
  });

  test('slug change: release the old slug, reserve the new one and update the post atomically', async () => {
    givenPost(postItem());
    ddb.on(TransactWriteCommand).resolves({});
    const res = await patch({ slug: 'nouveau-slug' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).slug, 'nouveau-slug');
    assert.equal(parse(res).version, 5);
    assert.equal(res.headers.ETag, '"v5"');
    assert.equal(inputs(UpdateCommand).length, 0);

    const [{ TransactItems: [release, reserve, update] }] = inputs(TransactWriteCommand);
    assert.deepEqual(release, {
      Delete: {
        TableName: TABLE,
        Key: { PK: 'SLUG#mon-article', SK: 'SLUG' },
        ConditionExpression: 'attribute_not_exists(PK) OR postId = :postId',
        ExpressionAttributeValues: { ':postId': POST_ID },
      },
    });
    assert.deepEqual(reserve, {
      Put: {
        TableName: TABLE,
        Item: { PK: 'SLUG#nouveau-slug', SK: 'SLUG', entityType: 'SLUG', slug: 'nouveau-slug', postId: POST_ID },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
    assert.equal(update.Update.ConditionExpression, 'attribute_exists(PK) AND #version = :expectedVersion');
    assert.equal(update.Update.ExpressionAttributeValues[':expectedVersion'], 4);
    assert.equal(setValues(update.Update).slug, 'nouveau-slug');
    assert.ok(!('ReturnValues' in update.Update));
  });

  test('slug already used by another post: 409 SLUG_TAKEN', async () => {
    givenPost(postItem());
    ddb.on(TransactWriteCommand).rejects(txCanceled('None', 'ConditionalCheckFailed', 'None'));
    assertError(await patch({ slug: 'pris' }), 409, 'SLUG_TAKEN');
    assert.equal(inputs(TransactWriteCommand).length, 1);
  });

  test('slug change losing the version race is retried', async () => {
    givenPost(postItem());
    ddb.on(TransactWriteCommand).rejectsOnce(txCanceled('None', 'None', 'ConditionalCheckFailed')).resolves({});
    const res = await patch({ slug: 'nouveau-slug' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(inputs(TransactWriteCommand).length, 2);
    assert.equal(inputs(GetCommand).length, 2);
  });

  test('slug change losing the race with If-Match: 412', async () => {
    givenPost(postItem());
    ddb.on(TransactWriteCommand).rejects(txCanceled('ConditionalCheckFailed', 'None', 'ConditionalCheckFailed'));
    assertError(await patch({ slug: 'nouveau-slug' }, { headers: { 'If-Match': '"v4"' } }), 412, 'PRECONDITION_FAILED');
  });

  test('an unchanged slug does not open a transaction', async () => {
    givenPost(postItem());
    const res = await patch({ slug: 'mon-article', title: 'Autre titre' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(inputs(TransactWriteCommand).length, 0);
    assert.ok(!setAttributes(inputs(UpdateCommand)[0]).includes('slug'));
  });

  test('invalid requests: 400 before any database access', async () => {
    assertError(await patch({}), 400, 'VALIDATION_ERROR');
    assertError(await patch({ status: 'published' }), 400, 'VALIDATION_ERROR');
    assertError(await patch({ title: null }), 400, 'VALIDATION_ERROR');
    assertError(await patch({ commentCount: 0 }), 400, 'VALIDATION_ERROR');
    assertError(await patch({ slug: 'Bad Slug' }), 400, 'VALIDATION_ERROR');
    assertError(
      await call({ method: 'PATCH', resource: '/posts/{postId}', params: { postId: 'mon-article' }, body: { title: 'X' }, as: users.author }),
      400,
      'VALIDATION_ERROR',
    );
    assert.equal(ddb.calls().length, 0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /posts/{postId}
// ---------------------------------------------------------------------------

describe('DELETE /posts/{postId}', () => {
  const remove = ({ as = users.author, headers } = {}) => callOnPost('DELETE', '', { as, headers });

  test('the author deletes a draft: post and slug removed in one transaction', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    ddb.on(TransactWriteCommand).resolves({});
    const res = await remove();
    assert.equal(res.statusCode, 204, res.body);
    assert.equal(res.body, '');

    assert.equal(inputs(GetCommand)[0].ConsistentRead, true);
    const [{ TransactItems }] = inputs(TransactWriteCommand);
    assert.deepEqual(TransactItems, [
      {
        Delete: {
          TableName: TABLE,
          Key: { PK: `POST#${POST_ID}`, SK: 'POST' },
          ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':expectedVersion': 4 },
        },
      },
      {
        Delete: {
          TableName: TABLE,
          Key: { PK: 'SLUG#mon-article', SK: 'SLUG' },
          ConditionExpression: 'attribute_not_exists(PK) OR postId = :postId',
          ExpressionAttributeValues: { ':postId': POST_ID },
        },
      },
    ]);
  });

  test('authors may delete posts in review, not published or archived ones; editors may', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    ddb.on(GetCommand).resolves({ Item: postItem({ status: 'in_review' }) });
    assert.equal((await remove()).statusCode, 204);
    for (const status of ['published', 'archived']) {
      ddb.on(GetCommand).resolves({ Item: postItem({ status }) });
      assertError(await remove(), 403, 'FORBIDDEN');
      assert.equal((await remove({ as: users.editor })).statusCode, 204);
    }
    assert.equal(inputs(TransactWriteCommand).length, 3);
  });

  test("another author's draft: 404; their published post: 403", async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    assertError(await remove({ as: users.author2 }), 404, 'NOT_FOUND');
    ddb.on(GetCommand).resolves({ Item: postItem({ status: 'published' }) });
    assertError(await remove({ as: users.author2 }), 403, 'FORBIDDEN');
    assert.equal(inputs(TransactWriteCommand).length, 0);
  });

  test('unknown post: 404; anonymous: 401', async () => {
    ddb.on(GetCommand).resolves({});
    assertError(await remove(), 404, 'NOT_FOUND');
    assertError(await call({ method: 'DELETE', resource: '/posts/{postId}', params: { postId: POST_ID } }), 401);
  });

  test('If-Match: stale version 412, current version 204', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    ddb.on(TransactWriteCommand).resolves({});
    assertError(await remove({ headers: { 'If-Match': '"v2"' } }), 412, 'PRECONDITION_FAILED');
    assert.equal(inputs(TransactWriteCommand).length, 0);
    assert.equal((await remove({ headers: { 'If-Match': '"v4"' } })).statusCode, 204);
  });

  test('a lost race is retried once, then 409 (412 with If-Match)', async () => {
    ddb.on(GetCommand).resolves({ Item: postItem() });
    ddb.on(TransactWriteCommand).rejectsOnce(txCanceled('ConditionalCheckFailed', 'None')).resolves({});
    assert.equal((await remove()).statusCode, 204);
    assert.equal(inputs(TransactWriteCommand).length, 2);

    ddb.reset();
    ddb.on(GetCommand).resolves({ Item: postItem() });
    ddb.on(TransactWriteCommand).rejects(txCanceled('ConditionalCheckFailed', 'None'));
    assertError(await remove(), 409, 'CONFLICT');
    assert.equal(inputs(TransactWriteCommand).length, 2);

    ddb.reset();
    ddb.on(GetCommand).resolves({ Item: postItem() });
    ddb.on(TransactWriteCommand).rejects(txCanceled('ConditionalCheckFailed', 'None'));
    assertError(await remove({ headers: { 'If-Match': '"v4"' } }), 412, 'PRECONDITION_FAILED');
    assert.equal(inputs(TransactWriteCommand).length, 1);
  });

  test('a post deleted concurrently ends as 404 on the retry', async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: postItem() }).resolves({});
    ddb.on(TransactWriteCommand).rejects(txCanceled('ConditionalCheckFailed', 'None'));
    assertError(await remove(), 404, 'NOT_FOUND');
  });

  test('a non-UUID id is a 400', async () => {
    assertError(
      await call({ method: 'DELETE', resource: '/posts/{postId}', params: { postId: 'mon-article' }, as: users.author }),
      400,
      'VALIDATION_ERROR',
    );
    assert.equal(ddb.calls().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Editorial workflow
// ---------------------------------------------------------------------------

describe('POST /posts/{postId}/{action}', () => {
  const act = (action, { as = users.editor, body, headers } = {}) => callOnPost('POST', `/${action}`, { as, body, headers });

  test('submit: the author sends a draft to review', async () => {
    givenPost(postItem());
    const res = await act('submit', { as: users.author });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers.ETag, '"v5"');
    const post = parse(res);
    assert.equal(post.status, 'in_review');
    assert.equal(post.version, 5);
    assert.ok(post.submittedAt);
    assert.equal(post.content, 'Contenu **initial** du billet.', 'full representation');

    const [update] = inputs(UpdateCommand);
    assert.equal(update.ConditionExpression, 'attribute_exists(PK) AND #version = :expectedVersion');
    assert.equal(update.ExpressionAttributeValues[':expectedVersion'], 4);
    const values = setValues(update);
    assert.deepEqual(Object.keys(values).sort(), ['GSI1PK', 'GSI1SK', 'status', 'submittedAt', 'updatedAt', 'version']);
    assert.equal(values.GSI1PK, 'POSTS#in_review');
    assert.equal(values.GSI1SK, `${values.updatedAt}#${POST_ID}`);
    assert.equal(values.submittedAt, values.updatedAt);
  });

  test('submit: editors may submit any draft; other authors cannot see it (404)', async () => {
    givenPost(postItem());
    assert.equal((await act('submit', { as: users.editor })).statusCode, 200);
    assertError(await act('submit', { as: users.author2 }), 404, 'NOT_FOUND');
  });

  test('publish: forbidden to guest authors, editors publish with publishedAt and GSI1 by publication date', async () => {
    givenPost(postItem({ status: 'in_review', reviewNote: 'Ancienne remarque' }));
    assertError(await act('publish', { as: users.author }), 403, 'FORBIDDEN');
    assert.equal(inputs(UpdateCommand).length, 0);

    const res = await act('publish');
    assert.equal(res.statusCode, 200, res.body);
    const post = parse(res);
    assert.equal(post.status, 'published');
    assert.equal(post.reviewNote, null);
    assert.equal(post.publishedAt, post.updatedAt);
    const values = setValues(inputs(UpdateCommand)[0]);
    assert.equal(values.GSI1PK, 'POSTS#published');
    assert.equal(values.GSI1SK, `${post.publishedAt}#${POST_ID}`);
  });

  test('re-publishing keeps the first publication date', async () => {
    givenPost(postItem({ status: 'archived', publishedAt: FIRST_PUBLISHED }));
    const res = await act('publish', { as: users.admin });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).publishedAt, FIRST_PUBLISHED);
    assert.equal(setValues(inputs(UpdateCommand)[0]).GSI1SK, `${FIRST_PUBLISHED}#${POST_ID}`);
  });

  test('publishing a published post: 409 INVALID_STATE_TRANSITION', async () => {
    givenPost(postItem({ status: 'published' }));
    const res = await act('publish');
    assertError(res, 409, 'INVALID_STATE_TRANSITION');
    assert.equal(parse(res).error.message, "Cannot publish a post whose status is 'published'");
    assert.equal(inputs(UpdateCommand).length, 0);
  });

  test('unpublish: back to draft, publication date kept, GSI1 sorted by update date', async () => {
    givenPost(postItem({ status: 'published' }));
    const res = await act('unpublish');
    assert.equal(res.statusCode, 200, res.body);
    const post = parse(res);
    assert.equal(post.status, 'draft');
    assert.equal(post.publishedAt, FIRST_PUBLISHED);
    const values = setValues(inputs(UpdateCommand)[0]);
    assert.deepEqual(Object.keys(values).sort(), ['GSI1PK', 'GSI1SK', 'status', 'updatedAt', 'version']);
    assert.equal(values.GSI1PK, 'POSTS#draft');
    assert.equal(values.GSI1SK, `${values.updatedAt}#${POST_ID}`);
  });

  test('reject: back to draft with the review note', async () => {
    givenPost(postItem({ status: 'in_review' }));
    const res = await act('reject', { body: { note: '  Merci de développer la conclusion.  ' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).status, 'draft');
    assert.equal(parse(res).reviewNote, 'Merci de développer la conclusion.');

    const withoutNote = await act('reject');
    assert.equal(withoutNote.statusCode, 200, withoutNote.body);
    assert.equal(parse(withoutNote).reviewNote, null);
  });

  test('reject: note longer than 1000 characters or unknown fields are 400', async () => {
    givenPost(postItem({ status: 'in_review' }));
    assertError(await act('reject', { body: { note: 'x'.repeat(1001) } }), 400, 'VALIDATION_ERROR');
    assertError(await act('reject', { body: { note: 'ok', status: 'draft' } }), 400, 'VALIDATION_ERROR');
    assert.equal(ddb.calls().length, 0);
  });

  test('archive: published post archived; archiving twice is a 409', async () => {
    givenPost(postItem({ status: 'published' }));
    const res = await act('archive');
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).status, 'archived');
    assert.equal(setValues(inputs(UpdateCommand)[0]).GSI1PK, 'POSTS#archived');

    ddb.reset();
    givenPost(postItem({ status: 'archived', publishedAt: FIRST_PUBLISHED }));
    assertError(await act('archive'), 409, 'INVALID_STATE_TRANSITION');
  });

  test('every action against every status (editor)', async () => {
    const allowed = {
      submit: ['draft'],
      publish: ['draft', 'in_review', 'archived'],
      unpublish: ['published'],
      reject: ['in_review'],
      archive: ['draft', 'in_review', 'published'],
    };
    const target = { submit: 'in_review', publish: 'published', unpublish: 'draft', reject: 'draft', archive: 'archived' };
    for (const [action, from] of Object.entries(allowed)) {
      for (const status of ['draft', 'in_review', 'published', 'archived']) {
        ddb.reset();
        givenPost(postItem({ status }));
        const res = await act(action);
        if (from.includes(status)) {
          assert.equal(res.statusCode, 200, `${action} from ${status}: ${res.body}`);
          assert.equal(parse(res).status, target[action]);
        } else {
          assertError(res, 409, 'INVALID_STATE_TRANSITION');
          assert.equal(parse(res).error.message, `Cannot ${action} a post whose status is '${status}'`);
        }
      }
    }
  });

  test('actions other than reject only accept an empty body', async () => {
    givenPost(postItem());
    assertError(await act('publish', { body: { note: 'x' } }), 400, 'VALIDATION_ERROR');
    assert.equal((await act('publish', { body: {} })).statusCode, 200);
    assert.equal((await act('publish', { body: '' })).statusCode, 200);
  });

  test('permissions: noRole users 403 on visible posts, 404 on drafts', async () => {
    givenPost(postItem({ status: 'published' }));
    for (const action of ['submit', 'unpublish', 'archive']) {
      assertError(await act(action, { as: users.noRole }), 403, 'FORBIDDEN');
    }
    ddb.reset();
    givenPost(postItem());
    assertError(await act('publish', { as: users.noRole }), 404, 'NOT_FOUND');
    assertError(await act('publish', { as: users.author2 }), 404, 'NOT_FOUND');
    assert.equal(inputs(UpdateCommand).length, 0);
  });

  test('guest authors cannot unpublish, reject or archive their own posts', async () => {
    givenPost(postItem({ status: 'in_review' }));
    for (const action of ['reject', 'archive', 'publish']) {
      assertError(await act(action, { as: users.author }), 403, 'FORBIDDEN');
    }
  });

  test('optimistic locking: stale If-Match 412, lost race retried, unknown post 404', async () => {
    givenPost(postItem());
    assertError(await act('submit', { as: users.author, headers: { 'If-Match': '"v1"' } }), 412, 'PRECONDITION_FAILED');
    assert.equal(inputs(UpdateCommand).length, 0);

    ddb.reset();
    ddb.on(GetCommand).resolvesOnce({ Item: postItem() }).resolves({ Item: postItem({ status: 'in_review', version: 5 }) });
    ddb.on(UpdateCommand).rejects(conditionFailed());
    // The concurrent request already submitted the post: the retry sees an invalid transition.
    assertError(await act('submit', { as: users.author }), 409, 'INVALID_STATE_TRANSITION');
    assert.equal(inputs(UpdateCommand).length, 1);

    ddb.reset();
    ddb.on(GetCommand).resolves({});
    assertError(await act('publish'), 404, 'NOT_FOUND');
  });

  test('anonymous calls are rejected with 401', async () => {
    assertError(await callOnPost('POST', '/publish'), 401, 'UNAUTHORIZED');
    assert.equal(ddb.calls().length, 0);
  });
});
