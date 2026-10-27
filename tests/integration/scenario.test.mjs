// End-to-end scenario against DynamoDB Local (real queries, GSIs, transactions, conditions
// and stream projections). Other AWS services (S3, SNS, EventBridge, Cognito) are mocked.
//
//   npm run ddb:start && npm run test:integration
//
import '../helpers/env.mjs';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { resetClients, dynamo } from '../../src/lib/aws.mjs';
import { keys } from '../../src/lib/db.mjs';
import { apiEvent, parse, users } from '../helpers/events.mjs';
import { installTestVerifier, signIdToken } from '../helpers/jwt.mjs';
import {
  createTableFromTemplate,
  deleteTable,
  ENDPOINT,
  isDynamoLocalAvailable,
  StreamReplayer,
} from './helpers/dynamodb-local.mjs';

const available = await isDynamoLocalAvailable();
const TABLE = `blogify-it-${Date.now()}`;

const s3 = mockClient(S3Client);
const sns = mockClient(SNSClient);
const events = mockClient(EventBridgeClient);

let postsQuery;
let postsCommand;
let comments;
let media;
let mediaProcessor;
let search;
let projector;
let notifier;
let replayer;

const call = (handler, options) => handler(apiEvent(options), { awsRequestId: 'it' });

describe('Blogify end-to-end scenario (DynamoDB Local)', { skip: !available && `DynamoDB Local not reachable on ${ENDPOINT} (npm run ddb:start)` }, () => {
  const state = {};

  before(async () => {
    process.env.DYNAMODB_ENDPOINT = ENDPOINT;
    process.env.TABLE_NAME = TABLE;
    process.env.MEDIA_CDN_DOMAIN = 'cdn.example.com';
    resetClients();
    installTestVerifier();
    await createTableFromTemplate(TABLE);
    ({ handler: postsQuery } = await import('../../src/functions/posts-query/index.mjs'));
    ({ handler: postsCommand } = await import('../../src/functions/posts-command/index.mjs'));
    ({ handler: comments } = await import('../../src/functions/comments/index.mjs'));
    ({ handler: media } = await import('../../src/functions/media/index.mjs'));
    ({ handler: mediaProcessor } = await import('../../src/functions/media-processor/index.mjs'));
    ({ handler: search } = await import('../../src/functions/search/index.mjs'));
    ({ handler: projector } = await import('../../src/functions/projector/index.mjs'));
    ({ handler: notifier } = await import('../../src/functions/notifier/index.mjs'));
    replayer = new StreamReplayer(TABLE, { projector, notifier });
    sns.on(PublishCommand).resolves({ MessageId: 'm-1' });
    events.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e-1' }] });
  });

  after(async () => {
    await deleteTable(TABLE);
  });

  test('a guest author creates a draft that stays private', async () => {
    const res = await call(postsCommand, {
      method: 'POST',
      resource: '/posts',
      as: users.author,
      body: {
        title: 'Architecture Serverless avec AWS Lambda',
        content: '# Introduction\n\nUn article sur **DynamoDB**, API Gateway et Lambda. Lambda Lambda.',
        tags: ['AWS', 'Serverless'],
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    state.post = parse(res);
    assert.equal(state.post.status, 'draft');
    assert.equal(state.post.slug, 'architecture-serverless-avec-aws-lambda');
    assert.deepEqual(state.post.tags, ['aws', 'serverless']);
    assert.equal(res.headers.ETag, '"v1"');

    const anonymous = await call(postsQuery, { resource: '/posts/{postId}', params: { postId: state.post.id } });
    assert.equal(anonymous.statusCode, 404);
    const own = await call(postsQuery, {
      resource: '/posts/{postId}',
      params: { postId: state.post.id },
      token: signIdToken(users.author),
    });
    assert.equal(own.statusCode, 200);
    assert.ok(parse(own).content.includes('DynamoDB'));
  });

  test('slugs are unique: a second post with the same title gets a suffix', async () => {
    const res = await call(postsCommand, {
      method: 'POST',
      resource: '/posts',
      as: users.author2,
      body: { title: 'Architecture Serverless avec AWS Lambda', content: 'Autre article' },
    });
    assert.equal(res.statusCode, 201, res.body);
    state.otherPost = parse(res);
    assert.equal(state.otherPost.slug, 'architecture-serverless-avec-aws-lambda-2');
  });

  test('optimistic locking with If-Match', async () => {
    const ok = await call(postsCommand, {
      method: 'PATCH',
      resource: '/posts/{postId}',
      params: { postId: state.post.id },
      headers: { 'If-Match': '"v1"' },
      as: users.author,
      body: { excerpt: 'Résumé personnalisé', tags: ['aws', 'serverless', 'dynamodb'] },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(parse(ok).version, 2);
    assert.equal(parse(ok).excerpt, 'Résumé personnalisé');

    const stale = await call(postsCommand, {
      method: 'PATCH',
      resource: '/posts/{postId}',
      params: { postId: state.post.id },
      headers: { 'If-Match': '"v1"' },
      as: users.author,
      body: { title: 'Conflit' },
    });
    assert.equal(stale.statusCode, 412);

    const notOwner = await call(postsCommand, {
      method: 'PATCH',
      resource: '/posts/{postId}',
      params: { postId: state.post.id },
      as: users.author2,
      body: { title: 'Pirate' },
    });
    assert.ok([403, 404].includes(notOwner.statusCode));
  });

  test('editorial workflow: guest author submits, editor publishes', async () => {
    const publishByAuthor = await call(postsCommand, {
      method: 'POST',
      resource: '/posts/{postId}/publish',
      params: { postId: state.post.id },
      as: users.author,
    });
    assert.equal(publishByAuthor.statusCode, 403);

    const submit = await call(postsCommand, {
      method: 'POST',
      resource: '/posts/{postId}/submit',
      params: { postId: state.post.id },
      as: users.author,
    });
    assert.equal(submit.statusCode, 200, submit.body);
    assert.equal(parse(submit).status, 'in_review');

    const queue = await call(postsQuery, {
      resource: '/posts',
      query: { status: 'in_review' },
      token: signIdToken(users.editor),
    });
    assert.equal(queue.statusCode, 200, queue.body);
    assert.ok(parse(queue).items.some((p) => p.id === state.post.id));
    assert.ok(parse(queue).items.every((p) => p.content === undefined), 'listings never include content');

    const publish = await call(postsCommand, {
      method: 'POST',
      resource: '/posts/{postId}/publish',
      params: { postId: state.post.id },
      as: users.editor,
    });
    assert.equal(publish.statusCode, 200, publish.body);
    state.post = parse(publish);
    assert.equal(state.post.status, 'published');
    assert.ok(state.post.publishedAt);

    const again = await call(postsCommand, {
      method: 'POST',
      resource: '/posts/{postId}/publish',
      params: { postId: state.post.id },
      as: users.editor,
    });
    assert.equal(again.statusCode, 409);
  });

  test('stream projections: tags, search index and a single notification', async () => {
    const dispatched = await replayer.drain();
    assert.ok(dispatched.projector.length >= 1);
    assert.equal(sns.commandCalls(PublishCommand).length, 1);
    const publishInput = sns.commandCalls(PublishCommand)[0].args[0].input;
    assert.match(publishInput.Subject, /^[\x20-\x7e]+$/);
    assert.equal(events.commandCalls(PutEventsCommand).length, 1);

    const byTag = await call(postsQuery, { resource: '/posts', query: { tag: 'dynamodb' } });
    assert.equal(byTag.statusCode, 200, byTag.body);
    assert.deepEqual(parse(byTag).items.map((p) => p.id), [state.post.id]);

    const tags = await call(search, { resource: '/tags' });
    assert.equal(tags.statusCode, 200, tags.body);
    assert.deepEqual(
      parse(tags).items.filter((t) => ['aws', 'serverless', 'dynamodb'].includes(t.tag)).map((t) => [t.tag, t.postCount]).sort(),
      [['aws', 1], ['dynamodb', 1], ['serverless', 1]],
    );

    const found = await call(search, { resource: '/search', query: { q: 'lambda dynamodb' } });
    assert.equal(found.statusCode, 200, found.body);
    assert.equal(parse(found).items[0].id, state.post.id);

    const published = await call(postsQuery, { resource: '/posts' });
    assert.deepEqual(parse(published).items.map((p) => p.id), [state.post.id]);

    const bySlug = await call(postsQuery, { resource: '/posts/{postId}', params: { postId: state.post.slug } });
    assert.equal(bySlug.statusCode, 200);
    assert.equal(parse(bySlug).id, state.post.id);

    // Replaying the stream again must neither re-notify nor double count.
    await replayer.drain();
    assert.equal(sns.commandCalls(PublishCommand).length, 1);
  });

  test('comments: anonymous comment is moderated, then counted', async () => {
    const created = await call(comments, {
      method: 'POST',
      resource: '/posts/{postId}/comments',
      params: { postId: state.post.id },
      body: { body: 'Très clair, merci !', authorName: 'Lectrice', authorEmail: 'lectrice@example.com' },
    });
    assert.equal(created.statusCode, 201, created.body);
    state.comment = parse(created);
    assert.equal(state.comment.status, 'pending');
    assert.equal(state.comment.authorEmail, undefined);

    const publicList = await call(comments, { resource: '/posts/{postId}/comments', params: { postId: state.post.id } });
    assert.deepEqual(parse(publicList).items, []);

    const queue = await call(comments, { resource: '/comments', query: { status: 'pending' }, as: users.editor });
    assert.equal(queue.statusCode, 200, queue.body);
    const queued = parse(queue).items.find((c) => c.id === state.comment.id);
    assert.ok(queued);
    assert.equal(queued.authorEmail, 'lectrice@example.com');

    const approve = await call(comments, {
      method: 'PATCH',
      resource: '/posts/{postId}/comments/{commentId}',
      params: { postId: state.post.id, commentId: state.comment.id },
      as: users.editor,
      body: { status: 'approved' },
    });
    assert.equal(approve.statusCode, 200, approve.body);

    const staff = await call(comments, {
      method: 'POST',
      resource: '/posts/{postId}/comments',
      params: { postId: state.post.id },
      token: signIdToken(users.author2),
      body: { body: 'Réponse de l’équipe', parentId: state.comment.id },
    });
    assert.equal(staff.statusCode, 201, staff.body);
    assert.equal(parse(staff).status, 'approved');

    const list = await call(comments, { resource: '/posts/{postId}/comments', params: { postId: state.post.id } });
    assert.deepEqual(parse(list).items.map((c) => c.id), [state.comment.id, parse(staff).id]);
    assert.ok(!list.body.includes('lectrice@example.com'));

    const post = await call(postsQuery, { resource: '/posts/{postId}', params: { postId: state.post.id } });
    assert.equal(parse(post).commentCount, 2);

    // A comment-count change alone must not trigger a re-notification.
    await replayer.drain();
    assert.equal(sns.commandCalls(PublishCommand).length, 1);
  });

  test('media: presigned upload then validation by the processor', async () => {
    const created = await call(media, {
      method: 'POST',
      resource: '/media',
      as: users.author,
      body: { filename: 'Mon Schéma.PNG', contentType: 'image/png', size: 2048 },
    });
    assert.equal(created.statusCode, 201, created.body);
    state.media = parse(created);
    assert.equal(state.media.status, 'pending');
    assert.equal(state.media.upload.method, 'POST');
    assert.ok(state.media.upload.fields.Policy);

    const { Item } = await dynamo().send(new GetCommand({ TableName: TABLE, Key: keys.media(state.media.id) }));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    s3.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/png' });
    s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => png } });
    s3.on(DeleteObjectCommand).resolves({});
    await mediaProcessor({
      source: 'aws.s3',
      'detail-type': 'Object Created',
      detail: { bucket: { name: 'blogify-test-media' }, object: { key: Item.s3Key, size: 2048 } },
    });

    const ready = await call(media, { resource: '/media/{mediaId}', params: { mediaId: state.media.id } });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(parse(ready).status, 'ready');
    assert.equal(parse(ready).url, `https://cdn.example.com/${Item.s3Key}`);

    const mine = await call(media, { resource: '/media', as: users.author });
    assert.deepEqual(parse(mine).items.map((m) => m.id), [state.media.id]);
    const others = await call(media, { resource: '/media', as: users.author2 });
    assert.deepEqual(parse(others).items, []);
  });

  test('unpublish and delete clean every projection', async () => {
    const unpublish = await call(postsCommand, {
      method: 'POST',
      resource: '/posts/{postId}/unpublish',
      params: { postId: state.post.id },
      as: users.editor,
    });
    assert.equal(unpublish.statusCode, 200, unpublish.body);
    await replayer.drain();

    const tags = await call(search, { resource: '/tags' });
    assert.equal(parse(tags).items.filter((t) => ['aws', 'serverless', 'dynamodb'].includes(t.tag)).length, 0);
    const found = await call(search, { resource: '/search', query: { q: 'lambda' } });
    assert.deepEqual(parse(found).items, []);

    const remove = await call(postsCommand, {
      method: 'DELETE',
      resource: '/posts/{postId}',
      params: { postId: state.post.id },
      as: users.editor,
    });
    assert.equal(remove.statusCode, 204, remove.body);
    await replayer.drain();

    const partition = await dynamo().send(
      new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `POST#${state.post.id}` } }),
    );
    assert.equal(partition.Items.length, 0, 'comments and markers are deleted by the projector');
    const slug = await dynamo().send(new GetCommand({ TableName: TABLE, Key: keys.slug(state.post.slug) }));
    assert.equal(slug.Item, undefined);
    const gone = await call(postsQuery, { resource: '/posts/{postId}', params: { postId: state.post.slug } });
    assert.equal(gone.statusCode, 404);
  });
});
