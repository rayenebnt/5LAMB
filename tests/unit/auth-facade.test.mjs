import '../helpers/env.mjs';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import * as idp from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler, routes } from '../../src/functions/auth/index.mjs';
import { apiEvent, lambdaContext, parse } from '../helpers/events.mjs';
import { apiRoutes } from '../helpers/template.mjs';

const {
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  SignUpCommand,
} = idp;

const cognito = mockClient(CognitoIdentityProviderClient);
const ddb = mockClient(DynamoDBDocumentClient);

const CLIENT_ID = 'test-client-id';
const POOL_ID = 'eu-west-3_TestPool1';
const SUB = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const EMAIL = 'jane.doe@example.com';
const PASSWORD = 'Sup3rSecret';
const SESSION = `AYABeC${'x'.repeat(200)}`;
const REFRESH_TOKEN = 'eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIiwiYWxnIjoiUlNBLU9BRVAifQ.key.iv.cipher.tag';
const AUTH_RESULT = {
  IdToken: 'id.token.jwt',
  AccessToken: 'access.token.jwt',
  RefreshToken: REFRESH_TOKEN,
  ExpiresIn: 3600,
  TokenType: 'Bearer',
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Cognito service exception, built with the same classes as the SDK throws. */
function cognitoError(name, message = `${name}: detailed message from Cognito`) {
  return new idp[name]({ message, $metadata: { httpStatusCode: 400 } });
}

function post(resource, body, headers = {}) {
  return handler(apiEvent({ method: 'POST', resource, body, headers }), lambdaContext);
}

/** Asserts an error response and that the Cognito message is not leaked. */
function assertError(res, statusCode, code) {
  assert.equal(res.statusCode, statusCode, res.body);
  assert.equal(parse(res).error.code, code);
  assert.ok(!res.body.includes('detailed message from Cognito'), 'Cognito messages must not be forwarded');
}

const commandNames = () => cognito.calls().map((call) => call.args[0].constructor.name);
const inputOf = (command, index = 0) => cognito.commandCalls(command)[index].args[0].input;

beforeEach(() => {
  cognito.reset();
  ddb.reset();
  delete process.env.AUTO_CONFIRM_USERS;
});

test('routes match the AuthFunction events of template.yaml (all public, token ignored)', () => {
  const templateRoutes = apiRoutes().filter((route) => route.functionId === 'AuthFunction');
  assert.deepEqual(Object.keys(routes).sort(), templateRoutes.map((route) => route.routeKey).sort());
  for (const route of templateRoutes) {
    assert.equal(route.publicRoute, true, route.routeKey);
    assert.equal(routes[route.routeKey].auth, 'none', route.routeKey);
  }
});

test('unknown routes answer 404 ROUTE_NOT_FOUND', async () => {
  const res = await handler(apiEvent({ method: 'GET', resource: '/auth/login' }), lambdaContext);
  assertError(res, 404, 'ROUTE_NOT_FOUND');
});

describe('POST /auth/register', () => {
  const body = { email: '  Jane.Doe@Example.COM ', password: PASSWORD, name: '  Jane Doe ' };

  function mockSuccessfulSignUp({ confirmed = false } = {}) {
    cognito.on(SignUpCommand).resolves({ UserSub: SUB, UserConfirmed: confirmed });
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    cognito.on(AdminConfirmSignUpCommand).resolves({});
    cognito.on(AdminUpdateUserAttributesCommand).resolves({});
    ddb.on(PutCommand).resolves({});
  }

  test('creates a guest author awaiting e-mail confirmation, with a profile', async () => {
    mockSuccessfulSignUp();
    const res = await post('/auth/register', body);

    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.headers.Location, `/authors/${SUB}`);
    assert.deepEqual(parse(res), {
      userId: SUB,
      email: EMAIL,
      name: 'Jane Doe',
      role: 'guest-author',
      confirmed: false,
      nextStep: 'CONFIRM_SIGN_UP',
    });
    assert.deepEqual(inputOf(SignUpCommand), {
      ClientId: CLIENT_ID,
      Username: EMAIL,
      Password: PASSWORD,
      UserAttributes: [
        { Name: 'email', Value: EMAIL },
        { Name: 'name', Value: 'Jane Doe' },
      ],
    });
    assert.deepEqual(inputOf(AdminAddUserToGroupCommand), { UserPoolId: POOL_ID, Username: SUB, GroupName: 'guest-author' });
    assert.deepEqual(commandNames(), ['SignUpCommand', 'AdminAddUserToGroupCommand']);

    const put = ddb.commandCalls(PutCommand)[0].args[0].input;
    assert.equal(put.TableName, 'blogify-test');
    assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)');
    const { createdAt, updatedAt, ...item } = put.Item;
    assert.match(createdAt, ISO_DATE);
    assert.equal(updatedAt, createdAt);
    assert.deepEqual(item, {
      PK: `USER#${SUB}`,
      SK: 'PROFILE',
      entityType: 'PROFILE',
      userId: SUB,
      email: EMAIL,
      displayName: 'Jane Doe',
      bio: null,
      avatarUrl: null,
      website: null,
    });
  });

  test('demo mode confirms the account and verifies the e-mail address', async () => {
    process.env.AUTO_CONFIRM_USERS = 'true';
    mockSuccessfulSignUp();
    const res = await post('/auth/register', body);

    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).confirmed, true);
    assert.equal(parse(res).nextStep, 'LOGIN');
    assert.deepEqual(commandNames(), [
      'SignUpCommand',
      'AdminAddUserToGroupCommand',
      'AdminConfirmSignUpCommand',
      'AdminUpdateUserAttributesCommand',
    ]);
    assert.deepEqual(inputOf(AdminConfirmSignUpCommand), { UserPoolId: POOL_ID, Username: SUB });
    assert.deepEqual(inputOf(AdminUpdateUserAttributesCommand), {
      UserPoolId: POOL_ID,
      Username: SUB,
      UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
    });
  });

  test('an account already confirmed by Cognito is not confirmed twice', async () => {
    process.env.AUTO_CONFIRM_USERS = 'true';
    mockSuccessfulSignUp({ confirmed: true });
    const res = await post('/auth/register', body);

    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).nextStep, 'LOGIN');
    assert.equal(cognito.commandCalls(AdminConfirmSignUpCommand).length, 0);
  });

  test('a failed automatic confirmation falls back to the e-mailed code', async () => {
    process.env.AUTO_CONFIRM_USERS = 'true';
    mockSuccessfulSignUp();
    cognito.on(AdminConfirmSignUpCommand).rejects(cognitoError('InternalErrorException'));
    const res = await post('/auth/register', body);

    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).confirmed, false);
    assert.equal(parse(res).nextStep, 'CONFIRM_SIGN_UP');
    assert.equal(cognito.commandCalls(AdminUpdateUserAttributesCommand).length, 0);
  });

  test('the account stays confirmed when only the e-mail verification flag fails', async () => {
    process.env.AUTO_CONFIRM_USERS = 'true';
    mockSuccessfulSignUp();
    cognito.on(AdminUpdateUserAttributesCommand).rejects(cognitoError('TooManyRequestsException'));
    const res = await post('/auth/register', body);

    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).confirmed, true);
  });

  test('an existing profile is kept and a profile write failure does not fail the registration', async () => {
    mockSuccessfulSignUp();
    ddb.on(PutCommand).rejects(Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' }));
    assert.equal((await post('/auth/register', body)).statusCode, 201);

    ddb.on(PutCommand).rejects(new Error('DynamoDB unavailable'));
    const res = await post('/auth/register', body);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).userId, SUB);
  });

  test('rejects invalid input before calling Cognito', async () => {
    const invalid = [
      {},
      { email: EMAIL, password: PASSWORD },
      { email: EMAIL, password: PASSWORD, name: '   ' },
      { email: EMAIL, password: PASSWORD, name: 'x'.repeat(81) },
      { email: 'not-an-email', password: PASSWORD, name: 'Jane' },
      { email: EMAIL, password: 'password', name: 'Jane' },
      { email: EMAIL, password: 'Sh0rt', name: 'Jane' },
      { email: EMAIL, password: PASSWORD, name: 'Jane', role: 'admin' },
      { email: EMAIL, password: PASSWORD, name: 42 },
    ];
    for (const input of invalid) {
      const res = await post('/auth/register', input);
      assertError(res, 400, 'VALIDATION_ERROR');
    }
    assertError(await post('/auth/register', '{"email":'), 400, 'BAD_REQUEST');
    assertError(await post('/auth/register', 'email=x', { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(cognito.calls().length, 0);
    assert.equal(ddb.calls().length, 0);
  });

  test('maps Cognito sign-up errors and stops the registration', async () => {
    const cases = [
      ['UsernameExistsException', 409, 'USER_EXISTS'],
      ['InvalidPasswordException', 400, 'INVALID_PASSWORD'],
      ['InvalidParameterException', 400, 'INVALID_PARAMETER'],
      ['TooManyRequestsException', 429, 'TOO_MANY_REQUESTS'],
      ['LimitExceededException', 429, 'TOO_MANY_REQUESTS'],
      ['InternalErrorException', 500, 'INTERNAL_ERROR'],
    ];
    for (const [name, statusCode, code] of cases) {
      cognito.reset();
      cognito.on(SignUpCommand).rejects(cognitoError(name));
      const res = await post('/auth/register', body);
      assertError(res, statusCode, code);
      assert.deepEqual(commandNames(), ['SignUpCommand'], name);
    }
    assert.equal(ddb.calls().length, 0);
  });

  test('a role assignment failure does not abort the registration (the role is assigned at login)', async () => {
    mockSuccessfulSignUp();
    cognito.on(AdminAddUserToGroupCommand).rejects(cognitoError('InternalErrorException'));
    const res = await post('/auth/register', body);

    assert.equal(res.statusCode, 201, res.body);
    assert.equal(parse(res).role, 'guest-author');
    assert.equal(ddb.commandCalls(PutCommand).length, 1, 'the profile is still created');
  });
});

describe('POST /auth/confirm', () => {
  test('confirms the account with the e-mailed code', async () => {
    cognito.on(ConfirmSignUpCommand).resolves({});
    const res = await post('/auth/confirm', { email: 'Jane.Doe@example.com', code: ' 123456 ' });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), { confirmed: true });
    assert.deepEqual(inputOf(ConfirmSignUpCommand), { ClientId: CLIENT_ID, Username: EMAIL, ConfirmationCode: '123456' });
  });

  test('maps code errors, throttling and invalid account states', async () => {
    const cases = [
      ['CodeMismatchException', 400, 'INVALID_CODE'],
      ['ExpiredCodeException', 400, 'EXPIRED_CODE'],
      ['TooManyFailedAttemptsException', 429, 'TOO_MANY_REQUESTS'],
      ['LimitExceededException', 429, 'TOO_MANY_REQUESTS'],
      ['NotAuthorizedException', 401, 'INVALID_CREDENTIALS'],
      ['InternalErrorException', 500, 'INTERNAL_ERROR'],
    ];
    for (const [name, statusCode, code] of cases) {
      cognito.on(ConfirmSignUpCommand).rejects(cognitoError(name));
      assertError(await post('/auth/confirm', { email: EMAIL, code: '123456' }), statusCode, code);
    }
  });

  test('an unknown account is answered exactly like a wrong code', async () => {
    cognito.on(ConfirmSignUpCommand).rejects(cognitoError('CodeMismatchException'));
    const wrongCode = await post('/auth/confirm', { email: EMAIL, code: '123456' });
    cognito.on(ConfirmSignUpCommand).rejects(cognitoError('UserNotFoundException'));
    const unknownAccount = await post('/auth/confirm', { email: 'nobody@example.com', code: '123456' });

    assert.equal(unknownAccount.statusCode, 400);
    assert.deepEqual(parse(unknownAccount), parse(wrongCode));
  });

  test('rejects invalid input', async () => {
    for (const input of [{ email: EMAIL }, { email: EMAIL, code: '' }, { email: EMAIL, code: '12 34' }, { email: 'x', code: '1' }, { email: EMAIL, code: '1', extra: 1 }]) {
      assertError(await post('/auth/confirm', input), 400, 'VALIDATION_ERROR');
    }
    assert.equal(cognito.calls().length, 0);
  });
});

