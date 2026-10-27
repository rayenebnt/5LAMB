import '../helpers/env.mjs';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import { handler } from '../../src/functions/notifier/index.mjs';
import { notificationMessage } from '../../src/domain/notifications.mjs';
import { users } from '../helpers/events.mjs';

const ddb = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);
const eventsMock = mockClient(EventBridgeClient);

const TABLE = process.env.TABLE_NAME;
const TOPIC_ARN = process.env.TOPIC_ARN;
const POST_A = '0192f5a1-7c2b-7d3e-8f40-00000000000a';
const POST_B = '0192f5a1-7c2b-7d3e-8f40-00000000000b';
const POST_C = '0192f5a1-7c2b-7d3e-8f40-00000000000c';

const awsError = (name, message = name) => Object.assign(new Error(message), { name });
const markerId = (postId) => `POST#${postId}|NOTIFICATION`;

/** Notification markers of the fake table (attribute_not_exists(PK) is honoured). */
let markers;
/** Side effects in call order across DynamoDB, SNS and EventBridge. */
let calls;

beforeEach(() => {
  ddb.reset();
  snsMock.reset();
  eventsMock.reset();
  markers = new Map();
  calls = [];
  ddb.on(PutCommand).callsFake(async (input) => {
    calls.push('marker');
    const id = `${input.Item.PK}|${input.Item.SK}`;
    if (input.ConditionExpression === 'attribute_not_exists(PK)' && markers.has(id)) {
      throw awsError('ConditionalCheckFailedException', 'The conditional request failed');
    }
    markers.set(id, input.Item);
    return {};
  });
  ddb.on(DeleteCommand).callsFake(async (input) => {
    calls.push('release');
    markers.delete(`${input.Key.PK}|${input.Key.SK}`);
    return {};
  });
  snsMock.on(PublishCommand).callsFake(async () => {
    calls.push('sns');
    return { MessageId: `message-${calls.length}` };
  });
  eventsMock.on(PutEventsCommand).callsFake(async () => {
    calls.push('events');
    return { FailedEntryCount: 0, Entries: [{ EventId: `event-${calls.length}` }] };
  });
});

/** Post item as stored in the table. */
function post(postId, overrides = {}) {
  return {
    PK: `POST#${postId}`,
    SK: 'POST',
    entityType: 'POST',
    postId,
    slug: `article-${postId.slice(-1)}`,
    title: 'Architecture serverless avec AWS Lambda',
    content: '# Introduction\n\nUn article sur **DynamoDB**.',
    excerpt: 'Introduction Un article sur DynamoDB.',
    customExcerpt: false,
    coverImageUrl: null,
    tags: ['aws', 'serverless'],
    status: 'published',
    allowComments: true,
    authorId: users.author.userId,
    authorName: users.author.name,
    readingTimeMinutes: 1,
    commentCount: 0,
    reviewNote: null,
    createdAt: '2026-10-27T09:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    submittedAt: '2026-10-27T09:30:00.000Z',
    publishedAt: '2026-10-27T10:00:00.000Z',
    version: 3,
    GSI1PK: 'POSTS#published',
    GSI1SK: `2026-10-27T10:00:00.000Z#${postId}`,
    GSI2PK: `USER#${users.author.userId}`,
    GSI2SK: `POST#2026-10-27T09:00:00.000Z#${postId}`,
    ...overrides,
  };
}

let sequenceNumber = 4200;

