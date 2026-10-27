// Authentication facade over Amazon Cognito (public routes, no authorizer): registration,
// e-mail confirmation, login (USER_PASSWORD_AUTH), first-login password change, token refresh
// and revocation, password reset. Business rules and Cognito calls live in src/domain/users.mjs.

import {
  completeNewPassword,
  confirmRegistration,
  forgotPassword,
  login,
  logout,
  refreshTokens,
  registerUser,
  resendConfirmationCode,
  resetPassword,
} from '../../domain/users.mjs';
import { accepted, created, createApiHandler, noContent, ok } from '../../lib/http.mjs';
import { schemas, validate, z } from '../../lib/validation.mjs';

const name = z.string().trim().min(1, 'Name is required').max(80);
const code = z
  .string()
  .trim()
  .min(1, 'Code is required')
  .max(64)
  .regex(/^\S+$/, 'Code must not contain spaces');
/** Cognito refresh tokens (JWE) and challenge sessions are opaque, URL-safe strings. */
const refreshToken = z.string().trim().min(1, 'Token is required').max(8192).regex(/^[\w.-]+$/, 'Malformed token');
const session = z.string().trim().min(1, 'Session is required').max(2048);

const registerSchema = z.strictObject({ email: schemas.email, password: schemas.password, name });
const confirmSchema = z.strictObject({ email: schemas.email, code });
const emailSchema = z.strictObject({ email: schemas.email });
const loginSchema = z.strictObject({ email: schemas.email, password: schemas.password });
const refreshSchema = z.strictObject({ refreshToken });
const newPasswordSchema = z.strictObject({ email: schemas.email, newPassword: schemas.password, session });
const resetPasswordSchema = z.strictObject({ email: schemas.email, code, newPassword: schemas.password });

/** Responses carrying tokens or a challenge session must never be cached (RFC 6749 section 5.1). */
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

async function register(req) {
  const account = await registerUser(validate(registerSchema, req.body));
  return created(account, `/authors/${account.userId}`);
}

async function confirm(req) {
  await confirmRegistration(validate(confirmSchema, req.body));
  return ok({ confirmed: true });
}

async function resendCode(req) {
  await resendConfirmationCode(validate(emailSchema, req.body));
  return accepted({
    message: 'If the account exists and is awaiting confirmation, a new verification code has been e-mailed',
  });
}

async function signIn(req) {
  return ok(await login(validate(loginSchema, req.body)), NO_STORE);
}

async function refresh(req) {
  return ok(await refreshTokens(validate(refreshSchema, req.body)), NO_STORE);
}

async function newPassword(req) {
  return ok(await completeNewPassword(validate(newPasswordSchema, req.body)), NO_STORE);
}

async function requestPasswordReset(req) {
  await forgotPassword(validate(emailSchema, req.body));
  // Same answer whether the account exists or not (no user enumeration).
  return accepted({ message: 'If an account exists for this e-mail address, a password reset code has been e-mailed' });
}

async function confirmPasswordReset(req) {
  await resetPassword(validate(resetPasswordSchema, req.body));
  return ok({ message: 'Password updated, you can now log in with the new password' });
}

async function signOut(req) {
  await logout(validate(refreshSchema, req.body));
  return noContent();
}

export const routes = {
  'POST /auth/register': { auth: 'none', handler: register },
  'POST /auth/confirm': { auth: 'none', handler: confirm },
  'POST /auth/resend-code': { auth: 'none', handler: resendCode },
  'POST /auth/login': { auth: 'none', handler: signIn },
  'POST /auth/refresh': { auth: 'none', handler: refresh },
  'POST /auth/new-password': { auth: 'none', handler: newPassword },
  'POST /auth/forgot-password': { auth: 'none', handler: requestPasswordReset },
  'POST /auth/reset-password': { auth: 'none', handler: confirmPasswordReset },
  'POST /auth/logout': { auth: 'none', handler: signOut },
};

export const handler = createApiHandler(routes);
