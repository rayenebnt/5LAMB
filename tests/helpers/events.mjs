// Builders for API Gateway REST (proxy) events and test identities.

import { authorizerContextFromIdentity } from '../../src/lib/auth.mjs';

export const users = {
  admin: { userId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Alice Admin', roles: ['admin'] },
  editor: { userId: '22222222-2222-4222-8222-222222222222', email: 'editor@example.com', name: 'Eddie Editor', roles: ['editor'] },
  author: { userId: '33333333-3333-4333-8333-333333333333', email: 'author@example.com', name: 'Gaby Guest', roles: ['guest-author'] },
  author2: { userId: '44444444-4444-4444-8444-444444444444', email: 'author2@example.com', name: 'Hugo Guest', roles: ['guest-author'] },
  noRole: { userId: '55555555-5555-4555-8555-555555555555', email: 'norole@example.com', name: 'Nora Norole', roles: [] },
};

function fillPath(resource, pathParameters) {
  return String(resource ?? '/').replace(/\{(\w+)\+?\}/g, (_, name) =>
    encodeURIComponent(pathParameters?.[name] ?? `{${name}}`),
  );
}

/**
 * Builds an API Gateway REST proxy event.
 * @param {object} options
 * @param {string} options.method HTTP method
 * @param {string} options.resource route template, e.g. "/posts/{postId}"
 * @param {object} [options.params] path parameters
 * @param {object} [options.query] query string parameters
 * @param {object|string} [options.body] JSON body (object is stringified)
 * @param {object} [options.headers]
 * @param {object} [options.as] identity injected as Lambda authorizer context (protected routes)
 * @param {string} [options.token] raw ID token sent in the Authorization header (optional-auth routes)
 */
export function apiEvent({ method = 'GET', resource = '/', params = null, query = null, body, headers = {}, as, token } = {}) {
  const allHeaders = { 'Content-Type': 'application/json', ...headers };
  if (token) allHeaders.Authorization = `Bearer ${token}`;
  return {
    resource,
    path: fillPath(resource, params),
    httpMethod: method,
    headers: allHeaders,
    multiValueHeaders: {},
    queryStringParameters: query,
    multiValueQueryStringParameters: null,
    pathParameters: params,
    stageVariables: null,
    requestContext: {
      requestId: 'test-request-id',
      stage: 'test',
      resourcePath: resource,
      httpMethod: method,
      identity: { sourceIp: '203.0.113.10', userAgent: 'node-test' },
      ...(as ? { authorizer: { principalId: as.userId, ...authorizerContextFromIdentity(as) } } : {}),
    },
    body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/** Parses a Lambda proxy response body. */
export function parse(response) {
  return response.body ? JSON.parse(response.body) : undefined;
}

export const lambdaContext = { awsRequestId: 'test-aws-request-id', functionName: 'test' };