/** DynamoDB Streams record (images in DynamoDB JSON) as delivered to Lambda. */
function streamRecord({ eventName = 'MODIFY', newImage, oldImage, keys } = {}) {
  sequenceNumber += 1;
  const item = newImage ?? oldImage;
  return {
    eventID: `event-id-${sequenceNumber}`,
    eventName,
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'eu-west-3',
    dynamodb: {
      Keys: marshall(keys ?? { PK: item.PK, SK: item.SK }),
      ...(newImage && { NewImage: marshall(newImage, { removeUndefinedValues: true }) }),
      ...(oldImage && { OldImage: marshall(oldImage, { removeUndefinedValues: true }) }),
      SequenceNumber: String(sequenceNumber),
      SizeBytes: 1024,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
    eventSourceARN: `arn:aws:dynamodb:eu-west-3:123456789012:table/${TABLE}/stream/2026-10-27T00:00:00.000`,
  };
}

/** MODIFY record of a post whose status changes from `from` to `to`. */
const transition = (item, from, to = 'published') =>
  streamRecord({ newImage: { ...item, status: to }, oldImage: { ...item, status: from } });

const failureOf = (record) => ({ batchItemFailures: [{ itemIdentifier: record.dynamodb.SequenceNumber }] });
const SUCCESS = { batchItemFailures: [] };

/** Sets an environment variable for the duration of a test. */
function withEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** Enables every log level for the duration of a test and captures the structured entries. */
function captureLogs(t) {
  withEnv(t, 'LOG_LEVEL', 'debug');
  const entries = [];
  for (const level of ['debug', 'info', 'warn', 'error']) {
    t.mock.method(console, level, (entry) => entries.push({ level, ...entry }));
  }
  return entries;
}

describe('notifier: first publication of a post', () => {
  test('writes the marker, e-mails the subscribers with a tags attribute, then emits PostPublished', async () => {
    const item = post(POST_A);
    assert.deepEqual(await handler({ Records: [transition(item, 'in_review')] }), SUCCESS);
    assert.deepEqual(calls, ['marker', 'sns', 'events']);

    const putInput = ddb.commandCalls(PutCommand)[0].args[0].input;
    const { createdAt, ...marker } = putInput.Item;
    assert.equal(putInput.TableName, TABLE);
    assert.equal(putInput.ConditionExpression, 'attribute_not_exists(PK)');
    assert.deepEqual(marker, { PK: `POST#${POST_A}`, SK: 'NOTIFICATION', entityType: 'NOTIFICATION', postId: POST_A });
    assert.equal(new Date(createdAt).toISOString(), createdAt);

    assert.deepEqual(snsMock.commandCalls(PublishCommand)[0].args[0].input, {
      TopicArn: TOPIC_ARN,
      Subject: 'Nouvel article : Architecture serverless avec AWS Lambda',
      Message: notificationMessage(item),
      MessageAttributes: { tags: { DataType: 'String.Array', StringValue: '["aws","serverless"]' } },
    });

    const { Entries } = eventsMock.commandCalls(PutEventsCommand)[0].args[0].input;
    assert.equal(Entries.length, 1);
    assert.deepEqual({ ...Entries[0], Detail: JSON.parse(Entries[0].Detail) }, {
      EventBusName: 'default',
      Source: 'blogify.posts',
      DetailType: 'PostPublished',
      Detail: {
        postId: POST_A,
        slug: 'article-a',
        title: 'Architecture serverless avec AWS Lambda',
        excerpt: 'Introduction Un article sur DynamoDB.',
        tags: ['aws', 'serverless'],
        authorId: users.author.userId,
        authorName: users.author.name,
        publishedAt: '2026-10-27T10:00:00.000Z',
        url: 'https://blog.example.com/posts/article-a',
      },
    });
  });

  test('the e-mail is the French plain-text message with the link to the post', async () => {
    await handler({ Records: [transition(post(POST_A), 'draft')] });
    const { Message } = snsMock.commandCalls(PublishCommand)[0].args[0].input;
    assert.match(Message, /^Bonjour,\n/);
    assert.match(Message, /^« Architecture serverless avec AWS Lambda »$/m);
    assert.match(Message, /^Auteur : Gaby Guest$/m);
    assert.match(Message, /^Temps de lecture : environ 1 minute$/m);
    assert.match(Message, /^Tags : aws, serverless$/m);
    assert.match(Message, /^Introduction Un article sur DynamoDB\.$/m);
    assert.match(Message, /^Lire l'article : https:\/\/blog\.example\.com\/posts\/article-a$/m);
    assert.ok(!Message.includes('**DynamoDB**'), 'the post content is not e-mailed');
  });

  test('an INSERT of an already published post (no old image) is announced', async () => {
    const record = streamRecord({ eventName: 'INSERT', newImage: post(POST_B) });
    assert.deepEqual(await handler({ Records: [record] }), SUCCESS);
    assert.deepEqual(calls, ['marker', 'sns', 'events']);
    assert.ok(markers.has(markerId(POST_B)));
  });

  test('a post without tags is sent without message attributes (only unfiltered subscribers get it)', async (t) => {
    withEnv(t, 'PUBLIC_SITE_URL', '');
    await handler({ Records: [transition(post(POST_A, { tags: [] }), 'in_review')] });

    const publishInput = snsMock.commandCalls(PublishCommand)[0].args[0].input;
    assert.equal(publishInput.MessageAttributes, undefined);
    assert.doesNotMatch(publishInput.Message, /Lire l'article|^Tags/m);
    const detail = JSON.parse(eventsMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries[0].Detail);
    assert.deepEqual(detail.tags, []);
    assert.equal(detail.url, null);
  });

  test('tags stored as a DynamoDB string set are supported', async () => {
    await handler({ Records: [transition(post(POST_A, { tags: new Set(['serverless', 'aws']) }), 'in_review')] });
    const { MessageAttributes } = snsMock.commandCalls(PublishCommand)[0].args[0].input;
    assert.deepEqual(JSON.parse(MessageAttributes.tags.StringValue).sort(), ['aws', 'serverless']);
  });

  test('uses the configured event bus', async (t) => {
    withEnv(t, 'EVENT_BUS_NAME', 'blogify-bus');
    await handler({ Records: [transition(post(POST_A), 'in_review')] });
    assert.equal(eventsMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries[0].EventBusName, 'blogify-bus');
  });
});

describe('notifier: records that are not a first publication', () => {
  test('are ignored without any AWS call', async () => {
    const item = post(POST_A);
    const records = [
      transition({ ...item, commentCount: 1 }, 'published', 'published'), // edit / comment count of a published post
      transition(item, 'published', 'draft'), // unpublish
      transition(item, 'draft', 'in_review'), // submit
      transition(item, 'published', 'archived'),
      streamRecord({ eventName: 'INSERT', newImage: { ...item, status: 'draft' } }),
      streamRecord({ eventName: 'REMOVE', oldImage: item }),
      // Tag membership items copy the post status but are not posts.
      streamRecord({
        eventName: 'INSERT',
        newImage: { ...item, PK: 'TAG#aws', SK: `POST#${POST_A}`, entityType: 'TAG_POST', tag: 'aws' },
      }),
      streamRecord({ eventName: 'MODIFY', keys: { PK: item.PK, SK: 'POST' } }), // no image at all
    ];
    assert.deepEqual(await handler({ Records: records }), SUCCESS);
    assert.equal(ddb.calls().length, 0);
    assert.equal(snsMock.calls().length, 0);
    assert.equal(eventsMock.calls().length, 0);
  });

  test('a published image without postId is ignored with a warning', async (t) => {
    const logs = captureLogs(t);
    const { postId, ...withoutId } = post(POST_A);
    assert.equal(postId, POST_A);
    assert.deepEqual(await handler({ Records: [transition(withoutId, 'in_review')] }), SUCCESS);
    assert.equal(ddb.calls().length + snsMock.calls().length + eventsMock.calls().length, 0);
    assert.ok(logs.some((entry) => entry.level === 'warn' && /without postId/.test(entry.message)));
  });

  test('empty batches succeed', async () => {
    assert.deepEqual(await handler({ Records: [] }), SUCCESS);
    assert.deepEqual(await handler({}), SUCCESS);
  });
});

describe('notifier: idempotency', () => {
  test('duplicate deliveries and re-publications e-mail the subscribers only once', async () => {
    const item = post(POST_A);
    const published = transition(item, 'in_review');

    // Same record twice in a batch, then redelivered in another batch.
    assert.deepEqual(await handler({ Records: [published, published] }), SUCCESS);
    assert.deepEqual(await handler({ Records: [published] }), SUCCESS);
    // Unpublished, then published again.
    assert.deepEqual(
      await handler({ Records: [transition(item, 'published', 'draft'), transition(item, 'draft')] }),
      SUCCESS,
    );

    assert.equal(snsMock.commandCalls(PublishCommand).length, 1);
    assert.equal(eventsMock.commandCalls(PutEventsCommand).length, 1);
    assert.equal(ddb.commandCalls(PutCommand).length, 4, 'one marker written, three rejected by the condition');
    assert.equal(ddb.commandCalls(DeleteCommand).length, 0);
    assert.deepEqual([...markers.keys()], [markerId(POST_A)]);
  });
});

describe('notifier: failures', () => {
  test('an SNS failure removes the marker and reports the record, stopping the batch there', async () => {
    let publishes = 0;
    snsMock.on(PublishCommand).callsFake(async () => {
      publishes += 1;
      calls.push('sns');
      if (publishes === 2) throw awsError('InternalErrorException', 'SNS is unavailable');
      return { MessageId: `message-${publishes}` };
    });
    const records = [
      transition(post(POST_A), 'in_review'),
      transition(post(POST_B), 'in_review'),
      transition(post(POST_C), 'draft'),
    ];

    assert.deepEqual(await handler({ Records: records }), failureOf(records[1]));
    assert.deepEqual(calls, ['marker', 'sns', 'events', 'marker', 'sns', 'release']);
    assert.deepEqual(ddb.commandCalls(DeleteCommand)[0].args[0].input, {
      TableName: TABLE,
      Key: { PK: `POST#${POST_B}`, SK: 'NOTIFICATION' },
    });
    assert.deepEqual([...markers.keys()], [markerId(POST_A)], 'B released, C not processed');

    // Lambda retries from the reported record: B and C are notified, A is not e-mailed again.
    assert.deepEqual(await handler({ Records: records.slice(1) }), SUCCESS);
    assert.equal(publishes, 4);
    assert.equal(eventsMock.commandCalls(PutEventsCommand).length, 3);
    assert.deepEqual([...markers.keys()].sort(), [markerId(POST_A), markerId(POST_B), markerId(POST_C)]);
  });

  test('when the marker cannot be removed, the failure is logged and the SNS error still fails the record', async (t) => {
    const logs = captureLogs(t);
    snsMock.on(PublishCommand).rejects(awsError('InternalErrorException', 'SNS is unavailable'));
    ddb.on(DeleteCommand).rejects(awsError('ProvisionedThroughputExceededException'));
    const record = transition(post(POST_A), 'in_review');

    assert.deepEqual(await handler({ Records: [record] }), failureOf(record));
    assert.equal(eventsMock.calls().length, 0);
    const errors = logs.filter((entry) => entry.level === 'error');
    assert.ok(errors.some((entry) => /marker could not be removed/.test(entry.message) && entry.postId === POST_A));
    const retried = errors.find((entry) => /will be retried/.test(entry.message));
    assert.equal(retried.error.name, 'InternalErrorException');
    assert.equal(retried.sequenceNumber, record.dynamodb.SequenceNumber);
  });

  test('a missing topic configuration fails the record and releases the marker', async (t) => {
    withEnv(t, 'TOPIC_ARN', '');
    const record = transition(post(POST_A), 'in_review');
    assert.deepEqual(await handler({ Records: [record] }), failureOf(record));
    assert.deepEqual(calls, ['marker', 'release']);
    assert.equal(markers.size, 0);
  });

  test('a DynamoDB error while writing the marker fails the record before any e-mail', async () => {
    ddb.on(PutCommand).rejects(awsError('ProvisionedThroughputExceededException', 'Rate exceeded'));
    const records = [transition(post(POST_A), 'in_review'), transition(post(POST_B), 'in_review')];
    assert.deepEqual(await handler({ Records: records }), failureOf(records[0]));
    assert.equal(snsMock.calls().length, 0);
    assert.equal(eventsMock.calls().length, 0);
    assert.equal(ddb.commandCalls(DeleteCommand).length, 0);
  });

  test('a malformed record is reported (retried, then sent to the DLQ) instead of being dropped', async () => {
    const record = transition(post(POST_A), 'in_review');
    record.dynamodb.NewImage.broken = { Z: 'unknown type' };
    assert.deepEqual(await handler({ Records: [record] }), failureOf(record));
    assert.equal(snsMock.calls().length, 0);
  });

  test('EventBridge errors are logged but never fail the record (no second e-mail)', async (t) => {
    const logs = captureLogs(t);
    eventsMock
      .on(PutEventsCommand)
      .rejectsOnce(awsError('InternalException', 'EventBridge is unavailable'))
      .resolvesOnce({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'Try again' }] });
    const records = [transition(post(POST_A), 'in_review'), transition(post(POST_B), 'draft')];

    assert.deepEqual(await handler({ Records: records }), SUCCESS);
    assert.equal(snsMock.commandCalls(PublishCommand).length, 2);
    assert.equal(eventsMock.commandCalls(PutEventsCommand).length, 2);
    assert.equal(ddb.commandCalls(DeleteCommand).length, 0, 'markers are kept');
    assert.equal(markers.size, 2);

    const errors = logs.filter((entry) => entry.level === 'error');
    assert.deepEqual(
      errors.map((entry) => [entry.message, entry.postId]),
      [
        ['PostPublished event could not be sent to EventBridge', POST_A],
        ['PostPublished event rejected by EventBridge', POST_B],
      ],
    );
    assert.equal(errors[0].error.message, 'EventBridge is unavailable');
    assert.equal(errors[1].errorCode, 'InternalFailure');
  });
});
