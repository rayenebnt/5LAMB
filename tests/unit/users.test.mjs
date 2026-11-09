import '../helpers/env.mjs';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import * as idp from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { handler, routes } from '../../src/functions/users/index.mjs';
import { PERMISSIONS } from '../../src/lib/auth.mjs';
import { apiEvent, lambdaContext, parse, users } from '../helpers/events.mjs';
import { apiRoutes } from '../helpers/template.mjs';

const {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
} = idp;

const cognito = mockClient(CognitoIdentityProviderClient);
const ddb = mockClient(DynamoDBDocumentClient);

const POOL_ID = 'eu-west-3_TestPool1';
const TARGET = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const OTHER = '0192f3a4-5b6c-7d8e-9f01-000000000002';
const CREATED = '2026-01-02T03:04:05.000Z';
const MODIFIED = '2026-02-03T04:05:06.000Z';

function cognitoError(name, message = `${name}: detailed message from Cognito`) {
  return new idp[name]({ message, $metadata: { httpStatusCode: 400 } });
}

function call(options) {
  return handler(apiEvent(options), lambdaContext);
}

function assertError(res, statusCode, code) {
  assert.equal(res.statusCode, statusCode, res.body);
  assert.equal(parse(res).error.code, code);
  assert.ok(!res.body.includes('detailed message from Cognito'), 'Cognito messages must not be forwarded');
}

const commandNames = () => cognito.calls().map((c) => c.args[0].constructor.name);
const inputOf = (command, index = 0) => cognito.commandCalls(command)[index].args[0].input;

/** A Cognito UserType as returned by ListUsers / ListUsersInGroup / AdminCreateUser. */
function cognitoUser({ sub = TARGET, email = 'target@example.com', name = 'Terry Target', status = 'CONFIRMED', enabled = true } = {}) {
  return {
    Username: sub,
    Attributes: [
      { Name: 'sub', Value: sub },
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: name },
    ],
    UserCreateDate: new Date(CREATED),
    UserLastModifiedDate: new Date(MODIFIED),
    Enabled: enabled,
    UserStatus: status,
  };
}

/** AdminGetUser response for the same user. */
function adminGetUser(options) {
  const { Attributes, ...user } = cognitoUser(options);
  return { ...user, UserAttributes: Attributes };
}

const groupsResponse = (...names) => ({ Groups: names.map((GroupName) => ({ GroupName, UserPoolId: POOL_ID })) });

function profileItem(identity, overrides = {}) {
  return {
    PK: `USER#${identity.userId}`,
    SK: 'PROFILE',
    entityType: 'PROFILE',
    userId: identity.userId,
    email: identity.email,
    displayName: identity.name,
    bio: 'I write about serverless.',
    avatarUrl: 'https://cdn.example.com/avatar.png',
    website: null,
    createdAt: CREATED,
    updatedAt: MODIFIED,
    ...overrides,
  };
}

beforeEach(() => {
  cognito.reset();
  ddb.reset();
});

test('routes match the UsersFunction events of template.yaml', () => {
  const templateRoutes = apiRoutes().filter((route) => route.functionId === 'UsersFunction');
  assert.deepEqual(Object.keys(routes).sort(), templateRoutes.map((route) => route.routeKey).sort());
  for (const route of templateRoutes) {
    assert.equal(routes[route.routeKey].auth, route.publicRoute ? 'none' : 'required', route.routeKey);
  }
});