describe('POST /auth/resend-code', () => {
  test('sends a new code and answers 202 whether or not the account exists', async () => {
    cognito.on(ResendConfirmationCodeCommand).resolves({ CodeDeliveryDetails: { Destination: 'j***@e***' } });
    const sent = await post('/auth/resend-code', { email: EMAIL });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.ok(parse(sent).message);
    assert.deepEqual(inputOf(ResendConfirmationCodeCommand), { ClientId: CLIENT_ID, Username: EMAIL });

    cognito.on(ResendConfirmationCodeCommand).rejects(cognitoError('UserNotFoundException'));
    const unknown = await post('/auth/resend-code', { email: 'nobody@example.com' });
    assert.equal(unknown.statusCode, 202, unknown.body);
    assert.deepEqual(parse(unknown), parse(sent));

    // An already confirmed account gets the same answer (no account enumeration).
    cognito.on(ResendConfirmationCodeCommand).rejects(cognitoError('InvalidParameterException'));
    const confirmed = await post('/auth/resend-code', { email: EMAIL });
    assert.equal(confirmed.statusCode, 202, confirmed.body);
    assert.deepEqual(parse(confirmed), parse(sent));
  });

  test('maps the other Cognito errors', async () => {
    const cases = [
      ['LimitExceededException', 429, 'TOO_MANY_REQUESTS'],
      ['TooManyRequestsException', 429, 'TOO_MANY_REQUESTS'],
    ];
    for (const [name, statusCode, code] of cases) {
      cognito.on(ResendConfirmationCodeCommand).rejects(cognitoError(name));
      assertError(await post('/auth/resend-code', { email: EMAIL }), statusCode, code);
    }
  });

  test('rejects invalid input', async () => {
    assertError(await post('/auth/resend-code', {}), 400, 'VALIDATION_ERROR');
    assertError(await post('/auth/resend-code', { email: EMAIL, code: '1' }), 400, 'VALIDATION_ERROR');
    assert.equal(cognito.calls().length, 0);
  });
});

