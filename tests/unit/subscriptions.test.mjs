import '../helpers/env.mjs';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { ListSubscriptionsByTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import { handler, routes } from '../../src/functions/subscriptions/index.mjs';
import { notificationAttributes, subscriptionAttributes } from '../../src/domain/notifications.mjs';
import { apiEvent, lambdaContext, parse, users } from '../helpers/events.mjs';
import { apiRoutes } from '../helpers/template.mjs';

const snsMock = mockClient(SNSClient);
const TOPIC_ARN = process.env.TOPIC_ARN;
const SUBSCRIPTION_ARN = `${TOPIC_ARN}:6b0e71bd-7e97-4d97-80ce-4a0994e55286`;

const awsError = (name, message = name) => Object.assign(new Error(message), { name });

beforeEach(() => {
  snsMock.reset();
  snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: SUBSCRIPTION_ARN });
});

const subscribe = (body, options = {}) =>
  handler(apiEvent({ method: 'POST', resource: '/subscriptions', body, ...options }), lambdaContext);
const list = (options = {}) =>
  handler(apiEvent({ method: 'GET', resource: '/subscriptions', ...options }), lambdaContext);
const subscribeInput = () => snsMock.commandCalls(SubscribeCommand)[0].args[0].input;

/** Sets an environment variable for the duration of a test. */
function withEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test('routes match template.yaml (route keys and auth modes)', () => {
  const declared = apiRoutes().filter((route) => route.codeUri === 'dist/subscriptions/');
  assert.deepEqual(Object.keys(routes).sort(), declared.map((route) => route.routeKey).sort());
  assert.equal(routes['POST /subscriptions'].auth, 'none');
  assert.equal(routes['GET /subscriptions'].auth, 'required');
  assert.ok(declared.find((route) => route.routeKey === 'POST /subscriptions').publicRoute);
  assert.ok(!declared.find((route) => route.routeKey === 'GET /subscriptions').publicRoute);
});