describe('GET /me', () => {
  test('returns the profile with the roles and sorted permissions of the caller', async () => {
    ddb.on(GetCommand).resolves({ Item: profileItem(users.author, { displayName: 'Gaby (profile)' }) });
    const res = await call({ resource: '/me', as: users.author });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      id: users.author.userId,
      email: users.author.email,
      name: 'Gaby (profile)',
      role: 'guest-author',
      roles: ['guest-author'],
      permissions: ['media:upload', 'post:create', 'post:delete:own', 'post:submit', 'post:update:own'],
      bio: 'I write about serverless.',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      website: null,
      createdAt: CREATED,
      updatedAt: MODIFIED,
    });
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(ddb.commandCalls(GetCommand)[0].args[0].input, {
      TableName: 'blogify-test',
      Key: { PK: `USER#${users.author.userId}`, SK: 'PROFILE' },
      ConsistentRead: true,
    });
    assert.equal(ddb.commandCalls(PutCommand).length, 0);
  });

  test('administrators get every permission', async () => {
    ddb.on(GetCommand).resolves({ Item: profileItem(users.admin) });
    const body = parse(await call({ resource: '/me', as: users.admin }));
    assert.equal(body.role, 'admin');
    assert.deepEqual(body.permissions, Object.values(PERMISSIONS).sort());
  });

  test('a user without role has no permission', async () => {
    ddb.on(GetCommand).resolves({ Item: profileItem(users.noRole) });
    const body = parse(await call({ resource: '/me', as: users.noRole }));
    assert.equal(body.role, null);
    assert.deepEqual(body.roles, []);
    assert.deepEqual(body.permissions, []);
  });

  test('creates the profile from the token identity on first access', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    const res = await call({ resource: '/me', as: users.editor });

    assert.equal(res.statusCode, 200, res.body);
    const put = ddb.commandCalls(PutCommand)[0].args[0].input;
    assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)');
    assert.equal(put.Item.PK, `USER#${users.editor.userId}`);
    assert.equal(put.Item.entityType, 'PROFILE');
    assert.equal(put.Item.displayName, 'Eddie Editor');
    const body = parse(res);
    assert.equal(body.name, 'Eddie Editor');
    assert.equal(body.email, users.editor.email);
    assert.equal(body.bio, null);
    assert.equal(body.createdAt, put.Item.createdAt);
    assert.equal(body.PK, undefined);
    assert.equal(body.entityType, undefined);
  });

  test('a profile created concurrently is read back', async () => {
    ddb.on(GetCommand)
      .resolvesOnce({})
      .resolves({ Item: profileItem(users.author, { bio: 'Written by the other request' }) });
    ddb.on(PutCommand).rejects(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));
    const res = await call({ resource: '/me', as: users.author });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).bio, 'Written by the other request');
    assert.equal(ddb.commandCalls(GetCommand).length, 2);
  });

  test('requires authentication', async () => {
    assertError(await call({ resource: '/me' }), 401, 'UNAUTHORIZED');
    assert.equal(ddb.calls().length, 0);
  });
});

