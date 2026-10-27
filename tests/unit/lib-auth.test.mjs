import '../helpers/env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRoles, can, canActOn, PERMISSIONS, ROLES, extractBearerToken, resolveIdentity, identityFromClaims,
} from '../../src/lib/auth.mjs';
import { handler as authorizer, stageWildcardArn } from '../../src/functions/authorizer/index.mjs';
import { apiEvent, users } from '../helpers/events.mjs';
import { installTestVerifier, signIdToken } from '../helpers/jwt.mjs';

before(() => installTestVerifier());

test('parseRoles handles every claim format', () => {
  assert.deepEqual(parseRoles(['editor', 'admin']), ['admin', 'editor']);
  assert.deepEqual(parseRoles('admin,editor'), ['admin', 'editor']);
  assert.deepEqual(parseRoles('[guest-author editor]'), ['editor', 'guest-author']);
  assert.deepEqual(parseRoles('["editor"]'), ['editor']);
  assert.deepEqual(parseRoles('unknown'), []);
  assert.deepEqual(parseRoles(undefined), []);
});

test('permission matrix', () => {
  const identity = (roles) => ({ userId: 'u', roles });
  assert.equal(can(identity(['admin']), PERMISSIONS.USER_MANAGE), true);
  assert.equal(can(identity(['editor']), PERMISSIONS.USER_MANAGE), false);
  assert.equal(can(identity(['editor']), PERMISSIONS.POST_PUBLISH), true);
  assert.equal(can(identity(['guest-author']), PERMISSIONS.POST_PUBLISH), false);
  assert.equal(can(identity(['guest-author']), PERMISSIONS.POST_CREATE), true);
  assert.equal(can(identity([]), PERMISSIONS.POST_CREATE), false);
  assert.equal(can(null, PERMISSIONS.POST_CREATE), false);
  const author = { userId: 'me', roles: [ROLES.GUEST_AUTHOR] };
  assert.equal(canActOn(author, 'me', PERMISSIONS.POST_UPDATE_OWN, PERMISSIONS.POST_UPDATE_ANY), true);
  assert.equal(canActOn(author, 'other', PERMISSIONS.POST_UPDATE_OWN, PERMISSIONS.POST_UPDATE_ANY), false);
});

test('extractBearerToken accepts Bearer and raw tokens only when JWT-shaped', () => {
  assert.equal(extractBearerToken('Bearer a.b.c'), 'a.b.c');
  assert.equal(extractBearerToken('bearer  a.b.c '), 'a.b.c');
  assert.equal(extractBearerToken('a.b.c'), 'a.b.c');
  assert.equal(extractBearerToken('Basic dXNlcg=='), null);
  assert.equal(extractBearerToken(''), null);
});

test('resolveIdentity: authorizer context, optional and required modes', async () => {
  const fromContext = await resolveIdentity(apiEvent({ as: users.editor }), 'required');
  assert.equal(fromContext.userId, users.editor.userId);
  assert.deepEqual(fromContext.roles, ['editor']);

  assert.equal(await resolveIdentity(apiEvent({}), 'optional'), null);
  await assert.rejects(resolveIdentity(apiEvent({}), 'required'), { statusCode: 401 });

  const token = signIdToken(users.author);
  const fromToken = await resolveIdentity(apiEvent({ token }), 'optional');
  assert.equal(fromToken.userId, users.author.userId);
  assert.equal(fromToken.name, 'Gaby Guest');
  assert.deepEqual(fromToken.roles, ['guest-author']);

  const expired = signIdToken(users.author, { expiresIn: -10 });
  await assert.rejects(resolveIdentity(apiEvent({ token: expired }), 'optional'), { statusCode: 401 });
  const wrongAudience = signIdToken(users.author, { overrides: { aud: 'another-client' } });
  await assert.rejects(resolveIdentity(apiEvent({ token: wrongAudience }), 'optional'), { statusCode: 401 });
  const accessToken = signIdToken(users.author, { overrides: { token_use: 'access' } });
  await assert.rejects(resolveIdentity(apiEvent({ token: accessToken }), 'optional'), { statusCode: 401 });
  await assert.rejects(resolveIdentity(apiEvent({ headers: { Authorization: 'Basic abc' } }), 'optional'), { statusCode: 401 });
  assert.equal(await resolveIdentity(apiEvent({ token }), 'none'), null);
});

test('identityFromClaims falls back to the e-mail local part for the name', () => {
  const identity = identityFromClaims({ sub: 's', email: 'jane@example.com', 'cognito:groups': ['editor'] });
  assert.equal(identity.name, 'jane');
  assert.equal(identity.role, 'editor');
});

test('authorizer returns a stage-wide policy and the identity context', async () => {
  const methodArn = 'arn:aws:execute-api:eu-west-3:123456789012:abc123/dev/GET/posts/42';
  assert.equal(stageWildcardArn(methodArn), 'arn:aws:execute-api:eu-west-3:123456789012:abc123/dev/*');
  const result = await authorizer({ type: 'TOKEN', methodArn, authorizationToken: `Bearer ${signIdToken(users.admin)}` });
  assert.equal(result.principalId, users.admin.userId);
  assert.equal(result.policyDocument.Statement[0].Effect, 'Allow');
  assert.deepEqual(result.context, { userId: users.admin.userId, email: users.admin.email, name: users.admin.name, roles: 'admin' });
  await assert.rejects(authorizer({ methodArn, authorizationToken: 'Bearer nope' }), /Unauthorized/);
  await assert.rejects(authorizer({ methodArn, authorizationToken: `Bearer ${signIdToken(users.admin, { expiresIn: -5 })}` }), /Unauthorized/);
});