describe('POST /auth/login', () => {
  test('returns the tokens of a successful authentication (never cached)', async () => {
    cognito.on(InitiateAuthCommand).resolves({ AuthenticationResult: AUTH_RESULT, ChallengeParameters: {} });
    const res = await post('/auth/login', { email: ' JANE.DOE@example.com', password: PASSWORD });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      tokenType: 'Bearer',
      idToken: 'id.token.jwt',
      accessToken: 'access.token.jwt',
      refreshToken: REFRESH_TOKEN,
      expiresIn: 3600,
    });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers.Pragma, 'no-cache');
    assert.deepEqual(inputOf(InitiateAuthCommand), {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: EMAIL, PASSWORD },
    });
  });

  test('returns the NEW_PASSWORD_REQUIRED challenge of an invited user', async () => {
    cognito.on(InitiateAuthCommand).resolves({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: SESSION,
      ChallengeParameters: { USER_ID_FOR_SRP: SUB, requiredAttributes: '[]', userAttributes: '{}' },
    });
    const res = await post('/auth/login', { email: EMAIL, password: 'TempPassw0rd' });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), { challenge: 'NEW_PASSWORD_REQUIRED', session: SESSION });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  test('other challenges cannot be completed through the API (501)', async () => {
    cognito.on(InitiateAuthCommand).resolves({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: SESSION });
    assertError(await post('/auth/login', { email: EMAIL, password: PASSWORD }), 501, 'UNSUPPORTED_CHALLENGE');
  });

  test('a wrong password and an unknown account get the same 401 answer', async () => {
    cognito.on(InitiateAuthCommand).rejects(cognitoError('NotAuthorizedException', 'Incorrect username or password.'));
    const wrongPassword = await post('/auth/login', { email: EMAIL, password: PASSWORD });
    cognito.on(InitiateAuthCommand).rejects(cognitoError('UserNotFoundException', 'User does not exist.'));
    const unknownAccount = await post('/auth/login', { email: 'nobody@example.com', password: PASSWORD });

    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(parse(wrongPassword).error.code, 'INVALID_CREDENTIALS');
    assert.deepEqual(parse(unknownAccount), parse(wrongPassword));
    assert.ok(!unknownAccount.body.includes('does not exist'));
  });

  test('maps account state, throttling and unexpected errors', async () => {
    const cases = [
      ['UserNotConfirmedException', 403, 'USER_NOT_CONFIRMED'],
      ['PasswordResetRequiredException', 403, 'PASSWORD_RESET_REQUIRED'],
      ['TooManyRequestsException', 429, 'TOO_MANY_REQUESTS'],
      ['InvalidParameterException', 400, 'INVALID_PARAMETER'],
      ['InternalErrorException', 500, 'INTERNAL_ERROR'],
      ['ResourceNotFoundException', 500, 'INTERNAL_ERROR'],
    ];
    for (const [name, statusCode, code] of cases) {
      cognito.on(InitiateAuthCommand).rejects(cognitoError(name));
      assertError(await post('/auth/login', { email: EMAIL, password: PASSWORD }), statusCode, code);
    }
  });

  test('validates the e-mail address and the password policy before calling Cognito', async () => {
    const invalid = [
      { email: EMAIL },
      { password: PASSWORD },
      { email: 'jane', password: PASSWORD },
      { email: EMAIL, password: '' },
      { email: EMAIL, password: PASSWORD, remember: true },
    ];
    for (const input of invalid) assertError(await post('/auth/login', input), 400, 'VALIDATION_ERROR');
    assert.equal(cognito.calls().length, 0);
  });

  test('a password that does not follow the policy is checked by Cognito (401, policy never disclosed)', async () => {
    cognito.on(InitiateAuthCommand).rejects(cognitoError('NotAuthorizedException'));
    assertError(await post('/auth/login', { email: EMAIL, password: 'alllowercase1' }), 401, 'INVALID_CREDENTIALS');
    assert.equal(cognito.commandCalls(InitiateAuthCommand).length, 1);
  });

  test('an account without any role gets the default role at login, with refreshed tokens', async () => {
    const token = (claims) =>
      ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
    const withoutRole = token({ sub: SUB, email: EMAIL, token_use: 'id' });
    const withRole = token({ sub: SUB, email: EMAIL, token_use: 'id', 'cognito:groups': ['guest-author'] });
    cognito
      .on(InitiateAuthCommand, { AuthFlow: 'USER_PASSWORD_AUTH' })
      .resolves({ AuthenticationResult: { ...AUTH_RESULT, IdToken: withoutRole } });
    cognito
      .on(InitiateAuthCommand, { AuthFlow: 'REFRESH_TOKEN_AUTH' })
      .resolves({ AuthenticationResult: { ...AUTH_RESULT, IdToken: withRole, RefreshToken: undefined } });
    cognito.on(AdminAddUserToGroupCommand).resolves({});

    const res = await post('/auth/login', { email: EMAIL, password: PASSWORD });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).idToken, withRole);
    assert.equal(parse(res).refreshToken, REFRESH_TOKEN);
    assert.deepEqual(inputOf(AdminAddUserToGroupCommand), { UserPoolId: POOL_ID, Username: SUB, GroupName: 'guest-author' });

    // If the repair fails, the original tokens are still returned.
    cognito.on(AdminAddUserToGroupCommand).rejects(cognitoError('InternalErrorException'));
    const degraded = await post('/auth/login', { email: EMAIL, password: PASSWORD });
    assert.equal(degraded.statusCode, 200, degraded.body);
    assert.equal(parse(degraded).idToken, withoutRole);
  });

  test('public routes ignore the Authorization header', async () => {
    cognito.on(InitiateAuthCommand).resolves({ AuthenticationResult: AUTH_RESULT });
    const res = await post('/auth/login', { email: EMAIL, password: PASSWORD }, { Authorization: 'Bearer not.a.token' });
    assert.equal(res.statusCode, 200, res.body);
  });
});