describe('PATCH /me', () => {
  const patchMe = (body, as = users.author) => call({ method: 'PATCH', resource: '/me', as, body });

  test('updates the profile (upsert) and pushes a new name to Cognito', async () => {
    cognito.on(AdminUpdateUserAttributesCommand).resolves({});
    ddb.on(UpdateCommand).resolves({
      Attributes: profileItem(users.author, { displayName: 'Gabrielle', bio: 'New bio', updatedAt: '2026-10-27T10:00:00.000Z' }),
    });
    const res = await patchMe({ name: '  Gabrielle ', bio: ' New bio ' });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).name, 'Gabrielle');
    assert.equal(parse(res).bio, 'New bio');
    assert.equal(parse(res).role, 'guest-author');
    assert.deepEqual(inputOf(AdminUpdateUserAttributesCommand), {
      UserPoolId: POOL_ID,
      Username: users.author.userId,
      UserAttributes: [{ Name: 'name', Value: 'Gabrielle' }],
    });

    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    assert.deepEqual(update.Key, { PK: `USER#${users.author.userId}`, SK: 'PROFILE' });
    assert.equal(update.ReturnValues, 'ALL_NEW');
    assert.equal(update.ConditionExpression, undefined, 'upsert: the profile may not exist yet');
    const clauses = update.UpdateExpression.replace(/^SET /, '').split(/, (?=#)/);
    assert.deepEqual(clauses.sort(), [
      '#avatarUrl = if_not_exists(#avatarUrl, :avatarUrl)',
      '#bio = :bio',
      '#createdAt = if_not_exists(#createdAt, :createdAt)',
      '#displayName = :displayName',
      '#email = :email',
      '#entityType = :entityType',
      '#updatedAt = :updatedAt',
      '#userId = :userId',
      '#website = if_not_exists(#website, :website)',
    ]);
    const values = update.ExpressionAttributeValues;
    assert.equal(values[':displayName'], 'Gabrielle');
    assert.equal(values[':bio'], 'New bio');
    assert.equal(values[':avatarUrl'], null);
    assert.equal(values[':entityType'], 'PROFILE');
    assert.equal(values[':email'], users.author.email);
    assert.equal(values[':createdAt'], values[':updatedAt']);
    assert.equal(update.ExpressionAttributeNames['#displayName'], 'displayName');
  });

  test('without a name, Cognito is not called and the current name is kept', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: profileItem(users.author, { website: 'https://gaby.dev', avatarUrl: null }) });
    const res = await patchMe({ website: 'https://gaby.dev', avatarUrl: null, bio: '' });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(cognito.calls().length, 0);
    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    assert.ok(update.UpdateExpression.includes('#displayName = if_not_exists(#displayName, :displayName)'));
    assert.equal(update.ExpressionAttributeValues[':displayName'], users.author.name);
    assert.ok(update.UpdateExpression.includes('#avatarUrl = :avatarUrl'), 'null clears the avatar');
    assert.equal(update.ExpressionAttributeValues[':avatarUrl'], null);
    assert.equal(update.ExpressionAttributeValues[':bio'], null, 'an empty biography is stored as null');
    assert.equal(update.ExpressionAttributeValues[':website'], 'https://gaby.dev');
    assert.equal(parse(res).website, 'https://gaby.dev');
  });

  test('a Cognito failure on the name leaves the profile untouched', async () => {
    cognito.on(AdminUpdateUserAttributesCommand).rejects(cognitoError('TooManyRequestsException'));
    assertError(await patchMe({ name: 'Gabrielle' }), 429, 'TOO_MANY_REQUESTS');
    assert.equal(ddb.calls().length, 0);
  });

  test('rejects invalid or unknown fields (role and e-mail cannot be changed here)', async () => {
    const invalid = [
      {},
      { role: 'admin' },
      { email: 'new@example.com' },
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(81) },
      { name: null },
      { bio: 'x'.repeat(1001) },
      { avatarUrl: 'javascript:alert(1)' },
      { avatarUrl: '' },
      { website: 'not a url' },
      { website: 'ftp://files.example.com' },
    ];
    for (const body of invalid) assertError(await patchMe(body), 400, 'VALIDATION_ERROR');
    assert.equal(cognito.calls().length, 0);
    assert.equal(ddb.calls().length, 0);
  });

  test('requires authentication', async () => {
    assertError(await call({ method: 'PATCH', resource: '/me', body: { bio: 'x' } }), 401, 'UNAUTHORIZED');
  });
});

