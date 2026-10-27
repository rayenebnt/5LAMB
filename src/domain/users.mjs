// Users: authentication facade over Amazon Cognito, profiles (DynamoDB) and user administration.
//
// Users are identified by their Cognito `sub`. In this e-mail based user pool the Cognito
// username *is* the sub, so the sub is used as `Username` in every Admin* call.
// Roles are Cognito groups (see src/lib/auth.mjs): a user belongs to exactly one role group.
// Profiles hold the public author information: { PK: USER#<id>, SK: PROFILE }.

import {
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  ResendConfirmationCodeCommand,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ALL_ROLES, DEFAULT_ROLE, primaryRole, ROLE_PERMISSIONS } from '../lib/auth.mjs';
import { cognito, dynamo } from '../lib/aws.mjs';
import { config } from '../lib/config.mjs';
import { isConditionalCheckFailed, keys, tableName } from '../lib/db.mjs';
import { AppError, badRequest, conflict, notFound, tooManyRequests } from '../lib/errors.mjs';
import { nowIso } from '../lib/ids.mjs';
import { logger } from '../lib/logger.mjs';
import { ENTITY } from '../lib/schema.mjs';

export const NEW_PASSWORD_REQUIRED = 'NEW_PASSWORD_REQUIRED';

/** Parallel AdminListGroupsForUser calls per GET /users page (stays below Cognito quotas). */
const GROUP_LOOKUP_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Cognito error mapping
// ---------------------------------------------------------------------------

const invalidCredentials = (message) => new AppError(401, 'INVALID_CREDENTIALS', message);
const invalidToken = () => new AppError(401, 'INVALID_TOKEN', 'Invalid, expired or revoked token');
const invalidCode = () => new AppError(400, 'INVALID_CODE', 'Invalid verification code');
const WRONG_LOGIN = 'Incorrect e-mail address or password';
const WRONG_SESSION = 'Invalid credentials or expired session, please log in again';

/** Errors with the same meaning for every operation (matched on `err.name`). */
const COGNITO_ERRORS = {
  UsernameExistsException: () => conflict('An account already exists for this e-mail address', 'USER_EXISTS'),
  InvalidPasswordException: () =>
    new AppError(400, 'INVALID_PASSWORD', 'The password does not satisfy the password policy'),
  InvalidParameterException: () =>
    new AppError(400, 'INVALID_PARAMETER', 'The identity provider rejected a parameter of the request'),
  CodeMismatchException: invalidCode,
  ExpiredCodeException: () =>
    new AppError(400, 'EXPIRED_CODE', 'The verification code has expired, please request a new one'),
  UserNotConfirmedException: () =>
    new AppError(403, 'USER_NOT_CONFIRMED', 'The account has not been confirmed yet (see the e-mailed code)'),
  PasswordResetRequiredException: () =>
    new AppError(403, 'PASSWORD_RESET_REQUIRED', 'A password reset is required for this account'),
  LimitExceededException: () => tooManyRequests(),
  TooManyRequestsException: () => tooManyRequests(),
  TooManyFailedAttemptsException: () => tooManyRequests(),
};

/**
 * Errors whose meaning depends on the operation:
 *   login    POST /auth/login - a wrong password and an unknown account get the same answer
 *   session  POST /auth/new-password (completes a login challenge)
 *   account  register, confirm, resend-code, forgot/reset-password - an unknown account is
 *            answered like a wrong code, so the API never reveals which addresses are registered
 *   token    POST /auth/refresh and /auth/logout (refresh token problems)
 *   admin    user management - unknown user -> 404 (NotAuthorizedException is unexpected -> 500)
 */
