import '../helpers/env.mjs';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockClient } from 'aws-sdk-client-mock';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { indexKeys, keys } from '../../src/lib/db.mjs';
import { computeSearchTerms } from '../../src/domain/search.mjs';
import { tagMembershipItem } from '../../src/domain/tags.mjs';
import { handler } from '../../src/functions/projector/index.mjs';
import { handler as searchApi } from '../../src/functions/search/index.mjs';
import { apiEvent, parse, users } from '../helpers/events.mjs';

// ---------------------------------------------------------------------------------------------
// In-memory stand-in for the table behind the mocked DocumentClient. It implements the subset of
// DynamoDB used by the projector and the search API (conditional transactions, atomic counters,
// batch writes, queries on PK) and throws on any other request, so that tests can assert on the
// resulting state, including after replays.
// ---------------------------------------------------------------------------------------------

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const itemKey = ({ PK, SK }) => `${PK}|${SK}`;
const withoutUndefined = (item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined));

function cancelled(codes) {
  return new TransactionCanceledException({
    message: `Transaction cancelled, please refer cancellation reasons for specific reasons [${codes.join(', ')}]`,
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

class FakeTable {
  items = new Map();
  #failures = [];

  /** The next request of `command` matching `predicate` fails with `error` (once). */
  failOnce(command, predicate, error) {
    this.#failures.push({ command, predicate, error });
  }

  get(key) {
    return this.items.get(itemKey(key));
  }

  partition(pk) {
    return [...this.items.values()].filter((item) => item.PK === pk).sort((a, b) => compare(a.SK, b.SK));
  }

  ofType(entityType) {
    return [...this.items.values()].filter((item) => item.entityType === entityType);
  }

  /** Every item, in key order, without the processing timestamps of tag counters. */
  snapshot() {
    return [...this.items.values()]
      .map(({ updatedAt, ...item }) => (item.entityType === 'TAG' ? item : { ...item, updatedAt }))
      .sort((a, b) => compare(itemKey(a), itemKey(b)));
  }

  seed(...items) {
    for (const item of items) this.#store(item);
  }

  #maybeFail(command, input) {
    const index = this.#failures.findIndex((f) => f.command === command && f.predicate(input));
    if (index === -1) return;
    const [{ error }] = this.#failures.splice(index, 1);
    throw error;
  }

  #store(item) {
    this.items.set(itemKey(item), structuredClone(withoutUndefined(item)));
  }

  #conditionHolds(condition, key) {
    if (condition === undefined) return true;
    if (condition === 'attribute_exists(PK)') return this.items.has(itemKey(key));
    if (condition === 'attribute_not_exists(PK)') return !this.items.has(itemKey(key));
    throw new Error(`FakeTable: unsupported condition ${condition}`);
  }

  #update({ Key, UpdateExpression, ExpressionAttributeNames: names, ExpressionAttributeValues: values }) {
    const match = /^ADD (#\w+) (:\w+) SET (.+)$/.exec(UpdateExpression);
    if (!match) throw new Error(`FakeTable: unsupported update ${UpdateExpression}`);
    const [, addName, addValue, assignments] = match;
    const item = { ...(this.get(Key) ?? Key) };
    item[names[addName]] = (item[names[addName]] ?? 0) + values[addValue];
    for (const assignment of assignments.split(/\s*,\s*/)) {
      const [name, value] = assignment.split(/\s*=\s*/);
      item[names[name]] = values[value];
    }
    this.#store(item);
  }

  transactWrite(input) {
    this.#maybeFail('TransactWrite', input);
    const operations = input.TransactItems.map((entry) => {
      const [type, request] = Object.entries(entry)[0];
      assert.equal(request.TableName, process.env.TABLE_NAME);
      return { type, request, key: request.Key ?? { PK: request.Item.PK, SK: request.Item.SK } };
    });
    assert.equal(new Set(operations.map((op) => itemKey(op.key))).size, operations.length, 'one operation per item');
    const codes = operations.map(({ request, key }) =>
      this.#conditionHolds(request.ConditionExpression, key) ? 'None' : 'ConditionalCheckFailed',
    );
    if (codes.some((code) => code !== 'None')) throw cancelled(codes);
    for (const { type, request } of operations) {
      if (type === 'Put') this.#store(request.Item);
      else if (type === 'Delete') this.items.delete(itemKey(request.Key));
      else if (type === 'Update') this.#update(request);
      else throw new Error(`FakeTable: unsupported transaction item ${type}`);
    }
    return {};
  }

  put(input) {
    this.#maybeFail('Put', input);
    assert.equal(input.TableName, process.env.TABLE_NAME);
    assert.equal(input.ConditionExpression, undefined);
    this.#store(input.Item);
    return {};
  }

  batchWrite(input) {
    this.#maybeFail('BatchWrite', input);
    const requests = input.RequestItems[process.env.TABLE_NAME];
    assert.ok(requests.length >= 1 && requests.length <= 25, 'BatchWriteItem takes 1 to 25 requests');
    const keysInBatch = requests.map((r) => itemKey(r.PutRequest?.Item ?? r.DeleteRequest.Key));
    assert.equal(new Set(keysInBatch).size, keysInBatch.length, 'no duplicate keys in a batch');
    for (const request of requests) {
      if (request.PutRequest) this.#store(request.PutRequest.Item);
      else this.items.delete(itemKey(request.DeleteRequest.Key));
    }
    return { UnprocessedItems: {} };
  }

  query(input) {
    this.#maybeFail('Query', input);
    assert.equal(input.TableName, process.env.TABLE_NAME);
    if (input.IndexName || input.KeyConditionExpression !== 'PK = :pk') {
      throw new Error(`FakeTable: unsupported query ${input.KeyConditionExpression}`);
    }
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues;
    let items = this.partition(values[':pk']);
    if (input.ScanIndexForward === false) items.reverse();
    if (input.ExclusiveStartKey) {
      items = items.slice(items.findIndex((item) => item.SK === input.ExclusiveStartKey.SK) + 1);
    }
    let lastEvaluatedKey;
    if (input.Limit !== undefined && items.length > input.Limit) {
      items = items.slice(0, input.Limit);
      lastEvaluatedKey = { PK: items.at(-1).PK, SK: items.at(-1).SK };
    }
    if (input.FilterExpression) {
      const filter = /^(#\w+) > (:\w+)$/.exec(input.FilterExpression);
      if (!filter) throw new Error(`FakeTable: unsupported filter ${input.FilterExpression}`);
      items = items.filter((item) => item[names[filter[1]]] > values[filter[2]]);
    }
    if (input.ProjectionExpression) {
      const attributes = input.ProjectionExpression.split(/\s*,\s*/);
      items = items.map((item) => Object.fromEntries(attributes.filter((a) => a in item).map((a) => [a, item[a]])));
    }
    return { Items: structuredClone(items), Count: items.length, LastEvaluatedKey: lastEvaluatedKey };
  }
}

const ddb = mockClient(DynamoDBDocumentClient);
let table;

beforeEach(() => {
  ddb.reset();
  table = new FakeTable();
  ddb.on(TransactWriteCommand).callsFake((input) => table.transactWrite(input));
  ddb.on(PutCommand).callsFake((input) => table.put(input));
  ddb.on(BatchWriteCommand).callsFake((input) => table.batchWrite(input));
  ddb.on(QueryCommand).callsFake((input) => table.query(input));
});

// ---------------------------------------------------------------------------------------------
// Post items and stream records
// ---------------------------------------------------------------------------------------------

const POST_ID = '0192f5a1-7c2b-7d3e-8f40-000000000001';
const OTHER_POST_ID = '0192f5a1-7c2b-7d3e-8f40-000000000002';

function postItem(overrides = {}) {
  const postId = overrides.postId ?? POST_ID;
  const status = overrides.status ?? 'published';
  const publishedAt = overrides.publishedAt === undefined ? '2026-10-27T10:00:00.000Z' : overrides.publishedAt;
  const updatedAt = overrides.updatedAt ?? '2026-10-27T10:00:00.000Z';
  return {
    ...keys.post(postId),
    ...indexKeys.postByStatus(status, status === 'published' ? publishedAt : updatedAt, postId),
    ...indexKeys.postByAuthor(users.author.userId, '2026-10-27T09:00:00.000Z', postId),
    entityType: 'POST',
    postId,
    slug: 'architecture-serverless',
    title: 'Architecture serverless',
    content: 'Lambda, API Gateway et DynamoDB.',
    excerpt: 'Lambda, API Gateway et DynamoDB.',
    customExcerpt: false,
    coverImageUrl: null,
    tags: ['aws', 'serverless'],
    status,
    allowComments: true,
    authorId: users.author.userId,
    authorName: users.author.name,
    readingTimeMinutes: 1,
    commentCount: 0,
    reviewNote: null,
    createdAt: '2026-10-27T09:00:00.000Z',
    updatedAt,
    submittedAt: '2026-10-27T09:30:00.000Z',
    publishedAt,
    version: 3,
    ...overrides,
  };
}

const draft = (overrides = {}) => postItem({ status: 'draft', publishedAt: null, version: 1, ...overrides });

let sequence = 1000;

/** DynamoDB Streams record (images in DynamoDB JSON) as delivered to Lambda. */
function streamRecord(eventName, { oldItem, newItem }) {
  sequence += 1;
  const { PK, SK } = newItem ?? oldItem;
  return {
    eventID: `event-${sequence}`,
    eventName,
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'eu-west-3',
    dynamodb: {
      Keys: marshall({ PK, SK }),
      ...(oldItem ? { OldImage: marshall(oldItem, { removeUndefinedValues: true }) } : {}),
      ...(newItem ? { NewImage: marshall(newItem, { removeUndefinedValues: true }) } : {}),
      SequenceNumber: String(sequence),
      SizeBytes: 512,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
  };
}

const insert = (item) => streamRecord('INSERT', { newItem: item });
const modify = (oldItem, newItem) => streamRecord('MODIFY', { oldItem, newItem });
const remove = (item) => streamRecord('REMOVE', { oldItem: item });

async function project(...records) {
  const result = await handler({ Records: records });
  assert.deepEqual(result, { batchItemFailures: [] });
}

const counter = (tag) => table.get(keys.tagCounter(tag));
const membership = (tag, postId = POST_ID) => table.get(keys.tagPost(tag, postId));
const termsOf = (postId) =>
  Object.fromEntries(table.ofType('TERM').filter((item) => item.postId === postId).map((item) => [item.term, item.score]));

/** Asserts that the projections exactly reflect the given current post versions. */
function assertProjectionsMatch(currentPosts) {
  const published = currentPosts.filter((post) => post.status === 'published');
  const expectedMemberships = published.flatMap((post) => post.tags.map((tag) => tagMembershipItem(post, tag)));
  const sortByKey = (items) => [...items].sort((a, b) => compare(itemKey(a), itemKey(b)));
  assert.deepEqual(sortByKey(table.ofType('TAG_POST')), sortByKey(expectedMemberships));

  for (const item of table.ofType('TAG')) {
    const expected = expectedMemberships.filter((m) => m.tag === item.tag).length;
    assert.equal(item.postCount, expected, `counter of ${item.tag}`);
  }
  for (const post of currentPosts) {
    const expected = post.status === 'published' ? Object.fromEntries(computeSearchTerms(post)) : {};
    assert.deepEqual(termsOf(post.postId), expected, `terms of ${post.postId}`);
  }
}

// ---------------------------------------------------------------------------------------------

describe('projector: publication lifecycle', () => {
  test('publishing a post creates its tag memberships, counters and search terms', async () => {
    const published = postItem();
    await project(insert(draft()), modify(draft(), published));

    assertProjectionsMatch([published]);
    assert.deepEqual(membership('aws'), {
      ...tagMembershipItem(published, 'aws'),
      PK: 'TAG#aws',
      SK: `POST#${POST_ID}`,
      GSI1PK: 'TAG#aws',
      GSI1SK: `2026-10-27T10:00:00.000Z#${POST_ID}`,
      entityType: 'TAG_POST',
      tag: 'aws',
    });
    assert.equal(membership('aws').content, undefined, 'post bodies are never copied');
    const { updatedAt, ...awsCounter } = counter('aws');
    assert.deepEqual(awsCounter, { PK: 'TAGS', SK: 'TAG#aws', postCount: 1, tag: 'aws', entityType: 'TAG' });
    assert.match(updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(termsOf(POST_ID), {
      serverless: 16,
      architecture: 10,
      aws: 6,
      api: 4,
      dynamodb: 4,
      gateway: 4,
      lambda: 4,
    });
    const lambda = table.get(keys.term('lambda', POST_ID));
    assert.deepEqual(lambda, {
      PK: 'TERM#lambda',
      SK: `POST#${POST_ID}`,
      entityType: 'TERM',
      term: 'lambda',
      score: 4,
      postId: POST_ID,
      slug: published.slug,
      title: published.title,
      excerpt: published.excerpt,
      coverImageUrl: null,
      tags: ['aws', 'serverless'],
      authorId: published.authorId,
      authorName: published.authorName,
      publishedAt: published.publishedAt,
      readingTimeMinutes: 1,
    });
  });

  test('tag counters change only through conditional transactions on the membership', async () => {
    await project(modify(draft(), postItem()));
    const transactions = ddb.commandCalls(TransactWriteCommand).map((call) => call.args[0].input.TransactItems);
    assert.equal(transactions.length, 2);
    const [put, update] = transactions[0];
    assert.equal(put.Put.ConditionExpression, 'attribute_not_exists(PK)');
    assert.deepEqual(put.Put.Item.PK, 'TAG#aws');
    assert.deepEqual(update.Update.Key, { PK: 'TAGS', SK: 'TAG#aws' });
    assert.match(update.Update.UpdateExpression, /^ADD #postCount :delta SET /);
    assert.equal(update.Update.ExpressionAttributeValues[':delta'], 1);

    ddb.resetHistory();
    await project(modify(postItem(), draft({ version: 4 })));
    const [del, decrement] = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems;
    assert.deepEqual(del.Delete.Key, { PK: 'TAG#aws', SK: `POST#${POST_ID}` });
    assert.equal(del.Delete.ConditionExpression, 'attribute_exists(PK)');
    assert.equal(decrement.Update.ExpressionAttributeValues[':delta'], -1);
  });

  test('the sample event of events/ is projected', async () => {
    const event = JSON.parse(readFileSync(new URL('../../events/stream-post-published.json', import.meta.url), 'utf8'));
    assert.deepEqual(await handler(event), { batchItemFailures: [] });
    const postId = '0192f5a1-7c2b-7d3e-8f40-000000000001';
    assert.equal(table.get(keys.tagPost('serverless', postId)).title, 'Architecture serverless');
    assert.equal(counter('aws').postCount, 1);
    assert.ok(table.get(keys.term('dynamodb', postId)));
  });

  test('editing a published post: removed, added and kept tags, stale terms deleted', async () => {
    const before = postItem();
    const after = postItem({
      title: 'Architecture événementielle',
      tags: ['aws', 'dynamodb'],
      updatedAt: '2026-10-28T08:00:00.000Z',
      version: 4,
    });
    await project(modify(draft(), before), modify(before, after));

    assertProjectionsMatch([after]);
    assert.equal(membership('serverless'), undefined);
    assert.equal(counter('serverless').postCount, 0);
    assert.equal(counter('dynamodb').postCount, 1);
    assert.equal(counter('aws').postCount, 1);
    assert.equal(membership('aws').title, 'Architecture événementielle', 'kept memberships are refreshed');
    assert.equal(membership('aws').version, 4);
    assert.equal(table.get(keys.term('serverless', POST_ID)), undefined);
    assert.equal(table.get(keys.term('evenementielle', POST_ID)).score, 10);
  });

  test('unpublishing removes every membership and search term of the post', async () => {
    const published = postItem();
    const unpublished = draft({ version: 4, publishedAt: published.publishedAt });
    await project(modify(draft(), published), modify(published, unpublished));

    assertProjectionsMatch([unpublished]);
    assert.equal(table.ofType('TAG_POST').length, 0);
    assert.equal(table.ofType('TERM').length, 0);
    assert.deepEqual(table.ofType('TAG').map((c) => [c.tag, c.postCount]), [['aws', 0], ['serverless', 0]]);
  });

  test('archiving then re-publishing restores the projections', async () => {
    const published = postItem();
    const archived = postItem({ status: 'archived', version: 4 });
    const republished = postItem({ version: 5, title: 'Architecture serverless (v2)' });
    await project(modify(draft(), published), modify(published, archived), modify(archived, republished));
    assertProjectionsMatch([republished]);
    assert.equal(counter('aws').postCount, 1);
  });

  test('changes that do not affect the projections (comment counter) are skipped', async () => {
    const published = postItem();
    await project(modify(published, postItem({ commentCount: 5, updatedAt: '2026-10-28T08:00:00.000Z', version: 4 })));
    assert.equal(ddb.calls().length, 0);
  });

  test('drafts are never projected', async () => {
    await project(insert(draft()), modify(draft(), draft({ title: 'Nouveau titre', tags: ['x'], version: 2 })));
    assert.equal(ddb.calls().length, 0);
    assert.equal(table.items.size, 0);
  });

  test('two published posts share tag counters', async () => {
    const first = postItem();
    const second = postItem({ postId: OTHER_POST_ID, slug: 'second', title: 'Second article', tags: ['aws'] });
    await project(modify(draft(), first), insert(second));
    assertProjectionsMatch([first, second]);
    assert.equal(counter('aws').postCount, 2);
    assert.equal(counter('serverless').postCount, 1);
  });
});

describe('projector: deletion', () => {
  test('deleting a published post removes its projections and purges its partition', async () => {
    const published = postItem();
    const other = postItem({ postId: OTHER_POST_ID, slug: 'other', tags: ['aws'] });
    await project(modify(draft(), published), insert(other));
    table.seed(
      { ...keys.comment(POST_ID, 'c1'), entityType: 'COMMENT', body: 'Bravo' },
      { ...keys.comment(POST_ID, 'c2'), entityType: 'COMMENT', body: 'Merci' },
      { ...keys.notification(POST_ID), entityType: 'NOTIFICATION' },
      { ...keys.comment(OTHER_POST_ID, 'c3'), entityType: 'COMMENT', body: 'Autre' },
    );

    await project(remove(published));

    assert.deepEqual(table.partition(`POST#${POST_ID}`), []);
    assert.equal(table.partition(`POST#${OTHER_POST_ID}`).length, 1, 'other posts are untouched');
    assertProjectionsMatch([other]);
    assert.equal(counter('aws').postCount, 1);
    assert.equal(counter('serverless').postCount, 0);

    const purge = ddb.commandCalls(QueryCommand).at(-1).args[0].input;
    assert.equal(purge.ProjectionExpression, 'PK, SK');
    assert.equal(purge.ConsistentRead, true);
  });

  test('deleting a draft only purges its partition', async () => {
    table.seed({ ...keys.comment(POST_ID, 'c1'), entityType: 'COMMENT' });
    await project(remove(draft()));
    assert.equal(table.items.size, 0);
    assert.equal(ddb.commandCalls(TransactWriteCommand).length, 0);
  });

  test('the purge never deletes a post item', async () => {
    table.seed(postItem(), { ...keys.comment(POST_ID, 'c1'), entityType: 'COMMENT' });
    await project(remove(draft()));
    assert.deepEqual(table.partition(`POST#${POST_ID}`).map((item) => item.SK), ['POST']);
  });

  test('stream records of other items are ignored', async () => {
    const comment = { ...keys.comment(POST_ID, 'c1'), entityType: 'COMMENT', status: 'published' };
    table.seed({ ...keys.notification(POST_ID), entityType: 'NOTIFICATION' });
    await project(remove(comment), insert(comment), streamRecord('REMOVE', { oldItem: { PK: 'TAGS', SK: 'POST' } }));
    assert.equal(ddb.calls().length, 0);
    assert.equal(table.items.size, 1);
  });
});

describe('projector: at-least-once delivery and failures', () => {
  test('replaying records neither double counts nor fails', async () => {
    const published = postItem();
    const publish = modify(draft(), published);
    await project(publish, publish);
    assertProjectionsMatch([published]);
    assert.equal(counter('aws').postCount, 1);
    assert.equal(ddb.commandCalls(PutCommand).length, 2, 'replayed additions only refresh the memberships');

    const unpublished = draft({ version: 4 });
    const unpublish = modify(published, unpublished);
    await project(unpublish, unpublish);
    assertProjectionsMatch([unpublished]);
    assert.equal(counter('aws').postCount, 0);

    const remove1 = remove(unpublished);
    await project(remove1, remove1);
    assert.equal(counter('aws').postCount, 0);
  });

  test('a record that failed half-way is completed when retried', async () => {
    const published = postItem();
    const publish = modify(draft(), published);
    table.failOnce('BatchWrite', () => true, new Error('Network error'));

    assert.deepEqual(await handler({ Records: [publish] }), {
      batchItemFailures: [{ itemIdentifier: publish.dynamodb.SequenceNumber }],
    });
    assert.equal(counter('aws').postCount, 1, 'tags were projected before the failure');
    assert.equal(table.ofType('TERM').length, 0);

    await project(publish);
    assertProjectionsMatch([published]);
    assert.equal(counter('aws').postCount, 1);
  });

  test('the first failure stops the batch and is reported; Lambda retries from it', async () => {
    const first = postItem();
    const second = postItem({ postId: OTHER_POST_ID, slug: 'second', tags: ['serverless'] });
    const edited = postItem({ title: 'Titre modifié', version: 4 });
    const records = [modify(draft(), first), insert(second), modify(first, edited)];
    table.failOnce(
      'TransactWrite',
      (input) => input.TransactItems[0].Put?.Item.postId === OTHER_POST_ID,
      cancelled(['None', 'TransactionConflict']),
    );

    const result = await handler({ Records: records });
    assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: records[1].dynamodb.SequenceNumber }] });
    assert.equal(membership('serverless', OTHER_POST_ID), undefined);
    assert.equal(membership('aws').title, 'Architecture serverless', 'later records are not processed');

    await project(...records.slice(1));
    assertProjectionsMatch([edited, second]);
    assert.equal(counter('serverless').postCount, 2);
  });

  test('unexpected errors are reported as failures', async () => {
    const records = [modify(draft(), postItem())];
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ProvisionedThroughputExceededException' });
    table.failOnce('TransactWrite', () => true, throttled);
    assert.deepEqual(await handler({ Records: records }), {
      batchItemFailures: [{ itemIdentifier: records[0].dynamodb.SequenceNumber }],
    });
  });

  test('empty events', async () => {
    assert.deepEqual(await handler({ Records: [] }), { batchItemFailures: [] });
    assert.deepEqual(await handler({}), { batchItemFailures: [] });
    assert.equal(ddb.calls().length, 0);
  });

  test('replaying any suffix of a random history converges to the same projections', async () => {
    const random = mulberry32(20261027);
    const { records, current } = randomHistory(random, 60);

    await project(...records);
    assertProjectionsMatch(current);
    const reference = table.snapshot();

    for (let replay = 0; replay < 15; replay += 1) {
      const from = Math.floor(random() * records.length);
      await project(...records.slice(from));
      assert.deepEqual(table.snapshot(), reference, `replay from record ${from}`);
    }
    await project(...records);
    assert.deepEqual(table.snapshot(), reference, 'full replay');
  });
});

