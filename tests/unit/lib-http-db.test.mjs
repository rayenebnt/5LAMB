import '../helpers/env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createApiHandler, ok, parseIfMatch, etag, created } from '../../src/lib/http.mjs';
import { badRequest } from '../../src/lib/errors.mjs';
import { encodeCursor, decodeCursor, queryPage, batchWriteAll } from '../../src/lib/db.mjs';
import { validate, z, schemas } from '../../src/lib/validation.mjs';
import { apiEvent, parse, users } from '../helpers/events.mjs';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

test('router dispatches on method + resource and serialises errors', async () => {
  const handler = createApiHandler({
    'GET /things/{id}': { auth: 'none', handler: async (req) => ok({ id: req.params.id, q: req.query }) },
    'POST /things': { auth: 'required', handler: async (req) => created({ got: req.body, by: req.identity.userId }, '/things/1') },
    'GET /boom': { handler: async () => { throw new Error('secret details'); } },
    'GET /bad': { handler: async () => { throw badRequest('nope', [{ field: 'x', message: 'y' }]); } },
  });

  const res1 = await handler(apiEvent({ resource: '/things/{id}', params: { id: 'a%20b' }, query: { x: '1' } }));
  assert.equal(res1.statusCode, 200);
  assert.deepEqual(parse(res1), { id: 'a b', q: { x: '1' } });
  assert.equal(res1.headers['Access-Control-Allow-Origin'], '*');

  const res2 = await handler(apiEvent({ method: 'POST', resource: '/things', body: { a: 1 }, as: users.author }));
  assert.equal(res2.statusCode, 201);
  assert.equal(res2.headers.Location, '/things/1');
  assert.deepEqual(parse(res2), { got: { a: 1 }, by: users.author.userId });

  const res3 = await handler(apiEvent({ method: 'POST', resource: '/things', body: { a: 1 } }));
  assert.equal(res3.statusCode, 401);
  assert.equal(parse(res3).error.code, 'UNAUTHORIZED');

  const res4 = await handler(apiEvent({ method: 'POST', resource: '/things', body: '{not json', as: users.author }));
  assert.equal(res4.statusCode, 400);

  const res5 = await handler(apiEvent({ method: 'POST', resource: '/things', body: '[1,2]', as: users.author }));
  assert.equal(res5.statusCode, 400);

  const res6 = await handler(apiEvent({ method: 'POST', resource: '/things', body: 'a=1', headers: { 'Content-Type': 'text/plain' }, as: users.author }));
  assert.equal(res6.statusCode, 415);

  const res7 = await handler(apiEvent({ resource: '/boom' }));
  assert.equal(res7.statusCode, 500);
  assert.equal(parse(res7).error.code, 'INTERNAL_ERROR');
  assert.ok(!res7.body.includes('secret'));

  const res8 = await handler(apiEvent({ resource: '/bad' }));
  assert.deepEqual(parse(res8).error, { code: 'BAD_REQUEST', message: 'nope', details: [{ field: 'x', message: 'y' }] });

  const res9 = await handler(apiEvent({ method: 'DELETE', resource: '/things' }));
  assert.equal(res9.statusCode, 404);
});

test('ETag / If-Match helpers', () => {
  assert.equal(etag(3), '"v3"');
  assert.equal(parseIfMatch('"v3"'), 3);
  assert.equal(parseIfMatch('W/"v12"'), 12);
  assert.equal(parseIfMatch('7'), 7);
  assert.equal(parseIfMatch('*'), undefined);
  assert.equal(parseIfMatch(undefined), undefined);
  assert.throws(() => parseIfMatch('abc'), { statusCode: 400 });
});

test('validation helper reports every issue', () => {
  const schema = z.strictObject({ email: schemas.email, limit: schemas.limit(), password: schemas.password.optional() });
  assert.deepEqual(validate(schema, { email: ' A@B.CO ' }), { email: 'a@b.co', limit: 10 });
  try {
    validate(schema, { email: 'x', limit: 99, extra: true, password: 'short' });
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'VALIDATION_ERROR');
    const fields = err.details.map((d) => d.field);
    assert.ok(fields.includes('email'));
    assert.ok(fields.includes('limit'));
    assert.ok(fields.includes('(root)'));
    assert.ok(fields.includes('password'));
  }
});

test('cursor encode/decode round trip and validation', () => {
  const key = { PK: 'POST#1', SK: 'POST', GSI1PK: 'POSTS#published', GSI1SK: '2026#1' };
  assert.deepEqual(decodeCursor(encodeCursor(key), 'GSI1'), key);
  assert.equal(encodeCursor(undefined), null);
  assert.equal(decodeCursor(undefined, 'GSI1'), undefined);
  assert.throws(() => decodeCursor('%%%', 'GSI1'), { statusCode: 400 });
  assert.throws(() => decodeCursor(encodeCursor({ PK: 'a', SK: 'b' }), 'GSI1'), { statusCode: 400 });
  assert.throws(() => decodeCursor(encodeCursor({ ...key, extra: 'x' }), 'GSI1'), { statusCode: 400 });
});

test('queryPage fills a page across filtered rounds and cuts with a precise cursor', async () => {
  const mk = (i) => ({ PK: `POST#${i}`, SK: 'POST', GSI2PK: 'USER#u', GSI2SK: `POST#${i}`, n: i });
  ddb.on(QueryCommand)
    .resolvesOnce({ Items: [mk(1)], LastEvaluatedKey: { PK: 'POST#1', SK: 'POST', GSI2PK: 'USER#u', GSI2SK: 'POST#1' } })
    .resolvesOnce({ Items: [mk(2), mk(3), mk(4)], LastEvaluatedKey: { PK: 'POST#9', SK: 'POST', GSI2PK: 'USER#u', GSI2SK: 'POST#9' } });
  const page = await queryPage({ indexName: 'GSI2', keyCondition: 'GSI2PK = :pk', values: { ':pk': 'USER#u' }, filter: '#s = :s', names: { '#s': 'status' }, limit: 3 });
  assert.deepEqual(page.items.map((i) => i.n), [1, 2, 3]);
  assert.deepEqual(decodeCursor(page.nextCursor, 'GSI2'), { PK: 'POST#3', SK: 'POST', GSI2PK: 'USER#u', GSI2SK: 'POST#3' });
  assert.equal(ddb.commandCalls(QueryCommand).length, 2);

  ddb.reset();
  ddb.on(QueryCommand).resolves({ Items: [mk(1)] });
  const last = await queryPage({ keyCondition: 'PK = :pk', values: { ':pk': 'X' }, limit: 5 });
  assert.equal(last.nextCursor, null);
  assert.equal(ddb.commandCalls(QueryCommand)[0].args[0].input.Limit, 5);
});

test('batchWriteAll chunks, de-duplicates and retries unprocessed items', async () => {
  const requests = Array.from({ length: 30 }, (_, i) => ({ PutRequest: { Item: { PK: `K#${i % 27}`, SK: 'S', i } } }));
  let first = true;
  ddb.on(BatchWriteCommand).callsFake((input) => {
    const items = input.RequestItems['blogify-test'];
    if (first) {
      first = false;
      return { UnprocessedItems: { 'blogify-test': items.slice(0, 2) } };
    }
    return { UnprocessedItems: {} };
  });
  await batchWriteAll(requests);
  const calls = ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems['blogify-test'].length);
  assert.deepEqual(calls, [25, 2, 2]);
});