describe('POST /auth/refresh', () => {
  test('returns new tokens without a refresh token when Cognito does not rotate it', async () => {
    const { RefreshToken, ...withoutRefresh } = AUTH_RESULT;
    assert.ok(RefreshToken);
    cognito.on(InitiateAuthCommand).resolves({ AuthenticationResult: withoutRefresh });
    const res = await post('/auth/refresh', { refreshToken: REFRESH_TOKEN });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), { tokenType: 'Bearer', idToken: 'id.token.jwt', accessToken: 'access.token.jwt', expiresIn: 3600 });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(inputOf(InitiateAuthCommand), {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: REFRESH_TOKEN },
    });
  });

  test('returns the rotated refresh token when Cognito issues one', async () => {
    cognito.on(InitiateAuthCommand).resolves({ AuthenticationResult: { ...AUTH_RESULT, RefreshToken: 'new.refresh.token' } });
    const res = await post('/auth/refresh', { refreshToken: REFRESH_TOKEN });
    assert.equal(parse(res).refreshToken, 'new.refresh.token');
  });

  test('an invalid, expired or revoked refresh token is answered 401 INVALID_TOKEN', async () => {
    for (const name of ['NotAuthorizedException', 'UserNotFoundException']) {
      cognito.on(InitiateAuthCommand).rejects(cognitoError(name));
      assertError(await post('/auth/refresh', { refreshToken: REFRESH_TOKEN }), 401, 'INVALID_TOKEN');
    }
    cognito.on(InitiateAuthCommand).rejects(cognitoError('TooManyRequestsException'));
    assertError(await post('/auth/refresh', { refreshToken: REFRESH_TOKEN }), 429, 'TOO_MANY_REQUESTS');
  });

  test('rejects a missing or malformed refresh token', async () => {
    for (const input of [{}, { refreshToken: '' }, { refreshToken: 'not a token' }, { refreshToken: 'a<b>' }, { token: REFRESH_TOKEN }]) {
      assertError(await post('/auth/refresh', input), 400, 'VALIDATION_ERROR');
    }
    assert.equal(cognito.calls().length, 0);
  });
});

