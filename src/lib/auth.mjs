// Authentication (Cognito ID tokens) and role-based authorisation (RBAC).
//
// Roles are Amazon Cognito groups. A user belongs to exactly one of:
//   admin         full control, including user and role management
//   editor        manages every post (review, publish), moderates comments, manages media
//   guest-author  writes their own posts and submits them for review (cannot publish)
// Users without any group are authenticated but have no write permission (default deny).

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from './config.mjs';
import { forbidden, unauthorized } from './errors.mjs';
import { logger } from './logger.mjs';

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  EDITOR: 'editor',
  GUEST_AUTHOR: 'guest-author',
});

export const ALL_ROLES = Object.freeze([ROLES.ADMIN, ROLES.EDITOR, ROLES.GUEST_AUTHOR]);

/** Role assigned to self-registered users. */
export const DEFAULT_ROLE = ROLES.GUEST_AUTHOR;

const ROLE_RANK = { [ROLES.ADMIN]: 3, [ROLES.EDITOR]: 2, [ROLES.GUEST_AUTHOR]: 1 };

export const PERMISSIONS = Object.freeze({
  POST_CREATE: 'post:create',
  POST_READ_ANY: 'post:read:any', // read unpublished posts of other authors
  POST_UPDATE_OWN: 'post:update:own',
  POST_UPDATE_ANY: 'post:update:any',
  POST_DELETE_OWN: 'post:delete:own',
  POST_DELETE_ANY: 'post:delete:any',
  POST_SUBMIT: 'post:submit',
  POST_PUBLISH: 'post:publish', // publish, unpublish, reject, archive
  COMMENT_MODERATE: 'comment:moderate',
  MEDIA_UPLOAD: 'media:upload',
  MEDIA_READ_ANY: 'media:read:any',
  MEDIA_DELETE_ANY: 'media:delete:any',
  USER_MANAGE: 'user:manage',
  SUBSCRIPTION_READ: 'subscription:read',
});

const P = PERMISSIONS;

/** Permission matrix (role -> granted permissions). */
export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: new Set(Object.values(PERMISSIONS)),
  [ROLES.EDITOR]: new Set([
    P.POST_CREATE,
    P.POST_READ_ANY,
    P.POST_UPDATE_OWN,
    P.POST_UPDATE_ANY,
    P.POST_DELETE_OWN,
    P.POST_DELETE_ANY,
    P.POST_SUBMIT,
    P.POST_PUBLISH,
    P.COMMENT_MODERATE,
    P.MEDIA_UPLOAD,
    P.MEDIA_READ_ANY,
    P.MEDIA_DELETE_ANY,
  ]),
  [ROLES.GUEST_AUTHOR]: new Set([
    P.POST_CREATE,
    P.POST_UPDATE_OWN,
    P.POST_DELETE_OWN,
    P.POST_SUBMIT,
    P.MEDIA_UPLOAD,
  ]),
});

/**
 * Normalises the `cognito:groups` claim, which can be an array (raw JWT), a JSON array string,
 * a bracketed space separated string ("[admin editor]") or a comma separated string.
 * Unknown groups are ignored. Result is sorted by decreasing privilege.
 */
export function parseRoles(value) {
  let list = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        list = trimmed.slice(1, -1).split(/[\s,]+/);
      }
    } else {
      list = trimmed.split(/[\s,]+/);
    }
  }
  const roles = new Set(
    list.map((role) => String(role).trim()).filter((role) => Object.hasOwn(ROLE_RANK, role)),
  );
  return [...roles].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);
}

/** Highest-privilege role of a role list (or null). */
export function primaryRole(roles) {
  return parseRoles(roles)[0] ?? null;
}

function displayNameFrom(name, email) {
  if (name && String(name).trim()) return String(name).trim();
  if (email) return String(email).split('@')[0];
  return 'Anonymous';
}

/** Identity from verified Cognito ID token claims. */
export function identityFromClaims(claims) {
  const roles = parseRoles(claims['cognito:groups']);
  return {
    userId: claims.sub,
    email: claims.email ?? null,
    name: displayNameFrom(claims.name, claims.email),
    roles,
    role: roles[0] ?? null,
  };
}

