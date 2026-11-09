import '../helpers/env.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import * as idp from '@aws-sdk/client-cognito-identity-provider';
import {
  attributeValue,
  decodeUsersCursor,
  encodeUsersCursor,
  mapCognitoError,
  newProfileItem,
  permissionsOf,
  toApiMe,
  toApiTokens,
  toApiUser,
  toAuthResult,
  toPublicProfile,
  updateUser,
} from '../../src/domain/users.mjs';
import { AppError } from '../../src/lib/errors.mjs';
import { users } from '../helpers/events.mjs';

const cognitoError = (name) => new idp[name]({ message: `${name} from Cognito`, $metadata: {} });

/** [status, code] of the AppError produced for an exception name in a context. */
function mapped(name, context) {
  const result = mapCognitoError(cognitoError(name), context);
  assert.ok(result instanceof AppError, `${name} (${context}) should be mapped`);
  return [result.statusCode, result.code];
}

describe('mapCognitoError', () => {
  const contexts = ['login', 'session', 'account', 'token', 'admin'];

  test('context-independent mappings of the specification', () => {
    const expected = {
      UsernameExistsException: [409, 'USER_EXISTS'],
      InvalidPasswordException: [400, 'INVALID_PASSWORD'],
      InvalidParameterException: [400, 'INVALID_PARAMETER'],
      CodeMismatchException: [400, 'INVALID_CODE'],
      ExpiredCodeException: [400, 'EXPIRED_CODE'],
      UserNotConfirmedException: [403, 'USER_NOT_CONFIRMED'],
      PasswordResetRequiredException: [403, 'PASSWORD_RESET_REQUIRED'],
      LimitExceededException: [429, 'TOO_MANY_REQUESTS'],
      TooManyRequestsException: [429, 'TOO_MANY_REQUESTS'],
      TooManyFailedAttemptsException: [429, 'TOO_MANY_REQUESTS'],
    };
    for (const context of contexts) {
      for (const [name, result] of Object.entries(expected)) {
        assert.deepEqual(mapped(name, context), result, `${name} in ${context}`);
      }
    }
  });

  test('NotAuthorizedException: credentials at login, token on refresh/logout, unexpected for admin calls', () => {
    assert.deepEqual(mapped('NotAuthorizedException', 'login'), [401, 'INVALID_CREDENTIALS']);
    assert.deepEqual(mapped('NotAuthorizedException', 'session'), [401, 'INVALID_CREDENTIALS']);
    assert.deepEqual(mapped('NotAuthorizedException', 'account'), [401, 'INVALID_CREDENTIALS']);
    assert.deepEqual(mapped('NotAuthorizedException', 'token'), [401, 'INVALID_TOKEN']);
    const adminError = cognitoError('NotAuthorizedException');
    assert.equal(mapCognitoError(adminError, 'admin'), adminError, 'rethrown (500)');
  });

  test('UserNotFoundException never reveals an account outside administration', () => {
    assert.deepEqual(mapped('UserNotFoundException', 'login'), [401, 'INVALID_CREDENTIALS']);
    assert.deepEqual(mapped('UserNotFoundException', 'session'), [401, 'INVALID_CREDENTIALS']);
    assert.deepEqual(mapped('UserNotFoundException', 'account'), [400, 'INVALID_CODE']);
    assert.deepEqual(mapped('UserNotFoundException', 'token'), [401, 'INVALID_TOKEN']);
    assert.deepEqual(mapped('UserNotFoundException', 'admin'), [404, 'NOT_FOUND']);
    const login = mapCognitoError(cognitoError('UserNotFoundException'), 'login');
    const wrongPassword = mapCognitoError(cognitoError('NotAuthorizedException'), 'login');
    assert.equal(login.message, wrongPassword.message);
  });

  test('RevokeToken token errors are only mapped for refresh/logout', () => {
    for (const name of ['UnauthorizedException', 'UnsupportedTokenTypeException']) {
      assert.deepEqual(mapped(name, 'token'), [401, 'INVALID_TOKEN']);
      const err = cognitoError(name);
      assert.equal(mapCognitoError(err, 'login'), err);
    }
  });

  test('unexpected errors are returned unchanged (500, details hidden by the router)', () => {
    for (const name of ['InternalErrorException', 'ResourceNotFoundException', 'CodeDeliveryFailureException']) {
      const err = cognitoError(name);
      for (const context of contexts) assert.equal(mapCognitoError(err, context), err);
    }
    const plain = new Error('socket hang up');
    assert.equal(mapCognitoError(plain, 'login'), plain);
    const prototypeName = Object.assign(new Error('weird'), { name: 'toString' });
    assert.equal(mapCognitoError(prototypeName, 'login'), prototypeName);
    assert.equal(mapCognitoError(undefined, 'login'), undefined);
  });

  test('messages never echo the Cognito message', () => {
    for (const name of ['NotAuthorizedException', 'UserNotFoundException', 'InvalidParameterException', 'UsernameExistsException']) {
      for (const context of ['login', 'account', 'token']) {
        const result = mapCognitoError(cognitoError(name), context);
        assert.ok(!result.message.includes('from Cognito'), `${name} ${context}`);
      }
    }
  });
});

