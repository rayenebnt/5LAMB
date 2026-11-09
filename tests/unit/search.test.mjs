import '../helpers/env.mjs';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler, routes } from '../../src/functions/search/index.mjs';
import {
  MAX_POSTS_PER_TERM,
  MAX_QUERY_TERMS,
  aggregateMatches,
  compareMatches,
  queryTerms,
  toSearchResult,
} from '../../src/domain/search.mjs';
import { compareTagCounts } from '../../src/domain/tags.mjs';
import { apiEvent, parse, users } from '../helpers/events.mjs';
import { installTestVerifier, signIdToken } from '../helpers/jwt.mjs';
import { apiRoutes } from '../helpers/template.mjs';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

const search = (query, options = {}) => handler(apiEvent({ resource: '/search', query, ...options }));
const listTags = (query, options = {}) => handler(apiEvent({ resource: '/tags', query, ...options }));

const id = (n) => `0192f5a1-7c2b-7d3e-8f40-0000000000${String(n).padStart(2, '0')}`;

/** Search index item, as written by the projector. */
function termItem(term, n, score, overrides = {}) {
  return {
    PK: `TERM#${term}`,
    SK: `POST#${id(n)}`,
    entityType: 'TERM',
    term,
    score,
    postId: id(n),
    slug: `article-${n}`,
    title: `Article ${n}`,
    excerpt: `Extrait ${n}`,
    coverImageUrl: null,
    tags: ['aws'],
    authorId: users.author.userId,
    authorName: users.author.name,
    publishedAt: '2026-10-01T10:00:00.000Z',
    readingTimeMinutes: 3,
    ...overrides,
  };
}

