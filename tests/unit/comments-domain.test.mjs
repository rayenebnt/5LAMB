import '../helpers/env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  ALL_STATUSES,
  commentCountDelta,
  createComment,
  getCommentItem,
  initialStatus,
  listModerationQueue,
  listPostComments,
  moderateComment,
  MODERATION_STATUSES,
  toApiComment,
} from '../../src/domain/comments.mjs';
import { COMMENT_STATUS } from '../../src/lib/schema.mjs';
import { keys } from '../../src/lib/db.mjs';
import { users } from '../helpers/events.mjs';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

const POST_ID = '01928c5e-7a4b-7c3d-8e9f-0a1b2c3d4e5f';
const COMMENT_ID = '01928c5f-1111-7000-8000-000000000001';

const item = {
  ...keys.comment(POST_ID, COMMENT_ID),
  GSI1PK: 'COMMENTS#approved',
  GSI1SK: `2026-10-20T10:00:00.000Z#${COMMENT_ID}`,
  entityType: 'COMMENT',
  commentId: COMMENT_ID,
  postId: POST_ID,
  postTitle: 'Serverless 101',
  parentId: null,
  body: 'Great article!',
  authorId: null,
  authorName: 'Reader',
  authorEmail: 'reader@example.com',
  status: 'approved',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  moderatedBy: users.editor.userId,
  moderatedAt: '2026-10-21T09:00:00.000Z',
};

const canceled = (...codes) =>
  new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

test('public representation: no e-mail, no moderation data, no internal attributes', () => {
  assert.deepEqual(toApiComment(item), {
    id: COMMENT_ID,
    postId: POST_ID,
    parentId: null,
    body: 'Great article!',
    author: { id: null, name: 'Reader' },
    status: 'approved',
    createdAt: '2026-10-20T10:00:00.000Z',
  });
  assert.deepEqual(toApiComment(item, { moderator: false }), toApiComment(item));
});

test('moderator representation adds e-mail, post title and moderation data', () => {
  assert.deepEqual(toApiComment(item, { moderator: true }), {
    ...toApiComment(item),
    authorEmail: 'reader@example.com',
    postTitle: 'Serverless 101',
    moderatedBy: users.editor.userId,
    moderatedAt: '2026-10-21T09:00:00.000Z',
    updatedAt: '2026-10-21T09:00:00.000Z',
  });
  // Optional attributes missing from an item are exposed as null, never omitted.
  const sparse = { commentId: COMMENT_ID, postId: POST_ID, body: 'x', authorName: 'A', status: 'pending' };
  const api = toApiComment(sparse, { moderator: true });
  for (const field of ['parentId', 'authorEmail', 'postTitle', 'moderatedBy', 'moderatedAt']) {
    assert.equal(api[field], null, field);
  }
  assert.equal(api.author.id, null);
});

test('initialStatus: honeypot first, then role-based auto-approval', () => {
  const identity = (roles) => ({ userId: 'u', name: 'U', email: null, roles });
  assert.equal(initialStatus(null, undefined), COMMENT_STATUS.PENDING);
  assert.equal(initialStatus(identity([]), undefined), COMMENT_STATUS.PENDING);
  for (const role of ['guest-author', 'editor', 'admin']) {
    assert.equal(initialStatus(identity([role]), undefined), COMMENT_STATUS.APPROVED, role);
  }
  assert.equal(initialStatus(null, 'http://spam.example'), COMMENT_STATUS.SPAM);
  assert.equal(initialStatus(identity(['admin']), 'x'), COMMENT_STATUS.SPAM);
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(initialStatus(null, blank), COMMENT_STATUS.PENDING, JSON.stringify(blank));
  }
});

test('commentCountDelta counts only transitions into and out of approved', () => {
  const statuses = [null, ...Object.values(COMMENT_STATUS)];
  for (const from of statuses) {
    for (const to of statuses) {
      let expected = 0;
      if (from !== 'approved' && to === 'approved') expected = 1;
      if (from === 'approved' && to !== 'approved') expected = -1;
      assert.equal(commentCountDelta(from, to), expected, `${from} -> ${to}`);
    }
  }
});

test('moderators can assign approved, rejected or spam (never back to pending)', () => {
  assert.deepEqual([...MODERATION_STATUSES].sort(), ['approved', 'rejected', 'spam']);
  assert.ok(Object.isFrozen(MODERATION_STATUSES));
  assert.equal(ALL_STATUSES, 'all');
});

test('getCommentItem reads the comment key and returns null when absent', async () => {
  ddb.on(GetCommand).resolves({});
  assert.equal(await getCommentItem(POST_ID, COMMENT_ID), null);
  ddb.on(GetCommand).resolves({ Item: item });
  assert.deepEqual(await getCommentItem(POST_ID, COMMENT_ID, { consistent: true }), item);
  const [first, second] = ddb.commandCalls(GetCommand).map((call) => call.args[0].input);
  assert.deepEqual(first.Key, keys.comment(POST_ID, COMMENT_ID));
  assert.equal(first.ConsistentRead, false);
  assert.equal(second.ConsistentRead, true);
});

test('authorisation is enforced by the domain itself (before any read)', async () => {
  const page = { limit: 20 };
  await assert.rejects(listPostComments(null, POST_ID, { ...page, status: 'pending' }), { statusCode: 401 });
  await assert.rejects(listPostComments(users.author, POST_ID, { ...page, status: ALL_STATUSES }), { statusCode: 403 });
  await assert.rejects(listModerationQueue(null, page), { statusCode: 401 });
  await assert.rejects(listModerationQueue(users.author, page), { statusCode: 403 });
  await assert.rejects(moderateComment(users.author, POST_ID, COMMENT_ID, 'approved'), { statusCode: 403 });
  assert.equal(ddb.calls().length, 0);
});

test('createComment returns the stored item: honeypot hits are spam at the domain level', async () => {
  ddb.on(GetCommand).resolves({ Item: { ...keys.post(POST_ID), postId: POST_ID, title: 'T', status: 'published' } });
  const created = await createComment(null, POST_ID, { body: 'Hi', authorName: 'Bot', website: 'x' });
  assert.equal(created.status, 'spam');
  assert.equal(created.GSI1PK, 'COMMENTS#spam');
  assert.equal(created.authorEmail, null);
});

test('a cancellation mixing a conflict with a failed condition is not retried', async () => {
  ddb.on(GetCommand).resolves({ Item: { ...item, status: 'pending' } });
  ddb.on(TransactWriteCommand).rejects(canceled('ConditionalCheckFailed', 'TransactionConflict'));
  await assert.rejects(moderateComment(users.editor, POST_ID, COMMENT_ID, 'approved'), {
    statusCode: 409,
    code: 'CONFLICT',
  });
  assert.equal(ddb.commandCalls(TransactWriteCommand).length, 1);
});

test('other DynamoDB errors propagate unchanged', async () => {
  ddb.on(GetCommand).resolves({ Item: { ...item, status: 'pending' } });
  const failure = Object.assign(new Error('One or more parameter values were invalid'), { name: 'ValidationException' });
  ddb.on(TransactWriteCommand).rejects(failure);
  await assert.rejects(moderateComment(users.editor, POST_ID, COMMENT_ID, 'rejected'), failure);

  const throttled = canceled('ThrottlingError', 'None');
  ddb.on(TransactWriteCommand).rejects(throttled);
  await assert.rejects(moderateComment(users.editor, POST_ID, COMMENT_ID, 'approved'), throttled);
});