const CONTEXT_ERRORS = {
  login: {
    NotAuthorizedException: () => invalidCredentials(WRONG_LOGIN),
    UserNotFoundException: () => invalidCredentials(WRONG_LOGIN),
  },
  session: {
    NotAuthorizedException: () => invalidCredentials(WRONG_SESSION),
    UserNotFoundException: () => invalidCredentials(WRONG_SESSION),
  },
  account: {
    NotAuthorizedException: () => invalidCredentials('This operation is not allowed for this account'),
    UserNotFoundException: invalidCode,
  },
  token: {
    NotAuthorizedException: invalidToken,
    UserNotFoundException: invalidToken,
    // RevokeToken reports an unusable token with these exceptions.
    UnauthorizedException: invalidToken,
    UnsupportedTokenTypeException: invalidToken,
  },
  admin: {
    UserNotFoundException: () => notFound('User not found'),
  },
};

const lookup = (table, name) => (table && Object.hasOwn(table, name) ? table[name] : undefined);

/**
 * Converts a Cognito error (matched on `err.name`) into an AppError for the given context
 * ('login' | 'session' | 'account' | 'token' | 'admin'). Unexpected errors are returned
 * unchanged: the caller rethrows them and the router answers 500 without details.
 */
export function mapCognitoError(err, context) {
  const name = err?.name;
  const factory = lookup(CONTEXT_ERRORS[context], name) ?? lookup(COGNITO_ERRORS, name);
  return factory ? factory() : err;
}

/** Sends a Cognito command and translates its errors (see mapCognitoError). */
async function sendCognito(command, context) {
  try {
    return await cognito().send(command);
  } catch (err) {
    const mapped = mapCognitoError(err, context);
    if (mapped !== err) logger.info('Cognito request rejected', { error: err.name, status: mapped.statusCode });
    throw mapped;
  }
}

// ---------------------------------------------------------------------------
// API representations
// ---------------------------------------------------------------------------