/** Serves `index` ({ term: items }) through the mocked Query on TERM#<term>. */
function mockIndex(index) {
  ddb.on(QueryCommand).callsFake((input) => {
    const term = input.ExpressionAttributeValues[':pk'].replace(/^TERM#/, '');
    return { Items: index[term] ?? [] };
  });
}

const queryInputs = () => ddb.commandCalls(QueryCommand).map((call) => call.args[0].input);

test('routes match template.yaml and are public', () => {
  const declared = apiRoutes().filter((route) => route.codeUri === 'dist/search/');
  assert.deepEqual(Object.keys(routes).sort(), declared.map((route) => route.routeKey).sort());
  assert.ok(declared.every((route) => route.publicRoute));
  assert.ok(Object.values(routes).every((route) => route.auth === 'none'));
});

describe('GET /search', () => {
  // lambda: 1, 2, 3, 4 / dynamodb: 1, 3, 5
  const index = {
    lambda: [
      termItem('lambda', 1, 4),
      termItem('lambda', 2, 10),
      termItem('lambda', 3, 4, { publishedAt: '2026-10-05T10:00:00.000Z' }),
      termItem('lambda', 4, 4),
    ],
    dynamodb: [
      termItem('dynamodb', 1, 4),
      termItem('dynamodb', 3, 4, { publishedAt: '2026-10-05T10:00:00.000Z' }),
      termItem('dynamodb', 5, 20),
    ],
  };

  test('ranks posts by matched terms, then score, then publication date', async () => {
    mockIndex(index);
    const res = await search({ q: 'Lambda DynamoDB' });
    assert.equal(res.statusCode, 200, res.body);
    const body = parse(res);
    assert.equal(body.query, 'Lambda DynamoDB');
    assert.deepEqual(body.terms, ['lambda', 'dynamodb']);
    assert.equal(body.total, 5);
    assert.deepEqual(body.items.map((item) => [item.id, item.matchedTerms, item.score]), [
      [id(3), 2, 8], // same terms and score as 1, published later
      [id(1), 2, 8],
      [id(5), 1, 20],
      [id(2), 1, 10],
      [id(4), 1, 4],
    ]);
    assert.deepEqual(Object.keys(body), ['query', 'terms', 'total', 'items']);
  });

  test('results use the public post summary shape, without internal attributes', async () => {
    mockIndex({ lambda: [termItem('lambda', 7, 13, { tags: ['aws', 'serverless'], coverImageUrl: 'https://cdn.example.com/c.png' })] });
    const [item] = parse(await search({ q: 'lambda' })).items;
    assert.deepEqual(item, {
      id: id(7),
      slug: 'article-7',
      title: 'Article 7',
      excerpt: 'Extrait 7',
      coverImageUrl: 'https://cdn.example.com/c.png',
      tags: ['aws', 'serverless'],
      author: { id: users.author.userId, name: users.author.name },
      publishedAt: '2026-10-01T10:00:00.000Z',
      readingTimeMinutes: 3,
      score: 13,
      matchedTerms: 1,
    });
  });

  test('limit keeps the best results while total counts every match', async () => {
    mockIndex(index);
    const body = parse(await search({ q: 'lambda dynamodb', limit: '2' }));
    assert.equal(body.total, 5);
    assert.deepEqual(body.items.map((item) => item.id), [id(3), id(1)]);

    const all = parse(await search({ q: 'lambda dynamodb', limit: '50' }));
    assert.equal(all.items.length, 5);
    assert.equal(parse(await search({ q: 'lambda', limit: '1' })).items.length, 1);
  });

  test('returns at most 10 results by default', async () => {
    mockIndex({ lambda: Array.from({ length: 15 }, (_, i) => termItem('lambda', i + 1, i + 1)) });
    const body = parse(await search({ q: 'lambda' }));
    assert.equal(body.total, 15);
    assert.equal(body.items.length, 10);
    assert.equal(body.items[0].id, id(15));
  });

  test('queries the index once per distinct term, newest posts first', async () => {
    mockIndex(index);
    const body = parse(await search({ q: '  Lambda lambda LAMBDA, the DynamoDB  ' }));
    assert.equal(body.query, 'Lambda lambda LAMBDA, the DynamoDB');
    assert.deepEqual(body.terms, ['lambda', 'dynamodb']);
    assert.deepEqual(queryInputs(), [
      {
        TableName: 'blogify-test',
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'TERM#lambda' },
        ScanIndexForward: false,
        Limit: MAX_POSTS_PER_TERM,
        ExclusiveStartKey: undefined,
      },
      {
        TableName: 'blogify-test',
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'TERM#dynamodb' },
        ScanIndexForward: false,
        Limit: MAX_POSTS_PER_TERM,
        ExclusiveStartKey: undefined,
      },
    ]);
  });

  test(`uses the first ${MAX_QUERY_TERMS} distinct terms of the query`, async () => {
    mockIndex({});
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett'];
    const body = parse(await search({ q: words.join(' ') }));
    assert.deepEqual(body.terms, words.slice(0, MAX_QUERY_TERMS));
    assert.equal(queryInputs().length, MAX_QUERY_TERMS);
  });

  test(`reads at most ${MAX_POSTS_PER_TERM} index items per term, across pages`, async () => {
    const page = (from) => Array.from({ length: 300 }, (_, i) => termItem('lambda', from + i, 1, { postId: `post-${from + i}` }));
    ddb.on(QueryCommand).callsFake((input) =>
      input.ExclusiveStartKey
        ? { Items: page(300), LastEvaluatedKey: { PK: 'TERM#lambda', SK: 'POST#post-599' } }
        : { Items: page(0), LastEvaluatedKey: { PK: 'TERM#lambda', SK: 'POST#post-299' } },
    );
    const body = parse(await search({ q: 'lambda', limit: '50' }));
    assert.equal(body.total, MAX_POSTS_PER_TERM);
    assert.equal(queryInputs().length, 2);
    assert.deepEqual(queryInputs()[1].ExclusiveStartKey, { PK: 'TERM#lambda', SK: 'POST#post-299' });
  });

  test('a query without searchable terms returns an empty result without reading the index', async () => {
    const res = await search({ q: 'the of and, a' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parse(res), { query: 'the of and, a', terms: [], total: 0, items: [] });
    assert.equal(ddb.calls().length, 0);
    assert.match(res.headers['Cache-Control'], /^public, max-age=60\b/);
  });

  test('no match', async () => {
    mockIndex({});
    assert.deepEqual(parse(await search({ q: 'inexistant' })), { query: 'inexistant', terms: ['inexistant'], total: 0, items: [] });
  });

  test('responses are publicly cacheable for 60 seconds', async () => {
    mockIndex(index);
    const res = await search({ q: 'lambda' });
    assert.match(res.headers['Cache-Control'], /^public, max-age=60\b/);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  });

  test('invalid query strings are rejected with 400', async () => {
    const invalid = [
      null,
      {},
      { q: '' },
      { q: '   ' },
      { q: 'x'.repeat(201) },
      { q: 'lambda', limit: '0' },
      { q: 'lambda', limit: '51' },
      { q: 'lambda', limit: 'abc' },
      { q: 'lambda', limit: '2.5' },
      { q: 'lambda', cursor: 'abc' },
    ];
    for (const query of invalid) {
      const res = await search(query);
      assert.equal(res.statusCode, 400, JSON.stringify(query));
      assert.equal(parse(res).error.code, 'VALIDATION_ERROR');
    }
    assert.equal(ddb.calls().length, 0);
    mockIndex({});
    assert.equal((await search({ q: ` ${'x'.repeat(200)} ` })).statusCode, 200, '200 characters once trimmed');
  });

  test('tokens are ignored: the route is public and its responses are shared', async () => {
    installTestVerifier();
    mockIndex(index);
    const expired = await search({ q: 'lambda' }, { token: signIdToken(users.editor, { expiresIn: -60 }) });
    assert.equal(expired.statusCode, 200);
    const valid = await search({ q: 'lambda' }, { token: signIdToken(users.editor) });
    assert.equal(valid.statusCode, 200);
    assert.match(valid.headers['Cache-Control'], /^public/);
    const garbage = await search({ q: 'lambda' }, { headers: { Authorization: 'Basic abc' } });
    assert.equal(garbage.statusCode, 200);
  });

  test('database errors are not leaked', async () => {
    ddb.on(QueryCommand).rejects(new Error('secret table layout'));
    const failed = await search({ q: 'lambda' });
    assert.equal(failed.statusCode, 500);
    assert.equal(parse(failed).error.code, 'INTERNAL_ERROR');
    assert.ok(!failed.body.includes('secret'));

    ddb.reset();
    ddb.on(QueryCommand).rejects(Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' }));
    const throttled = await search({ q: 'lambda' });
    assert.equal(throttled.statusCode, 503);
  });
});

describe('GET /tags', () => {
  const counter = (tag, postCount) => ({ PK: 'TAGS', SK: `TAG#${tag}`, entityType: 'TAG', tag, postCount, updatedAt: '2026-10-27T10:00:00.000Z' });

  test('lists used tags, most used first, then alphabetically', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [counter('serverless', 2), counter('aws', 5), counter('unused', 0), counter('broken', -1), counter('dynamodb', 2), counter('lambda', 1)],
    });
    const res = await listTags();
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      items: [
        { tag: 'aws', postCount: 5 },
        { tag: 'dynamodb', postCount: 2 },
        { tag: 'serverless', postCount: 2 },
        { tag: 'lambda', postCount: 1 },
      ],
    });
    assert.match(res.headers['Cache-Control'], /^public, max-age=300\b/);
    const [input] = queryInputs();
    assert.equal(input.KeyConditionExpression, 'PK = :pk');
    assert.equal(input.ExpressionAttributeValues[':pk'], 'TAGS');
    assert.equal(input.FilterExpression, '#postCount > :zero');
    assert.deepEqual(input.ExpressionAttributeNames, { '#postCount': 'postCount' });
    assert.equal(input.ExpressionAttributeValues[':zero'], 0);
  });

  test('reads every page of counters', async () => {
    ddb.on(QueryCommand)
      .resolvesOnce({ Items: [counter('aws', 1)], LastEvaluatedKey: { PK: 'TAGS', SK: 'TAG#aws' } })
      .resolvesOnce({ Items: [counter('lambda', 3)] });
    assert.deepEqual(parse(await listTags()).items, [{ tag: 'lambda', postCount: 3 }, { tag: 'aws', postCount: 1 }]);
    assert.equal(queryInputs().length, 2);
  });

  test('no tag yet', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    assert.deepEqual(parse(await listTags()), { items: [] });
  });

  test('query parameters are not accepted', async () => {
    const res = await listTags({ limit: '5' });
    assert.equal(res.statusCode, 400);
    assert.equal(parse(res).error.code, 'VALIDATION_ERROR');
    assert.equal(ddb.calls().length, 0);
  });

  test('unknown routes of the function', async () => {
    const res = await handler(apiEvent({ method: 'POST', resource: '/tags' }));
    assert.equal(res.statusCode, 404);
    assert.equal(parse(res).error.code, 'ROUTE_NOT_FOUND');
  });
});