describe('representations', () => {
  test('permissionsOf merges, de-duplicates and sorts the permissions of every role', () => {
    assert.deepEqual(permissionsOf(['guest-author']), ['media:upload', 'post:create', 'post:delete:own', 'post:submit', 'post:update:own']);
    const editorAndAuthor = permissionsOf(['editor', 'guest-author']);
    assert.deepEqual(editorAndAuthor, permissionsOf(['editor']));
    assert.deepEqual(editorAndAuthor, [...editorAndAuthor].sort());
    assert.ok(!editorAndAuthor.includes('user:manage'));
    assert.deepEqual(permissionsOf(['unknown']), []);
    assert.deepEqual(permissionsOf([]), []);
    assert.deepEqual(permissionsOf(), []);
  });

  test('toApiUser reads ListUsers and AdminGetUser shapes', () => {
    const attributes = [
      { Name: 'sub', Value: 'sub-1' },
      { Name: 'email', Value: 'a@example.com' },
      { Name: 'name', Value: 'Ann' },
    ];
    const base = {
      Username: 'sub-1',
      UserCreateDate: new Date('2026-01-01T00:00:00Z'),
      UserLastModifiedDate: new Date('2026-01-02T00:00:00Z'),
      Enabled: true,
      UserStatus: 'CONFIRMED',
    };
    const expected = {
      id: 'sub-1',
      email: 'a@example.com',
      name: 'Ann',
      status: 'CONFIRMED',
      enabled: true,
      role: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    assert.deepEqual(toApiUser({ ...base, Attributes: attributes }, ['editor', 'admin']), expected);
    assert.deepEqual(toApiUser({ ...base, UserAttributes: attributes }, ['admin']), expected);

    const minimal = toApiUser({ Username: 'sub-2', UserCreateDate: 'not a date' });
    assert.deepEqual(minimal, {
      id: 'sub-2',
      email: null,
      name: null,
      status: null,
      enabled: false,
      role: null,
      createdAt: null,
      updatedAt: null,
    });
    assert.equal(attributeValue(undefined, 'email'), null);
  });

  test('toApiMe prefers the profile name and the token e-mail', () => {
    const profile = newProfileItem({ userId: users.author.userId, email: 'old@example.com', displayName: 'Profile Name' }, '2026-03-01T00:00:00.000Z');
    const me = toApiMe(profile, users.author);
    assert.equal(me.name, 'Profile Name');
    assert.equal(me.email, users.author.email);
    assert.equal(me.createdAt, '2026-03-01T00:00:00.000Z');
    assert.equal(toApiMe(profile, { ...users.author, email: null }).email, 'old@example.com');
  });

  test('public profiles never expose the e-mail address', () => {
    const profile = newProfileItem({ userId: 'u-1', email: 'secret@example.com', displayName: 'Pub' });
    assert.deepEqual(toPublicProfile(profile), { id: 'u-1', name: 'Pub', bio: null, avatarUrl: null, website: null });
  });

  test('newProfileItem builds the PROFILE item', () => {
    assert.deepEqual(newProfileItem({ userId: 'u-1', displayName: 'Pub' }, 'T'), {
      PK: 'USER#u-1',
      SK: 'PROFILE',
      entityType: 'PROFILE',
      userId: 'u-1',
      email: null,
      displayName: 'Pub',
      bio: null,
      avatarUrl: null,
      website: null,
      createdAt: 'T',
      updatedAt: 'T',
    });
  });

  test('token responses and challenges', () => {
    const result = { IdToken: 'id', AccessToken: 'access', ExpiresIn: 3600, TokenType: 'Bearer' };
    assert.deepEqual(toApiTokens(result), { tokenType: 'Bearer', idToken: 'id', accessToken: 'access', expiresIn: 3600 });
    assert.deepEqual(Object.keys(toApiTokens({ ...result, RefreshToken: 'r' })), ['tokenType', 'idToken', 'accessToken', 'refreshToken', 'expiresIn']);
    assert.deepEqual(toAuthResult({ AuthenticationResult: result }), toApiTokens(result));
    assert.deepEqual(toAuthResult({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' }), { challenge: 'NEW_PASSWORD_REQUIRED', session: 's' });
    assert.throws(() => toAuthResult({ ChallengeName: 'SMS_MFA', Session: 's' }), { statusCode: 501, code: 'UNSUPPORTED_CHALLENGE' });
    assert.throws(() => toAuthResult({}), { statusCode: 501 });
  });
});

describe('updateUser', () => {
  test('refuses any self-modification, whatever the case of the identifier', async () => {
    const cognito = mockClient(idp.CognitoIdentityProviderClient);
    try {
      for (const userId of [users.admin.userId, users.admin.userId.toUpperCase()]) {
        for (const changes of [{ role: 'guest-author' }, { enabled: false }]) {
          await assert.rejects(updateUser(users.admin, userId, changes), { statusCode: 409, code: 'SELF_MODIFICATION' });
        }
      }
      assert.equal(cognito.calls().length, 0);
    } finally {
      cognito.restore();
    }
  });
});

describe('GET /users cursors', () => {
  test('round trip, bound to the role filter', () => {
    const cursor = encodeUsersCursor('cognito/token+with=chars', 'editor');
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodeUsersCursor(cursor, 'editor'), 'cognito/token+with=chars');
    assert.throws(() => decodeUsersCursor(cursor, undefined), { statusCode: 400 });
    assert.throws(() => decodeUsersCursor(cursor, 'admin'), { statusCode: 400 });
    assert.equal(decodeUsersCursor(encodeUsersCursor('t'), undefined), 't');
  });

  test('no token means no cursor, malformed cursors are rejected', () => {
    assert.equal(encodeUsersCursor(undefined), null);
    assert.equal(encodeUsersCursor(''), null);
    assert.equal(decodeUsersCursor(undefined), undefined);
    assert.equal(decodeUsersCursor(''), undefined);
    const b64 = (value) => Buffer.from(value).toString('base64url');
    for (const cursor of ['%%%', b64('null'), b64('"token"'), b64('{"token":""}'), b64('{"token":12}'), b64('{"role":"editor"}')]) {
      assert.throws(() => decodeUsersCursor(cursor), { statusCode: 400, code: 'BAD_REQUEST' }, cursor);
    }
  });
});