/** Identity from the Lambda TOKEN authorizer context (all values are strings). */
export function identityFromAuthorizerContext(context) {
  const roles = parseRoles(context.roles);
  return {
    userId: context.userId,
    email: context.email || null,
    name: displayNameFrom(context.name, context.email),
    roles,
    role: roles[0] ?? null,
  };
}

/** Builds the TOKEN authorizer context from an identity. */
export function authorizerContextFromIdentity(identity) {
  return {
    userId: identity.userId,
    email: identity.email ?? '',
    name: identity.name ?? '',
    roles: identity.roles.join(','),
  };
}

export function hasRole(identity, ...roles) {
  return Boolean(identity) && identity.roles.some((role) => roles.includes(role));
}

/** True when the identity is granted `permission` by at least one of its roles. */
export function can(identity, permission) {
  if (!identity) return false;
  return identity.roles.some((role) => ROLE_PERMISSIONS[role]?.has(permission));
}

/** Throws 401 for anonymous callers and 403 when the permission is missing. */
export function assertCan(identity, permission, message) {
  if (!identity) throw unauthorized();
  if (!can(identity, permission)) throw forbidden(message);
}

export function assertAuthenticated(identity) {
  if (!identity) throw unauthorized();
}

export function isOwner(identity, ownerId) {
  return Boolean(identity && ownerId && identity.userId === ownerId);
}

/**
 * Ownership-aware check: allowed when the caller has the `anyPermission`, or owns the
 * resource and has the `ownPermission`.
 */
export function canActOn(identity, ownerId, ownPermission, anyPermission) {
  if (can(identity, anyPermission)) return true;
  return isOwner(identity, ownerId) && can(identity, ownPermission);
}

/** "Bearer abc" | "bearer abc" | "abc" -> "abc"; anything else -> null. */
export function extractBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const value = headerValue.trim();
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  const token = (match ? match[1] : value).trim();
  return /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(token) ? token : null;
}

let verifier;

/** Cognito ID-token verifier (JWKS downloaded once per execution environment, then cached). */
export function getVerifier() {
  if (!verifier) {
    if (!config.userPoolId || !config.userPoolClientId) {
      throw new Error('USER_POOL_ID and USER_POOL_CLIENT_ID must be configured');
    }
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.userPoolId,
      clientId: config.userPoolClientId,
      tokenUse: 'id',
    });
  }
  return verifier;
}

/** Test helper: replace (or reset with undefined) the verifier instance. */
export function setVerifier(customVerifier) {
  verifier = customVerifier;
}

/** Verifies signature, expiry, issuer, audience and token_use. Returns the claims. */
export async function verifyIdToken(token) {
  return getVerifier().verify(token);
}

function headerValue(event, name) {
  const headers = event?.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Resolves the caller identity for an API Gateway (REST) proxy event.
 *   mode 'none'     -> always null
 *   mode 'optional' -> identity when a valid token is sent, null when no token (401 if invalid)
 *   mode 'required' -> identity or 401
 * Protected routes are already verified by the Lambda TOKEN authorizer (context.userId);
 * public routes verify the optional token here with the same verifier.
 */
export async function resolveIdentity(event, mode = 'none') {
  if (mode === 'none') return null;

  const authorizer = event?.requestContext?.authorizer;
  if (authorizer?.userId) return identityFromAuthorizerContext(authorizer);
  if (authorizer?.claims?.sub) return identityFromClaims(authorizer.claims);

  const rawHeader = headerValue(event, 'authorization');
  if (rawHeader === undefined || rawHeader === null || String(rawHeader).trim() === '') {
    if (mode === 'required') throw unauthorized();
    return null;
  }
  const token = extractBearerToken(rawHeader);
  if (!token) throw unauthorized('Malformed Authorization header (expected "Bearer <idToken>")');
  try {
    return identityFromClaims(await verifyIdToken(token));
  } catch (err) {
    logger.info('Rejected token', { reason: err?.message });
    throw unauthorized('Invalid or expired token');
  }
}