describe('GET /authors/{userId}', () => {
  test('returns the public profile only (never the e-mail address)', async () => {
    ddb.on(GetCommand).resolves({ Item: profileItem(users.author) });
    const res = await call({ resource: '/authors/{userId}', params: { userId: users.author.userId } });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      id: users.author.userId,
      name: users.author.name,
      bio: 'I write about serverless.',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      website: null,
    });
    assert.ok(!res.body.includes('@example.com'));
    assert.match(res.headers['Cache-Control'], /^public/);
    assert.deepEqual(ddb.commandCalls(GetCommand)[0].args[0].input.Key, { PK: `USER#${users.author.userId}`, SK: 'PROFILE' });
  });

  test('unknown authors are 404, malformed identifiers 400', async () => {
    ddb.on(GetCommand).resolves({});
    assertError(await call({ resource: '/authors/{userId}', params: { userId: TARGET } }), 404, 'NOT_FOUND');
    assertError(await call({ resource: '/authors/{userId}', params: { userId: 'jane@example.com' } }), 400, 'VALIDATION_ERROR');
    assert.equal(ddb.commandCalls(GetCommand).length, 1);
  });

  test('identifiers are case-insensitive and the route is public (token ignored)', async () => {
    ddb.on(GetCommand).resolves({ Item: profileItem(users.author) });
    const res = await call({
      resource: '/authors/{userId}',
      params: { userId: users.author.userId.toUpperCase() },
      headers: { Authorization: 'Bearer not.a.valid-token' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(ddb.commandCalls(GetCommand)[0].args[0].input.Key.PK, `USER#${users.author.userId}`);
  });
});

describe('GET /users', () => {
  test('requires authentication and the user:manage permission', async () => {
    assertError(await call({ resource: '/users' }), 401, 'UNAUTHORIZED');
    for (const as of [users.editor, users.author, users.noRole]) {
      assertError(await call({ resource: '/users', as }), 403, 'FORBIDDEN');
    }
    assert.equal(cognito.calls().length, 0);
  });

  test('lists every user with their role (groups looked up per user)', async () => {
    cognito.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser(),
        cognitoUser({ sub: OTHER, email: 'other@example.com', name: 'Olga Other', status: 'FORCE_CHANGE_PASSWORD', enabled: false }),
      ],
      PaginationToken: 'cognito-page-2',
    });
    cognito.on(AdminListGroupsForUserCommand, { Username: TARGET }).resolves(groupsResponse('guest-author', 'editor'));
    cognito.on(AdminListGroupsForUserCommand, { Username: OTHER }).resolves(groupsResponse('beta-testers'));

    const res = await call({ resource: '/users', as: users.admin });
    assert.equal(res.statusCode, 200, res.body);
    const body = parse(res);
    assert.deepEqual(body.items, [
      { id: TARGET, email: 'target@example.com', name: 'Terry Target', status: 'CONFIRMED', enabled: true, role: 'editor', createdAt: CREATED, updatedAt: MODIFIED },
      { id: OTHER, email: 'other@example.com', name: 'Olga Other', status: 'FORCE_CHANGE_PASSWORD', enabled: false, role: null, createdAt: CREATED, updatedAt: MODIFIED },
    ]);
    assert.equal(typeof body.nextCursor, 'string');
    assert.ok(!body.nextCursor.includes('cognito-page-2'), 'the cursor is opaque');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(inputOf(ListUsersCommand), { UserPoolId: POOL_ID, Limit: 20, PaginationToken: undefined });
    assert.deepEqual(
      cognito.commandCalls(AdminListGroupsForUserCommand).map((c) => c.args[0].input.Username).sort(),
      [OTHER, TARGET].sort(),
    );

    cognito.resetHistory();
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    const next = await call({ resource: '/users', query: { cursor: body.nextCursor, limit: '60' }, as: users.admin });
    assert.equal(next.statusCode, 200, next.body);
    assert.deepEqual(parse(next), { items: [], nextCursor: null });
    assert.deepEqual(inputOf(ListUsersCommand), { UserPoolId: POOL_ID, Limit: 60, PaginationToken: 'cognito-page-2' });
  });

  test('filters by role with ListUsersInGroup (no per-user group lookup)', async () => {
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [cognitoUser()], NextToken: 'group-page-2' });
    const res = await call({ resource: '/users', query: { role: 'editor', limit: '5' }, as: users.admin });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res).items.map((u) => [u.id, u.role]), [[TARGET, 'editor']]);
    assert.deepEqual(inputOf(ListUsersInGroupCommand), { UserPoolId: POOL_ID, GroupName: 'editor', Limit: 5, NextToken: undefined });
    assert.equal(cognito.commandCalls(AdminListGroupsForUserCommand).length, 0);
    assert.equal(cognito.commandCalls(ListUsersCommand).length, 0);

    const { nextCursor } = parse(res);
    cognito.resetHistory();
    const next = await call({ resource: '/users', query: { role: 'editor', cursor: nextCursor }, as: users.admin });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(inputOf(ListUsersInGroupCommand).NextToken, 'group-page-2');

    // A cursor is only valid for the filter it was issued for.
    assertError(await call({ resource: '/users', query: { cursor: nextCursor }, as: users.admin }), 400, 'BAD_REQUEST');
    assertError(await call({ resource: '/users', query: { role: 'admin', cursor: nextCursor }, as: users.admin }), 400, 'BAD_REQUEST');
  });

  test('long Cognito pagination tokens fit in the cursor', async () => {
    const longToken = 'T'.repeat(2500);
    cognito.on(ListUsersCommand).resolvesOnce({ Users: [], PaginationToken: longToken }).resolves({ Users: [] });
    const first = parse(await call({ resource: '/users', as: users.admin }));
    assert.ok(first.nextCursor.length > 2048);
    const next = await call({ resource: '/users', query: { cursor: first.nextCursor }, as: users.admin });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(cognito.commandCalls(ListUsersCommand)[1].args[0].input.PaginationToken, longToken);
  });

  test('users deleted while the page is built are skipped', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [cognitoUser(), cognitoUser({ sub: OTHER })] });
    cognito.on(AdminListGroupsForUserCommand, { Username: TARGET }).rejects(cognitoError('UserNotFoundException'));
    cognito.on(AdminListGroupsForUserCommand, { Username: OTHER }).resolves(groupsResponse('admin'));

    const res = await call({ resource: '/users', as: users.admin });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res).items.map((u) => [u.id, u.role]), [[OTHER, 'admin']]);
  });

  test('group lookups run in parallel with a bounded concurrency', async () => {
    const listed = Array.from({ length: 25 }, (_, i) => cognitoUser({ sub: `0192f3a4-5b6c-7d8e-9f01-${String(i).padStart(12, '0')}` }));
    cognito.on(ListUsersCommand).resolves({ Users: listed });
    let inFlight = 0;
    let maxInFlight = 0;
    cognito.on(AdminListGroupsForUserCommand).callsFake(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return groupsResponse('guest-author');
    });

    const res = await call({ resource: '/users', query: { limit: '25' }, as: users.admin });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res).items.map((u) => u.id), listed.map((u) => u.Username), 'order is preserved');
    assert.equal(cognito.commandCalls(AdminListGroupsForUserCommand).length, 25);
    assert.ok(maxInFlight > 1 && maxInFlight <= 10, `max in flight: ${maxInFlight}`);
  });

  test('rejects invalid query parameters and cursors', async () => {
    const invalid = [{ limit: '0' }, { limit: '61' }, { limit: 'ten' }, { role: 'superadmin' }, { sort: 'email' }, { cursor: 'x'.repeat(4097) }];
    for (const query of invalid) assertError(await call({ resource: '/users', query, as: users.admin }), 400, 'VALIDATION_ERROR');
    for (const cursor of ['%%%', Buffer.from('{"token":""}').toString('base64url'), Buffer.from('[1]').toString('base64url')]) {
      assertError(await call({ resource: '/users', query: { cursor }, as: users.admin }), 400, 'BAD_REQUEST');
    }
    assert.equal(cognito.calls().length, 0);
  });

  test('Cognito throttling is answered 429', async () => {
    cognito.on(ListUsersCommand).rejects(cognitoError('TooManyRequestsException'));
    assertError(await call({ resource: '/users', as: users.admin }), 429, 'TOO_MANY_REQUESTS');
  });
});

