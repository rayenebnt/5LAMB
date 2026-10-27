// Lambda TOKEN authorizer for API Gateway (REST).
// Verifies the Cognito ID token sent as "Authorization: Bearer <idToken>" (or the raw token)
// and returns an IAM policy plus a context { userId, email, name, roles } that API Gateway
// forwards to the integration in event.requestContext.authorizer.
// Role checks (RBAC) are done by each function, which knows the resource being accessed.

import {
  authorizerContextFromIdentity,
  extractBearerToken,
  identityFromClaims,
  verifyIdToken,
} from '../../lib/auth.mjs';
import { logger } from '../../lib/logger.mjs';

/**
 * The policy covers every method of the stage so that the cached authorizer result
 * (cached per token for ReauthorizeEvery seconds) can be reused across routes.
 * methodArn: arn:aws:execute-api:{region}:{account}:{apiId}/{stage}/{method}/{resourcePath}
 */
export function stageWildcardArn(methodArn) {
  const [apiArn, stage] = String(methodArn).split('/');
  return `${apiArn}/${stage}/*`;
}

export async function handler(event) {
  const token = extractBearerToken(event?.authorizationToken);
  if (!token) throw new Error('Unauthorized'); // API Gateway answers 401

  let claims;
  try {
    claims = await verifyIdToken(token);
  } catch (err) {
    logger.info('Token rejected by authorizer', { reason: err?.message });
    throw new Error('Unauthorized');
  }

  const identity = identityFromClaims(claims);
  return {
    principalId: identity.userId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        { Action: 'execute-api:Invoke', Effect: 'Allow', Resource: stageWildcardArn(event.methodArn) },
      ],
    },
    context: authorizerContextFromIdentity(identity),
  };
}