/** Value of a Cognito user attribute (null when absent). */
export function attributeValue(attributes, name) {
  return attributes?.find((attribute) => attribute.Name === name)?.Value ?? null;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Sorted list of the permissions granted by a list of roles. */
export function permissionsOf(roles = []) {
  const granted = new Set();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return [...granted].sort();
}

/** GET/PATCH /me: the caller's account (roles from the token) merged with the profile. */
export function toApiMe(profile, identity) {
  return {
    id: identity.userId,
    email: identity.email ?? profile.email ?? null,
    name: profile.displayName ?? identity.name,
    role: identity.role ?? null,
    roles: identity.roles,
    permissions: permissionsOf(identity.roles),
    bio: profile.bio ?? null,
    avatarUrl: profile.avatarUrl ?? null,
    website: profile.website ?? null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/** Public author profile (GET /authors/{userId}): the e-mail address is never exposed. */
export function toPublicProfile(profile) {
  return {
    id: profile.userId,
    name: profile.displayName,
    bio: profile.bio ?? null,
    avatarUrl: profile.avatarUrl ?? null,
    website: profile.website ?? null,
  };
}

/**
 * Administration view of a Cognito user. Accepts the UserType of ListUsers / ListUsersInGroup /
 * AdminCreateUser (`Attributes`) and the AdminGetUser response (`UserAttributes`).
 * `groups` are the user's Cognito groups: the role is the most privileged role group.
 */
export function toApiUser(user, groups = []) {
  const attributes = user.Attributes ?? user.UserAttributes ?? [];
  return {
    id: attributeValue(attributes, 'sub') ?? user.Username,
    email: attributeValue(attributes, 'email'),
    name: attributeValue(attributes, 'name'),
    status: user.UserStatus ?? null,
    enabled: Boolean(user.Enabled),
    role: primaryRole(groups),
    createdAt: toIso(user.UserCreateDate),
    updatedAt: toIso(user.UserLastModifiedDate),
  };
}

/** Tokens of a successful authentication (the refresh token is only present when issued). */
export function toApiTokens(result) {
  return {
    tokenType: 'Bearer',
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    ...(result.RefreshToken ? { refreshToken: result.RefreshToken } : {}),
    expiresIn: result.ExpiresIn,
  };
}

/**
 * InitiateAuth / RespondToAuthChallenge response -> tokens, or the NEW_PASSWORD_REQUIRED
 * challenge (accounts created by an administrator). Other challenges (MFA...) are not
 * enabled on the user pool and cannot be completed through this API.
 */
export function toAuthResult(response) {
  if (response?.AuthenticationResult) return toApiTokens(response.AuthenticationResult);
  if (response?.ChallengeName === NEW_PASSWORD_REQUIRED) {
    return { challenge: NEW_PASSWORD_REQUIRED, session: response.Session };
  }
  throw new AppError(
    501,
    'UNSUPPORTED_CHALLENGE',
    `The authentication challenge ${response?.ChallengeName ?? '(none)'} is not supported by this API`,
  );
}

// ---------------------------------------------------------------------------
// Profiles (DynamoDB item USER#<userId> / PROFILE)
// ---------------------------------------------------------------------------

/** New profile item (optional fields empty). */
export function newProfileItem({ userId, email, displayName }, now = nowIso()) {
  return {
    ...keys.profile(userId),
    entityType: ENTITY.PROFILE,
    userId,
    email: email ?? null,
    displayName,
    bio: null,
    avatarUrl: null,
    website: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Reads a profile (null when it does not exist). */
export async function getProfile(userId, { consistent = false } = {}) {
  const { Item } = await dynamo().send(
    new GetCommand({ TableName: tableName(), Key: keys.profile(userId), ConsistentRead: consistent }),
  );
  return Item ?? null;
}

/** Writes a profile unless one already exists. Returns true when the item was created. */
export async function putProfileIfAbsent(item) {
  try {
    await dynamo().send(
      new PutCommand({ TableName: tableName(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/** Profile of the caller, created from the token identity on first access. */
export async function getOrCreateProfile(identity) {
  const existing = await getProfile(identity.userId, { consistent: true });
  if (existing) return existing;
  const item = newProfileItem({ userId: identity.userId, email: identity.email, displayName: identity.name });
  if (await putProfileIfAbsent(item)) return item;
  // Created concurrently by another request: return the stored version.
  return (await getProfile(identity.userId, { consistent: true })) ?? item;
}

/**
 * Profile creation right after an account creation. The account is already usable, so a
 * failure only delays the profile, which GET /me (or PATCH /me) creates lazily.
 */
async function initProfile(profile) {
  try {
    await putProfileIfAbsent(newProfileItem(profile));
  } catch (err) {
    logger.warn('Profile creation failed, it will be created on first access', { userId: profile.userId, error: err });
  }
}

/** Builds a `SET` update expression (every attribute name goes through a placeholder). */
function upsertExpression() {
  const names = {};
  const values = {};
  const clauses = [];
  const add = (attribute, value, expression) => {
    names[`#${attribute}`] = attribute;
    values[`:${attribute}`] = value;
    clauses.push(`#${attribute} = ${expression}`);
  };
  return {
    set: (attribute, value) => add(attribute, value, `:${attribute}`),
    setIfMissing: (attribute, value) => add(attribute, value, `if_not_exists(#${attribute}, :${attribute})`),
    params: () => ({
      UpdateExpression: `SET ${clauses.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  };
}

/**
 * PATCH /me: partial update of the caller's profile (upsert: the profile is created when it
 * does not exist yet). `changes` may contain name, bio, avatarUrl, website (null clears).
 * A new name is also written to the Cognito `name` attribute, so that new ID tokens carry it
 * (existing posts keep the author name they were written with). Returns the stored item.
 */
export async function updateProfile(identity, changes) {
  const { userId } = identity;
  if (changes.name !== undefined) {
    await sendCognito(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: config.userPoolId,
        Username: userId,
        UserAttributes: [{ Name: 'name', Value: changes.name }],
      }),
      'admin',
    );
  }

  const now = nowIso();
  const update = upsertExpression();
  update.set('entityType', ENTITY.PROFILE);
  update.set('userId', userId);
  if (identity.email) update.set('email', identity.email);
  else update.setIfMissing('email', null);
  const fields = {
    displayName: [changes.name, identity.name],
    bio: [changes.bio, null],
    avatarUrl: [changes.avatarUrl, null],
    website: [changes.website, null],
  };
  for (const [attribute, [value, fallback]] of Object.entries(fields)) {
    if (value === undefined) update.setIfMissing(attribute, fallback);
    else update.set(attribute, value);
  }
  update.setIfMissing('createdAt', now);
  update.set('updatedAt', now);

  const { Attributes } = await dynamo().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.profile(userId),
      ...update.params(),
      ReturnValues: 'ALL_NEW',
    }),
  );
  return Attributes;
}

// ---------------------------------------------------------------------------
// Authentication facade (public app client, no client secret)
// ---------------------------------------------------------------------------

/** Demo mode: confirms a new account without the e-mailed code. Returns true when confirmed. */
async function autoConfirm(userId) {
  try {
    await cognito().send(new AdminConfirmSignUpCommand({ UserPoolId: config.userPoolId, Username: userId }));
  } catch (err) {
    // The account exists anyway: the user can still confirm it with the code e-mailed by Cognito.
    logger.warn('Automatic confirmation failed, the e-mailed code must be used', { userId, error: err });
    return false;
  }
  try {
    await cognito().send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: config.userPoolId,
        Username: userId,
        UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
      }),
    );
  } catch (err) {
    // The account is confirmed (login works); only password recovery needs a verified address.
    logger.warn('Could not mark the e-mail address as verified', { userId, error: err });
  }
  return true;
}

/**
 * POST /auth/register: self-registration as guest author. In demo mode
 * (config.autoConfirmUsers) the account is confirmed immediately.
 */
export async function registerUser({ email, password, name }) {
  const signUp = await sendCognito(
    new SignUpCommand({
      ClientId: config.userPoolClientId,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'name', Value: name },
      ],
    }),
    'account',
  );
  const userId = signUp.UserSub;
  try {
    await sendCognito(
      new AdminAddUserToGroupCommand({ UserPoolId: config.userPoolId, Username: userId, GroupName: DEFAULT_ROLE }),
      'admin',
    );
  } catch (err) {
    // The account exists without any role (no permission): an administrator can assign it.
    logger.error('Role assignment failed after sign-up', { userId, error: err });
    throw err;
  }
  let confirmed = Boolean(signUp.UserConfirmed);
  if (!confirmed && config.autoConfirmUsers) confirmed = await autoConfirm(userId);
  await initProfile({ userId, email, displayName: name });
  logger.info('User registered', { userId, confirmed });
  return {
    userId,
    email,
    name,
    role: DEFAULT_ROLE,
    confirmed,
    nextStep: confirmed ? 'LOGIN' : 'CONFIRM_SIGN_UP',
  };
}

/** POST /auth/confirm: confirms a self-registered account with the e-mailed code. */
export async function confirmRegistration({ email, code }) {
  await sendCognito(
    new ConfirmSignUpCommand({ ClientId: config.userPoolClientId, Username: email, ConfirmationCode: code }),
    'account',
  );
}

/** POST /auth/resend-code: sends a new confirmation code (unknown accounts answer the same). */
export async function resendConfirmationCode({ email }) {
  try {
    await cognito().send(new ResendConfirmationCodeCommand({ ClientId: config.userPoolClientId, Username: email }));
  } catch (err) {
    if (err?.name !== 'UserNotFoundException') throw mapCognitoError(err, 'account');
    logger.info('Confirmation code requested for an unknown account');
  }
}

/** POST /auth/login: e-mail + password -> tokens, or a NEW_PASSWORD_REQUIRED challenge. */
export async function login({ email, password }) {
  const response = await sendCognito(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.userPoolClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
    'login',
  );
  return toAuthResult(response);
}

/** POST /auth/refresh: new ID/access tokens from a refresh token. */
export async function refreshTokens({ refreshToken }) {
  const response = await sendCognito(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: config.userPoolClientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
    'token',
  );
  return toAuthResult(response);
}

/** POST /auth/new-password: answers the NEW_PASSWORD_REQUIRED challenge of a first login. */
export async function completeNewPassword({ email, newPassword, session }) {
  const response = await sendCognito(
    new RespondToAuthChallengeCommand({
      ClientId: config.userPoolClientId,
      ChallengeName: NEW_PASSWORD_REQUIRED,
      Session: session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    }),
    'session',
  );
  return toAuthResult(response);
}

/**
 * ForgotPassword errors that depend on the account (unknown, unverified e-mail, disabled,
 * per-account attempt limit, delivery failure): answered like a success, otherwise the
 * endpoint would reveal which e-mail addresses are registered.
 */
const SILENT_FORGOT_PASSWORD_ERRORS = new Set([
  'UserNotFoundException',
  'NotAuthorizedException',
  'InvalidParameterException',
  'UserNotConfirmedException',
  'LimitExceededException',
  'CodeDeliveryFailureException',
]);

/** POST /auth/forgot-password: e-mails a reset code when the account exists (always "accepted"). */
export async function forgotPassword({ email }) {
  try {
    await cognito().send(new ForgotPasswordCommand({ ClientId: config.userPoolClientId, Username: email }));
  } catch (err) {
    if (!SILENT_FORGOT_PASSWORD_ERRORS.has(err?.name)) throw mapCognitoError(err, 'account');
    const log = err.name === 'UserNotFoundException' ? logger.info : logger.warn;
    log('Password reset request not fulfilled', { reason: err.name });
  }
}

/** POST /auth/reset-password: sets a new password with the e-mailed reset code. */
export async function resetPassword({ email, code, newPassword }) {
  await sendCognito(
    new ConfirmForgotPasswordCommand({
      ClientId: config.userPoolClientId,
      Username: email,
      ConfirmationCode: code,
      Password: newPassword,
    }),
    'account',
  );
}

/** POST /auth/logout: revokes the refresh token (and the access tokens issued with it). */
export async function logout({ refreshToken }) {
  await sendCognito(new RevokeTokenCommand({ ClientId: config.userPoolClientId, Token: refreshToken }), 'token');
}

// ---------------------------------------------------------------------------
// User administration (Cognito admin APIs)
// ---------------------------------------------------------------------------

/** Opaque GET /users cursor: a Cognito pagination token bound to the role filter it belongs to. */
export function encodeUsersCursor(token, role = null) {
  if (!token) return null;
  return Buffer.from(JSON.stringify({ token, role: role ?? null }), 'utf8').toString('base64url');
}

/** Returns the Cognito pagination token of a cursor (400 when malformed or issued for another filter). */
export function decodeUsersCursor(cursor, role = null) {
  if (cursor === undefined || cursor === null || cursor === '') return undefined;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
  const valid =
    decoded !== null &&
    typeof decoded === 'object' &&
    typeof decoded.token === 'string' &&
    decoded.token.length > 0 &&
    (decoded.role ?? null) === (role ?? null);
  if (!valid) throw badRequest('Invalid pagination cursor');
  return decoded.token;
}

/** Runs `fn` on every item with at most `limit` calls in flight; results keep the input order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Names of the Cognito groups of a user (404 when the user does not exist). */
async function listGroupsForUser(userId) {
  const groups = [];
  let nextToken;
  let pages = 0;
  do {
    const response = await sendCognito(
      new AdminListGroupsForUserCommand({ UserPoolId: config.userPoolId, Username: userId, NextToken: nextToken }),
      'admin',
    );
    groups.push(...(response.Groups ?? []).map((group) => group.GroupName));
    nextToken = response.NextToken;
    pages += 1;
  } while (nextToken && pages < 10);
  return groups;
}

/** Groups of a user returned by ListUsers, or null when the user was deleted in the meantime. */
async function groupsOfListedUser(userId) {
  try {
    return await listGroupsForUser(userId);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * GET /users: one page of users. With `role`, the members of that role group
 * (ListUsersInGroup); otherwise every user (ListUsers) with their groups looked up in parallel.
 */
export async function listUsers({ limit, cursor, role }) {
  const token = decodeUsersCursor(cursor, role);
  if (role) {
    const page = await sendCognito(
      new ListUsersInGroupCommand({ UserPoolId: config.userPoolId, GroupName: role, Limit: limit, NextToken: token }),
      'admin',
    );
    return {
      items: (page.Users ?? []).map((user) => toApiUser(user, [role])),
      nextCursor: encodeUsersCursor(page.NextToken, role),
    };
  }
  const page = await sendCognito(
    new ListUsersCommand({ UserPoolId: config.userPoolId, Limit: limit, PaginationToken: token }),
    'admin',
  );
  const found = page.Users ?? [];
  const groups = await mapWithConcurrency(found, GROUP_LOOKUP_CONCURRENCY, (user) => groupsOfListedUser(user.Username));
  return {
    items: found.flatMap((user, index) => (groups[index] ? [toApiUser(user, groups[index])] : [])),
    nextCursor: encodeUsersCursor(page.PaginationToken, null),
  };
}

/** One user with its groups (AdminGetUser + AdminListGroupsForUser unless `knownGroups` is given). */
export async function getUser(userId, knownGroups) {
  const [user, groups] = await Promise.all([
    sendCognito(new AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: userId }), 'admin'),
    knownGroups ?? listGroupsForUser(userId),
  ]);
  return toApiUser(user, groups);
}

/**
 * POST /users: creates an account (Cognito e-mails a temporary password; the first login
 * answers a NEW_PASSWORD_REQUIRED challenge) with the given role.
 */
export async function inviteUser({ email, name, role }, actor) {
  const { User: user } = await sendCognito(
    new AdminCreateUserCommand({
      UserPoolId: config.userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    }),
    'admin',
  );
  const userId = attributeValue(user.Attributes, 'sub') ?? user.Username;
  await sendCognito(
    new AdminAddUserToGroupCommand({ UserPoolId: config.userPoolId, Username: userId, GroupName: role }),
    'admin',
  );
  await initProfile({ userId, email, displayName: name });
  logger.info('User invited', { userId, role, by: actor?.userId });
  return toApiUser(user, [role]);
}

/**
 * Makes `role` the only role group of the user: the other role groups are left first, so that
 * a failure leaves the user with fewer privileges, never more. Returns the resulting groups.
 */
async function assignRole(userId, role) {
  const current = await listGroupsForUser(userId);
  const obsolete = current.filter((group) => ALL_ROLES.includes(group) && group !== role);
  await Promise.all(
    obsolete.map((group) =>
      sendCognito(
        new AdminRemoveUserFromGroupCommand({ UserPoolId: config.userPoolId, Username: userId, GroupName: group }),
        'admin',
      ),
    ),
  );
  await sendCognito(
    new AdminAddUserToGroupCommand({ UserPoolId: config.userPoolId, Username: userId, GroupName: role }),
    'admin',
  );
  return [...current.filter((group) => !obsolete.includes(group) && group !== role), role];
}

/**
 * PATCH /users/{userId}: changes the role and/or the enabled state of an account.
 * Administrators cannot modify their own account here (no self-demotion, no self-lockout, and a
 * disabled administrator whose ID token is still valid cannot re-enable it).
 * A role change is effective at the user's next token refresh or login; disabling an account
 * also revokes its refresh tokens.
 */
export async function updateUser(actor, userId, { role, enabled }) {
  if (String(userId).toLowerCase() === String(actor.userId).toLowerCase()) {
    throw conflict('Administrators cannot change their own role or account status', 'SELF_MODIFICATION');
  }
  let groups;
  if (role !== undefined) groups = await assignRole(userId, role);
  if (enabled === false) {
    await sendCognito(new AdminDisableUserCommand({ UserPoolId: config.userPoolId, Username: userId }), 'admin');
    await sendCognito(new AdminUserGlobalSignOutCommand({ UserPoolId: config.userPoolId, Username: userId }), 'admin');
  } else if (enabled === true) {
    await sendCognito(new AdminEnableUserCommand({ UserPoolId: config.userPoolId, Username: userId }), 'admin');
  }
  logger.info('User updated', { userId, role, enabled, by: actor.userId });
  return getUser(userId, groups);
}