describe('POST /subscriptions', () => {
  test('subscribes an e-mail address to every new post (SNS e-mail double opt-in)', async () => {
    const res = await subscribe({ email: '  Reader@Example.COM ' });
    assert.equal(res.statusCode, 202, res.body);
    const body = parse(res);
    assert.deepEqual(body, {
      email: 'reader@example.com',
      tags: [],
      status: 'pending_confirmation',
      message: 'Check your inbox (and spam folder) to confirm your subscription.',
    });
    assert.ok(!res.body.includes(SUBSCRIPTION_ARN), 'the subscription ARN is never returned');
    assert.deepEqual(subscribeInput(), {
      TopicArn: TOPIC_ARN,
      Protocol: 'email',
      Endpoint: 'reader@example.com',
      ReturnSubscriptionArn: true,
      Attributes: undefined,
    });
  });

  test('tags are normalised, de-duplicated and turned into an SNS filter policy', async () => {
    const res = await subscribe({ email: 'reader@example.com', tags: ['AWS', 'aws', ' Serverless Computing ', 'Café'] });
    assert.equal(res.statusCode, 202, res.body);
    assert.deepEqual(parse(res).tags, ['aws', 'serverless-computing', 'cafe']);

    const { Attributes } = subscribeInput();
    assert.deepEqual(Object.keys(Attributes).sort(), ['FilterPolicy', 'FilterPolicyScope']);
    assert.equal(Attributes.FilterPolicyScope, 'MessageAttributes');
    assert.deepEqual(JSON.parse(Attributes.FilterPolicy), { tags: ['aws', 'serverless-computing', 'cafe'] });
  });

  test('an empty tag list means every new post (no filter policy)', async () => {
    const res = await subscribe({ email: 'reader@example.com', tags: [] });
    assert.equal(res.statusCode, 202, res.body);
    assert.deepEqual(parse(res).tags, []);
    assert.equal(subscribeInput().Attributes, undefined);
  });

  test('the route is public: an Authorization header is ignored', async () => {
    const res = await subscribe({ email: 'reader@example.com' }, { headers: { Authorization: 'Bearer not-a-token' } });
    assert.equal(res.statusCode, 202, res.body);
  });

  test('invalid bodies are rejected with 400 VALIDATION_ERROR before calling SNS', async () => {
    const email = 'reader@example.com';
    const invalid = [
      {},
      { email: 'not-an-e-mail' },
      { email: '' },
      { email: `${'a'.repeat(250)}@example.com` },
      { email: 42 },
      { email, unknown: true },
      { email, tags: 'aws' },
      { email, tags: null },
      { email, tags: [42] },
      { email, tags: [''] },
      { email, tags: ['   '] },
      { email, tags: ['!!!'] }, // nothing left once normalised
      { email, tags: ['x'.repeat(41)] },
      { email, tags: Array.from({ length: 11 }, (_, i) => `tag-${i}`) },
    ];
    for (const body of invalid) {
      const res = await subscribe(body);
      assert.equal(res.statusCode, 400, `${JSON.stringify(body)} -> ${res.body}`);
      assert.equal(parse(res).error.code, 'VALIDATION_ERROR');
    }
    assert.equal(snsMock.calls().length, 0);
  });

  test('validation errors name the offending field', async () => {
    const res = await subscribe({ email: 'reader@example.com', tags: ['aws', '!!!'], extra: 1 });
    const fields = parse(res).error.details.map((detail) => detail.field);
    assert.ok(fields.includes('tags.1'));
    assert.ok(fields.includes('(root)'));
  });

  test('malformed requests are rejected (invalid JSON 400, non-JSON content type 415)', async () => {
    assert.equal((await subscribe('{"email":')).statusCode, 400);
    assert.equal((await subscribe('["reader@example.com"]')).statusCode, 400);
    const text = await subscribe('email=reader@example.com', { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(text.statusCode, 415);
    assert.equal(snsMock.calls().length, 0);
  });

  test('an address already subscribed with other tags is a 409 ALREADY_SUBSCRIBED', async () => {
    snsMock
      .on(SubscribeCommand)
      .rejects(
        awsError(
          'InvalidParameterException',
          'Invalid parameter: Attributes Reason: Subscription already exists with different attributes',
        ),
      );
    const res = await subscribe({ email: 'reader@example.com', tags: ['aws'] });
    assert.equal(res.statusCode, 409);
    assert.equal(parse(res).error.code, 'ALREADY_SUBSCRIBED');
  });

  test('other invalid parameters reported by SNS are a 400 without SNS internals', async () => {
    snsMock.on(SubscribeCommand).rejects(awsError('InvalidParameterException', 'Invalid parameter: Email address'));
    const res = await subscribe({ email: 'reader@example.com' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parse(res).error, { code: 'INVALID_PARAMETER', message: 'Invalid subscription request' });
  });

  test('SNS throttling or quotas are a 503, unexpected errors a 500 that leaks nothing', async (t) => {
    for (const name of ['ThrottledException', 'FilterPolicyLimitExceededException', 'SubscriptionLimitExceededException']) {
      snsMock.on(SubscribeCommand).rejects(awsError(name, 'Rate exceeded'));
      const res = await subscribe({ email: 'reader@example.com' });
      assert.equal(res.statusCode, 503, name);
      assert.equal(parse(res).error.code, 'SERVICE_UNAVAILABLE');
    }

    snsMock.on(SubscribeCommand).rejects(awsError('AuthorizationErrorException', `User is not authorized on ${TOPIC_ARN}`));
    const denied = await subscribe({ email: 'reader@example.com' });
    assert.equal(denied.statusCode, 500);
    assert.equal(parse(denied).error.code, 'INTERNAL_ERROR');
    assert.ok(!denied.body.includes(TOPIC_ARN));

    withEnv(t, 'TOPIC_ARN', '');
    snsMock.resetHistory();
    const unconfigured = await subscribe({ email: 'reader@example.com' });
    assert.equal(unconfigured.statusCode, 500);
    assert.equal(snsMock.calls().length, 0);
  });
});

describe('subscription filter policy', () => {
  /** Simplified SNS filtering: every policy key must match one of the message attribute values. */
  function delivered(attributes, messageAttributes) {
    if (!attributes) return true;
    assert.equal(attributes.FilterPolicyScope, 'MessageAttributes');
    const policy = JSON.parse(attributes.FilterPolicy);
    return Object.entries(policy).every(([name, accepted]) => {
      const attribute = messageAttributes?.[name];
      if (!attribute) return false;
      const values = attribute.DataType === 'String.Array' ? JSON.parse(attribute.StringValue) : [attribute.StringValue];
      return values.some((value) => accepted.includes(value));
    });
  }

  test('matches the tags message attribute set by the notifier', async () => {
    await subscribe({ email: 'reader@example.com', tags: ['AWS Lambda', 'DynamoDB'] });
    const { Attributes } = subscribeInput();
    assert.deepEqual(Attributes, subscriptionAttributes(['aws-lambda', 'dynamodb']));

    const notification = (tags) => notificationAttributes({ postId: 'p', tags });
    assert.equal(delivered(Attributes, notification(['api', 'aws-lambda'])), true);
    assert.equal(delivered(Attributes, notification(['dynamodb'])), true);
    assert.equal(delivered(Attributes, notification(['python'])), false);
    assert.equal(delivered(Attributes, notification([])), false, 'posts without tags only reach unfiltered subscribers');
    assert.equal(delivered(subscriptionAttributes([]), notification([])), true);
    assert.equal(delivered(subscriptionAttributes([]), notification(['python'])), true);
  });
});

describe('GET /subscriptions', () => {
  /** Subscription as returned by ListSubscriptionsByTopic. */
  const subscription = (Endpoint, SubscriptionArn, Protocol = 'email') => ({
    SubscriptionArn,
    Owner: '123456789012',
    Protocol,
    Endpoint,
    TopicArn: TOPIC_ARN,
  });
  const subscriptions = [
    subscription('new@example.com', 'PendingConfirmation'),
    subscription('reader@example.com', SUBSCRIPTION_ARN),
    subscription('json@example.com', `${TOPIC_ARN}:1d4c`, 'email-json'),
    // Not newsletter subscribers: an integration queue and an expired confirmation.
    subscription('arn:aws:sqs:eu-west-3:123456789012:audit', `${TOPIC_ARN}:9f2a`, 'sqs'),
    subscription('gone@example.com', 'Deleted'),
  ];

  test('anonymous callers get 401 and users without SUBSCRIPTION_READ get 403', async () => {
    const anonymous = await list();
    assert.equal(anonymous.statusCode, 401);
    assert.equal(parse(anonymous).error.code, 'UNAUTHORIZED');
    for (const user of [users.editor, users.author, users.noRole]) {
      const res = await list({ as: user });
      assert.equal(res.statusCode, 403, user.name);
      assert.equal(parse(res).error.code, 'FORBIDDEN');
    }
    // Permission is checked before the query string: no validation detail leaks to non-admins.
    assert.equal((await list({ as: users.editor, query: { unknown: 'x' } })).statusCode, 403);
    assert.equal(snsMock.calls().length, 0);
  });

  test('administrators list the e-mail subscribers with their confirmation status', async () => {
    snsMock.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: subscriptions, NextToken: 'next-page-token' });
    const res = await list({ as: users.admin });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      items: [
        { email: 'new@example.com', status: 'pending_confirmation', subscriptionArn: null },
        { email: 'reader@example.com', status: 'confirmed', subscriptionArn: SUBSCRIPTION_ARN },
        { email: 'json@example.com', status: 'confirmed', subscriptionArn: `${TOPIC_ARN}:1d4c` },
      ],
      nextCursor: 'next-page-token',
    });
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(snsMock.commandCalls(ListSubscriptionsByTopicCommand)[0].args[0].input, {
      TopicArn: TOPIC_ARN,
      NextToken: undefined,
    });
  });

  test('the cursor is the SNS NextToken; the last page has a null nextCursor', async () => {
    snsMock.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [] });
    const res = await list({ as: users.admin, query: { cursor: 'next-page-token' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), { items: [], nextCursor: null });
    assert.equal(snsMock.commandCalls(ListSubscriptionsByTopicCommand)[0].args[0].input.NextToken, 'next-page-token');

    snsMock.on(ListSubscriptionsByTopicCommand).resolves({});
    assert.deepEqual(parse(await list({ as: users.admin })), { items: [], nextCursor: null });
  });

  test('invalid query strings and cursors are rejected with 400', async () => {
    for (const query of [{ limit: '10' }, { cursor: '' }, { cursor: 'x'.repeat(2049) }]) {
      const res = await list({ as: users.admin, query });
      assert.equal(res.statusCode, 400, JSON.stringify(query));
      assert.equal(parse(res).error.code, 'VALIDATION_ERROR');
    }
    assert.equal(snsMock.calls().length, 0);

    snsMock.on(ListSubscriptionsByTopicCommand).rejects(awsError('InvalidParameterException', 'Invalid parameter: NextToken'));
    const res = await list({ as: users.admin, query: { cursor: 'forged' } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parse(res).error, { code: 'BAD_REQUEST', message: 'Invalid pagination cursor' });
  });

  test('SNS throttling is a 503 and unexpected errors a 500', async () => {
    snsMock.on(ListSubscriptionsByTopicCommand).rejects(awsError('ThrottledException', 'Rate exceeded'));
    const throttled = await list({ as: users.admin });
    assert.equal(throttled.statusCode, 503);
    assert.equal(parse(throttled).error.code, 'SERVICE_UNAVAILABLE');

    snsMock.on(ListSubscriptionsByTopicCommand).rejects(awsError('NotFoundException', 'Topic does not exist'));
    const missing = await list({ as: users.admin });
    assert.equal(missing.statusCode, 500);
    assert.ok(!missing.body.includes('Topic does not exist'));

    // Without a cursor, InvalidParameter is a server-side problem, not a client error.
    snsMock.on(ListSubscriptionsByTopicCommand).rejects(awsError('InvalidParameterException', 'Invalid parameter: TopicArn'));
    assert.equal((await list({ as: users.admin })).statusCode, 500);
  });
});