describe('POST /users', () => {
  const invite = { email: ' New.Editor@Example.com ', name: ' Nina Editor ', role: 'editor' };

  test('creates the account (temporary password e-mailed), its role and its profile', async () => {
    cognito.on(AdminCreateUserCommand).resolves({
      User: cognitoUser({ email: 'new.editor@example.com', name: 'Nina Editor', status: 'FORCE_CHANGE_PASSWORD' }),
    });
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    const res = await call({ method: 'POST', resource: '/users', as: users.admin, body: invite });

    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.headers.Location, `/users/${TARGET}`);
    assert.deepEqual(parse(res), {
      id: TARGET,
      email: 'new.editor@example.com',
      name: 'Nina Editor',
      status: 'FORCE_CHANGE_PASSWORD',
      enabled: true,
      role: 'editor',
      createdAt: CREATED,
      updatedAt: MODIFIED,
    });
    assert.deepEqual(inputOf(AdminCreateUserCommand), {
      UserPoolId: POOL_ID,
      Username: 'new.editor@example.com',
      UserAttributes: [
        { Name: 'email', Value: 'new.editor@example.com' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: 'Nina Editor' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    });
    assert.deepEqual(inputOf(AdminAddUserToGroupCommand), { UserPoolId: POOL_ID, Username: TARGET, GroupName: 'editor' });
    assert.deepEqual(commandNames(), ['AdminCreateUserCommand', 'AdminAddUserToGroupCommand']);
    const put = ddb.commandCalls(PutCommand)[0].args[0].input;
    assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)');
    assert.equal(put.Item.PK, `USER#${TARGET}`);
    assert.equal(put.Item.displayName, 'Nina Editor');
    assert.equal(put.Item.email, 'new.editor@example.com');
  });

  test('an existing profile does not fail the invitation', async () => {
    cognito.on(AdminCreateUserCommand).resolves({ User: cognitoUser() });
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    ddb.on(PutCommand).rejects(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));
    assert.equal((await call({ method: 'POST', resource: '/users', as: users.admin, body: invite })).statusCode, 201);
  });

  test('a role assignment failure is reported and no profile is written', async () => {
    cognito.on(AdminCreateUserCommand).resolves({ User: cognitoUser() });
    cognito.on(AdminAddUserToGroupCommand).rejects(cognitoError('InternalErrorException'));
    assertError(await call({ method: 'POST', resource: '/users', as: users.admin, body: invite }), 500, 'INTERNAL_ERROR');
    assert.equal(ddb.calls().length, 0);
  });

  test('an e-mail address already registered is a 409 USER_EXISTS', async () => {
    cognito.on(AdminCreateUserCommand).rejects(cognitoError('UsernameExistsException'));
    assertError(await call({ method: 'POST', resource: '/users', as: users.admin, body: invite }), 409, 'USER_EXISTS');
    assert.deepEqual(commandNames(), ['AdminCreateUserCommand']);
    assert.equal(ddb.calls().length, 0);
  });

  test('validates the body', async () => {
    const invalid = [
      {},
      { ...invite, role: 'superadmin' },
      { ...invite, role: undefined },
      { ...invite, name: '' },
      { ...invite, email: 'not-an-email' },
      { ...invite, password: 'Passw0rdX' },
    ];
    for (const body of invalid) assertError(await call({ method: 'POST', resource: '/users', as: users.admin, body }), 400, 'VALIDATION_ERROR');
    assert.equal(cognito.calls().length, 0);
  });

  test('requires authentication and the user:manage permission', async () => {
    assertError(await call({ method: 'POST', resource: '/users', body: invite }), 401, 'UNAUTHORIZED');
    assertError(await call({ method: 'POST', resource: '/users', as: users.editor, body: invite }), 403, 'FORBIDDEN');
    assertError(await call({ method: 'POST', resource: '/users', as: users.author, body: { ...invite, role: 'admin' } }), 403, 'FORBIDDEN');
    assert.equal(cognito.calls().length, 0);
  });
});