describe('POST /auth/new-password (first login of an invited user)', () => {
  test('login challenge then new password returns the tokens', async () => {
    cognito.on(InitiateAuthCommand).resolves({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: SESSION });
    cognito.on(RespondToAuthChallengeCommand).resolves({ AuthenticationResult: AUTH_RESULT, ChallengeParameters: {} });

    const challenge = await post('/auth/login', { email: EMAIL, password: 'TempPassw0rd' });
    assert.equal(parse(challenge).challenge, 'NEW_PASSWORD_REQUIRED');

    const res = await post('/auth/new-password', { email: EMAIL, newPassword: 'N3wPassword', session: parse(challenge).session });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(parse(res), {
      tokenType: 'Bearer',
      idToken: 'id.token.jwt',
      accessToken: 'access.token.jwt',
      refreshToken: REFRESH_TOKEN,
      expiresIn: 3600,
    });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(inputOf(RespondToAuthChallengeCommand), {
      ClientId: CLIENT_ID,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: SESSION,
      ChallengeResponses: { USERNAME: EMAIL, NEW_PASSWORD: 'N3wPassword' },
    });
  });

  test('an expired session or a rejected password is reported', async () => {
    const cases = [
      ['NotAuthorizedException', 401, 'INVALID_CREDENTIALS'],
      ['UserNotFoundException', 401, 'INVALID_CREDENTIALS'],
      ['InvalidPasswordException', 400, 'INVALID_PASSWORD'],
      ['CodeMismatchException', 400, 'INVALID_CODE'],
      ['TooManyRequestsException', 429, 'TOO_MANY_REQUESTS'],
    ];
    for (const [name, statusCode, code] of cases) {
      cognito.on(RespondToAuthChallengeCommand).rejects(cognitoError(name));
      const res = await post('/auth/new-password', { email: EMAIL, newPassword: 'N3wPassword', session: SESSION });
      assertError(res, statusCode, code);
    }
    cognito.on(RespondToAuthChallengeCommand).rejects(cognitoError('NotAuthorizedException', 'Invalid session for the user, session is expired.'));
    const expired = await post('/auth/new-password', { email: EMAIL, newPassword: 'N3wPassword', session: SESSION });
    assert.match(parse(expired).error.message, /session/);
  });

  test('validates the new password against the policy and requires the session', async () => {
    const invalid = [
      { email: EMAIL, newPassword: 'weakpass', session: SESSION },
      { email: EMAIL, newPassword: 'N3wPassword' },
      { email: EMAIL, newPassword: 'N3wPassword', session: '' },
      { email: EMAIL, newPassword: 'N3wPassword', session: 'x'.repeat(2049) },
      { newPassword: 'N3wPassword', session: SESSION },
    ];
    for (const input of invalid) assertError(await post('/auth/new-password', input), 400, 'VALIDATION_ERROR');
    assert.equal(cognito.calls().length, 0);
  });
});