describe('search helpers', () => {
  test('queryTerms: normalised, distinct, in query order, at most 8', () => {
    assert.deepEqual(queryTerms("L'architecture Serverless, serverless et AWS"), ['architecture', 'serverless', 'aws']);
    assert.deepEqual(queryTerms('a b c the'), []);
    assert.equal(queryTerms('k1 k2 k3 k4 k5 k6 k7 k8 k9').length, MAX_QUERY_TERMS);
  });

  test('aggregateMatches sums the scores and counts the matched terms of each post', () => {
    const matches = aggregateMatches([
      [termItem('lambda', 1, 4), termItem('lambda', 2, 10)],
      [termItem('dynamodb', 1, 6), { term: 'dynamodb', score: 99 }],
    ]);
    assert.deepEqual(
      matches.map(({ post, matchedTerms, score }) => [post.postId, matchedTerms, score]),
      [[id(1), 2, 10], [id(2), 1, 10]],
    );
  });

  test('compareMatches: ties on publication date are broken by post id (newest first)', () => {
    const match = (n, publishedAt) => ({ post: { postId: id(n), publishedAt }, matchedTerms: 1, score: 1 });
    const sorted = [match(1, '2026-10-01'), match(3, undefined), match(2, '2026-10-01'), match(4, '2026-10-02')].sort(compareMatches);
    assert.deepEqual(sorted.map((m) => m.post.postId), [id(4), id(2), id(1), id(3)]);
  });

  test('toSearchResult tolerates missing optional attributes and string sets', () => {
    assert.deepEqual(
      toSearchResult({ post: { postId: 'p', slug: 's', title: 't', tags: new Set(['aws']) }, score: 6, matchedTerms: 1 }),
      {
        id: 'p',
        slug: 's',
        title: 't',
        excerpt: '',
        coverImageUrl: null,
        tags: ['aws'],
        author: { id: null, name: null },
        publishedAt: null,
        readingTimeMinutes: null,
        score: 6,
        matchedTerms: 1,
      },
    );
  });

  test('compareTagCounts: most used first, then alphabetical (byte order)', () => {
    const list = [
      { tag: 'b', postCount: 1 },
      { tag: 'a-b', postCount: 1 },
      { tag: 'ab', postCount: 1 },
      { tag: 'z', postCount: 3 },
    ].sort(compareTagCounts);
    assert.deepEqual(list.map((t) => t.tag), ['z', 'a-b', 'ab', 'b']);
  });
});