describe('PATCH /users/{userId}', () => {
  const patchUser = (body, { userId = TARGET, as = users.admin } = {}) =>
    call({ method: 'PATCH', resource: '/users/{userId}', params: { userId }, as, body });

  test('changes the role: leaves the other role groups, then joins the new one', async () => {
    cognito.on(AdminListGroupsForUserCommand).resolves(groupsResponse('guest-author'));
    cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    cognito.on(AdminGetUserCommand).resolves(adminGetUser());
    const res = await patchUser({ role: 'editor' });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      id: TARGET,
      email: 'target@example.com',
      name: 'Terry Target',
      status: 'CONFIRMED',
      enabled: true,
      role: 'editor',
      createdAt: CREATED,
      updatedAt: MODIFIED,
    });
    assert.deepEqual(commandNames(), [
      'AdminListGroupsForUserCommand',
      'AdminRemoveUserFromGroupCommand',
      'AdminAddUserToGroupCommand',
      'AdminGetUserCommand',
    ]);
    assert.deepEqual(inputOf(AdminRemoveUserFromGroupCommand), { UserPoolId: POOL_ID, Username: TARGET, GroupName: 'guest-author' });
    assert.deepEqual(inputOf(AdminAddUserToGroupCommand), { UserPoolId: POOL_ID, Username: TARGET, GroupName: 'editor' });
    assert.deepEqual(inputOf(AdminGetUserCommand), { UserPoolId: POOL_ID, Username: TARGET });
  });

  test('only role groups are left, other groups are kept', async () => {
    cognito.on(AdminListGroupsForUserCommand).resolves(groupsResponse('editor', 'guest-author', 'newsletter'));
    cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    cognito.on(AdminGetUserCommand).resolves(adminGetUser());
    const res = await patchUser({ role: 'admin' });

    assert.equal(parse(res).role, 'admin');
    assert.deepEqual(
      cognito.commandCalls(AdminRemoveUserFromGroupCommand).map((c) => c.args[0].input.GroupName).sort(),
      ['editor', 'guest-author'],
    );
  });

  test('setting the current role again changes nothing else', async () => {
    cognito.on(AdminListGroupsForUserCommand).resolves(groupsResponse('editor'));
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    cognito.on(AdminGetUserCommand).resolves(adminGetUser());
    const res = await patchUser({ role: 'editor' });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).role, 'editor');
    assert.equal(cognito.commandCalls(AdminRemoveUserFromGroupCommand).length, 0);
  });

  test('disabling an account also signs the user out everywhere', async () => {
    cognito.on(AdminDisableUserCommand).resolves({});
    cognito.on(AdminUserGlobalSignOutCommand).resolves({});
    cognito.on(AdminGetUserCommand).resolves(adminGetUser({ enabled: false }));
    cognito.on(AdminListGroupsForUserCommand).resolves(groupsResponse('guest-author'));
    const res = await patchUser({ enabled: false });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).enabled, false);
    assert.equal(parse(res).role, 'guest-author');
    const names = commandNames();
    assert.deepEqual(names.slice(0, 2), ['AdminDisableUserCommand', 'AdminUserGlobalSignOutCommand']);
    assert.deepEqual(names.slice(2).sort(), ['AdminGetUserCommand', 'AdminListGroupsForUserCommand']);
    assert.deepEqual(inputOf(AdminDisableUserCommand), { UserPoolId: POOL_ID, Username: TARGET });
    assert.deepEqual(inputOf(AdminUserGlobalSignOutCommand), { UserPoolId: POOL_ID, Username: TARGET });
  });

  test('enabling an account', async () => {
    cognito.on(AdminEnableUserCommand).resolves({});
    cognito.on(AdminGetUserCommand).resolves(adminGetUser());
    cognito.on(AdminListGroupsForUserCommand).resolves(groupsResponse('editor'));
    const res = await patchUser({ enabled: true });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).enabled, true);
    assert.deepEqual(inputOf(AdminEnableUserCommand), { UserPoolId: POOL_ID, Username: TARGET });
    assert.equal(cognito.commandCalls(AdminUserGlobalSignOutCommand).length, 0);
  });

  test('role and enabled state in one request', async () => {
    cognito.on(AdminListGroupsForUserCommand).resolves(groupsResponse('admin'));
    cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    cognito.on(AdminDisableUserCommand).resolves({});
    cognito.on(AdminUserGlobalSignOutCommand).resolves({});
    cognito.on(AdminGetUserCommand).resolves(adminGetUser({ enabled: false }));
    const res = await patchUser({ role: 'guest-author', enabled: false });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      { role: parse(res).role, enabled: parse(res).enabled },
      { role: 'guest-author', enabled: false },
    );
    assert.equal(cognito.commandCalls(AdminListGroupsForUserCommand).length, 1, 'groups are known after the role change');
  });

  test('administrators cannot modify their own account (409 SELF_MODIFICATION)', async () => {
    const self = users.admin.userId;
    for (const body of [{ role: 'editor' }, { role: 'admin' }, { enabled: false }, { enabled: true }]) {
      assertError(await patchUser(body, { userId: self }), 409, 'SELF_MODIFICATION');
    }
    assertError(await patchUser({ role: 'guest-author' }, { userId: self.toUpperCase() }), 409, 'SELF_MODIFICATION');
    assert.equal(cognito.calls().length, 0);
  });

  test('an unknown user is a 404', async () => {
    cognito.on(AdminListGroupsForUserCommand).rejects(cognitoError('UserNotFoundException'));
    assertError(await patchUser({ role: 'editor' }), 404, 'NOT_FOUND');
    assert.equal(cognito.commandCalls(AdminAddUserToGroupCommand).length, 0);

    cognito.on(AdminDisableUserCommand).rejects(cognitoError('UserNotFoundException'));
    assertError(await patchUser({ enabled: false }), 404, 'NOT_FOUND');
    assert.equal(cognito.commandCalls(AdminUserGlobalSignOutCommand).length, 0);
  });

  test('validates the identifier and the body', async () => {
    assertError(await patchUser({ role: 'editor' }, { userId: 'target@example.com' }), 400, 'VALIDATION_ERROR');
    const invalid = [{}, { role: 'superadmin' }, { enabled: 'false' }, { enabled: null }, { role: 'editor', email: 'x@example.com' }];
    for (const body of invalid) assertError(await patchUser(body), 400, 'VALIDATION_ERROR');
    assert.equal(cognito.calls().length, 0);
  });

  test('requires authentication and the user:manage permission', async () => {
    assertError(await call({ method: 'PATCH', resource: '/users/{userId}', params: { userId: TARGET }, body: { role: 'admin' } }), 401, 'UNAUTHORIZED');
    assertError(await patchUser({ role: 'admin' }, { as: users.editor }), 403, 'FORBIDDEN');
    assertError(await patchUser({ role: 'admin' }, { userId: users.author.userId, as: users.author }), 403, 'FORBIDDEN');
    assert.equal(cognito.calls().length, 0);
  });
});
