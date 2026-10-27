// Generates RSA keys and signs Cognito-like ID tokens so that the real aws-jwt-verify
// verifier can be exercised offline (JWKS pre-loaded with cacheJwks).

import { createSign, generateKeyPairSync } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { setVerifier } from '../../src/lib/auth.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'blogify-test-key';

export const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function issuerFor(userPoolId = process.env.USER_POOL_ID) {
  const region = userPoolId.split('_')[0];
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

/** Signs an ID token for the given identity ({ userId, email, name, roles }). */
export function signIdToken(identity, { expiresIn = 3600, overrides = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: identity.userId,
    email: identity.email,
    name: identity.name,
    'cognito:groups': identity.roles,
    email_verified: true,
    iss: issuerFor(),
    aud: process.env.USER_POOL_CLIENT_ID,
    token_use: 'id',
    auth_time: now,
    iat: now,
    exp: now + expiresIn,
    ...overrides,
  };
  if (!identity.roles?.length) delete payload['cognito:groups'];
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

/** Installs a real CognitoJwtVerifier whose JWKS is pre-cached with the test key. */
export function installTestVerifier() {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID,
    clientId: process.env.USER_POOL_CLIENT_ID,
    tokenUse: 'id',
  });
  verifier.cacheJwks(jwks);
  setVerifier(verifier);
  return verifier;
}