describe('POST /auth/forgot-password', () => {
  test('always answers 202 with the same message, whether or not the account exists', async () => {
    cognito.on(ForgotPasswordCommand).resolves({ CodeDeliveryDetails: { Destination: 'j***@e***', DeliveryMedium: 'EMAIL' } });
    const existing = await post('/auth/forgot-password', { email: 'Jane.Doe@Example.com' });
    assert.equal(existing.statusCode, 202, existing.body);
    assert.deepEqual(inputOf(ForgotPasswordCommand), { ClientId: CLIENT_ID, Username: EMAIL });
    assert.ok(parse(existing).message);

    const accountDependent = [
      'UserNotFoundException',
      'NotAuthorizedException',
      'InvalidParameterException',
      'UserNotConfirmedException',
      'LimitExceededException',
      'CodeDeliveryFailureException',
    ];
    for (const name of accountDependent) {
      cognito.on(ForgotPasswordCommand).rejects(cognitoError(name));
      const res = await post('/auth/forgot-password', { email: 'nobody@example.com' });
      assert.equal(res.statusCode, 202, `${name}: ${res.body}`);
      assert.deepEqual(parse(res), parse(existing), name);
    }
  });

  test('failures unrelated to the account are still reported', async () => {
    cognito.on(ForgotPasswordCommand).rejects(cognitoError('TooManyRequestsException'));
    assertError(await post('/auth/forgot-password', { email: EMAIL }), 429, 'TOO_MANY_REQUESTS');
    cognito.on(ForgotPasswordCommand).rejects(cognitoError('InternalErrorException'));
    assertError(await post('/auth/forgot-password', { email: EMAIL }), 500, 'INTERNAL_ERROR');
  });

  test('rejects an invalid e-mail address', async () => {
    assertError(await post('/auth/forgot-password', { email: 'nope' }), 400, 'VALIDATION_ERROR');
    assertError(await post('/auth/forgot-password', {}), 400, 'VALIDATION_ERROR');
    assert.equal(cognito.calls().length, 0);
  });
});