describe('projector: projections are readable by the search API', () => {
  test('GET /search and GET /tags read what the projector writes', async () => {
    const first = postItem();
    const second = postItem({
      postId: OTHER_POST_ID,
      slug: 'dynamodb-en-pratique',
      title: 'DynamoDB en pratique',
      content: 'Modéliser une table unique DynamoDB.',
      excerpt: 'Modéliser une table unique.',
      tags: ['aws', 'dynamodb'],
      publishedAt: '2026-10-28T10:00:00.000Z',
    });
    await project(modify(draft(), first), insert(second));

    const search = await searchApi(apiEvent({ resource: '/search', query: { q: 'DynamoDB lambda' } }));
    assert.equal(search.statusCode, 200, search.body);
    const body = parse(search);
    assert.deepEqual(body.terms, ['dynamodb', 'lambda']);
    assert.equal(body.total, 2);
    assert.deepEqual(body.items.map((item) => [item.id, item.matchedTerms, item.score]), [
      [POST_ID, 2, 8],
      [OTHER_POST_ID, 1, 10 + 6 + 1],
    ]);
    assert.deepEqual(body.items[1], {
      id: OTHER_POST_ID,
      slug: 'dynamodb-en-pratique',
      title: 'DynamoDB en pratique',
      excerpt: 'Modéliser une table unique.',
      coverImageUrl: null,
      tags: ['aws', 'dynamodb'],
      author: { id: users.author.userId, name: users.author.name },
      publishedAt: '2026-10-28T10:00:00.000Z',
      readingTimeMinutes: 1,
      score: 17,
      matchedTerms: 1,
    });

    const tags = await searchApi(apiEvent({ resource: '/tags' }));
    assert.deepEqual(parse(tags).items, [
      { tag: 'aws', postCount: 2 },
      { tag: 'dynamodb', postCount: 1 },
      { tag: 'serverless', postCount: 1 },
    ]);

    await project(modify(first, draft({ version: 4 })));
    const after = parse(await searchApi(apiEvent({ resource: '/search', query: { q: 'lambda' } })));
    assert.deepEqual(after.items, []);
    assert.deepEqual(parse(await searchApi(apiEvent({ resource: '/tags' }))).items, [
      { tag: 'aws', postCount: 1 },
      { tag: 'dynamodb', postCount: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Random post histories (deterministic, seeded)
// ---------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAG_POOL = ['aws', 'lambda', 'serverless', 'dynamodb', 'e-commerce'];
const WORDS = ['cloud', 'lambda', 'table', 'index', 'stream', 'queue', 'cache', 'api', 'edge', 'events'];

/** Interleaved versions of three posts (publish, unpublish, retag, edit, comment, delete). */
function randomHistory(random, steps) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const sample = (list, max) => list.filter(() => random() < max / list.length);
  const current = ['01', '02', '03'].map((n) =>
    draft({ postId: `0192f5a1-7c2b-7d3e-8f40-0000000000${n}`, slug: `post-${n}`, tags: sample(TAG_POOL, 2) }),
  );
  const records = current.map((post) => insert(post));
  const live = new Set(current.map((post) => post.postId));

  for (let step = 1; step <= steps; step += 1) {
    const index = Math.floor(random() * current.length);
    const before = current[index];
    if (!live.has(before.postId)) continue;
    const date = new Date(Date.UTC(2026, 9, 27, 10, step)).toISOString();
    const action = pick(['publish', 'publish', 'unpublish', 'retag', 'edit', 'edit', 'comment', 'delete']);
    if (action === 'delete' && random() < 0.5) continue; // keep deletions rare
    if (action === 'delete') {
      records.push(remove(before));
      live.delete(before.postId);
      current[index] = { ...before, status: 'deleted' };
      continue;
    }
    const after = { ...before, version: before.version + 1, updatedAt: date };
    if (action === 'publish') Object.assign(after, { status: 'published', publishedAt: before.publishedAt ?? date });
    if (action === 'unpublish') after.status = 'draft';
    if (action === 'retag') after.tags = sample(TAG_POOL, 2);
    if (action === 'edit') {
      after.title = `${pick(WORDS)} ${pick(WORDS)}`;
      after.content = Array.from({ length: 12 }, () => pick(WORDS)).join(' ');
      after.excerpt = after.content.slice(0, 30);
    }
    if (action === 'comment') after.commentCount += 1;
    records.push(modify(before, after));
    current[index] = after;
  }
  return { records, current };
}