describe('POST /auth/reset-password', () => {
  const body = { email: EMAIL, code: '654321', newPassword: 'An0therPass' };

  test('sets the new password with the e-mailed code', async () => {
    cognito.on(ConfirmForgotPasswordCommand).resolves({});
    const res = await post('/auth/reset-password', body);

    assert.equal(res.statusCode, 200, res.body);
    assert.ok(parse(res).message);
    assert.deepEqual(inputOf(ConfirmForgotPasswordCommand), {
      ClientId: CLIENT_ID,
      Username: EMAIL,
      ConfirmationCode: '654321',
      Password: 'An0therPass',
    });
  });

  test('maps code, password and throttling errors', async () => {
    const cases = [
      ['CodeMismatchException', 400, 'INVALID_CODE'],
      ['ExpiredCodeException', 400, 'EXPIRED_CODE'],
      ['InvalidPasswordException', 400, 'INVALID_PASSWORD'],
      ['TooManyFailedAttemptsException', 429, 'TOO_MANY_REQUESTS'],
      ['LimitExceededException', 429, 'TOO_MANY_REQUESTS'],
      ['UserNotConfirmedException', 403, 'USER_NOT_CONFIRMED'],
    ];
    for (const [name, statusCode, code] of cases) {
      cognito.on(ConfirmForgotPasswordCommand).rejects(cognitoError(name));
      assertError(await post('/auth/reset-password', body), statusCode, code);
    }
  });

  test('an unknown account is answered exactly like a wrong code', async () => {
    cognito.on(ConfirmForgotPasswordCommand).rejects(cognitoError('CodeMismatchException'));
    const wrongCode = await post('/auth/reset-password', body);
    cognito.on(ConfirmForgotPasswordCommand).rejects(cognitoError('UserNotFoundException'));
    const unknownAccount = await post('/auth/reset-password', { ...body, email: 'nobody@example.com' });
    assert.deepEqual(parse(unknownAccount), parse(wrongCode));
  });

  test('validates the code and the new password', async () => {
    for (const input of [{ ...body, newPassword: 'weak' }, { ...body, code: undefined }, { ...body, password: 'An0therPass' }]) {
      assertError(await post('/auth/reset-password', input), 400, 'VALIDATION_ERROR');
    }
    assert.equal(cognito.calls().length, 0);
  });
});

describe('POST /auth/logout', () => {
  test('revokes the refresh token', async () => {
    cognito.on(RevokeTokenCommand).resolves({});
    const res = await post('/auth/logout', { refreshToken: REFRESH_TOKEN });

    assert.equal(res.statusCode, 204);
    assert.equal(res.body, '');
    assert.deepEqual(inputOf(RevokeTokenCommand), { ClientId: CLIENT_ID, Token: REFRESH_TOKEN });
  });

  test('an unusable token is answered 401 INVALID_TOKEN', async () => {
    for (const name of ['NotAuthorizedException', 'UnauthorizedException', 'UnsupportedTokenTypeException']) {
      cognito.on(RevokeTokenCommand).rejects(cognitoError(name));
      assertError(await post('/auth/logout', { refreshToken: REFRESH_TOKEN }), 401, 'INVALID_TOKEN');
    }
    cognito.on(RevokeTokenCommand).rejects(cognitoError('UnsupportedOperationException'));
    assertError(await post('/auth/logout', { refreshToken: REFRESH_TOKEN }), 500, 'INTERNAL_ERROR');
  });

  test('requires the refresh token', async () => {
    assertError(await post('/auth/logout', {}), 400, 'VALIDATION_ERROR');
    assertError(await post('/auth/logout'), 400, 'VALIDATION_ERROR');
    assert.equal(cognito.calls().length, 0);
  });
});
