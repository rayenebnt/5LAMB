// HTTP helpers for API Gateway REST (Lambda proxy integration):
// JSON responses with CORS headers, body parsing, ETags and a tiny router.

import { config } from './config.mjs';
import {
  AppError,
  badRequest,
  payloadTooLarge,
  serviceUnavailable,
  unsupportedMediaType,
} from './errors.mjs';
import { logger } from './logger.mjs';
import { resolveIdentity } from './auth.mjs';

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB of JSON per request

export function baseHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': config.allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,If-Match',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'ETag,Location',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

export function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers }),
    body: JSON.stringify(body),
  };
}

export const ok = (body, headers) => json(200, body, headers);

export const created = (body, location, headers = {}) =>
  json(201, body, location ? { Location: location, ...headers } : headers);

export const accepted = (body, headers) => json(202, body, headers);

export const noContent = (headers = {}) => ({ statusCode: 204, headers: baseHeaders(headers), body: '' });

export function html(body, headers = {}) {
  return {
    statusCode: 200,
    headers: baseHeaders({ 'Content-Type': 'text/html; charset=utf-8', ...headers }),
    body,
  };
}

export function redirect(location, statusCode = 302, headers = {}) {
  return { statusCode, headers: baseHeaders({ Location: location, ...headers }), body: '' };
}

/** Cache headers for public GET responses (CDN / browser caching). */
export function cacheHeaders(identity, maxAgeSeconds = 60) {
  return identity
    ? { 'Cache-Control': 'private, no-store' }
    : { 'Cache-Control': `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 5}` };
}

/** Strong ETag derived from an item version number. */
export function etag(version) {
  return `"v${version}"`;
}

/**
 * Parses an If-Match header ("v3", "\"v3\"", "W/\"v3\"", "3") into a version number.
 * Returns undefined when absent or "*", and throws 400 when malformed.
 */
export function parseIfMatch(value) {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (raw === '' || raw === '*') return undefined;
  const match = /^(?:W\/)?"?v?(\d+)"?$/.exec(raw);
  if (!match) throw badRequest('Malformed If-Match header (expected an ETag such as "v3")');
  return Number.parseInt(match[1], 10);
}

export function getHeader(event, name) {
  const headers = event?.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Parses a JSON object body. An empty body is treated as {}. */
export function parseJsonBody(event) {
  if (event?.body === undefined || event.body === null || event.body === '') return {};
  const contentType = getHeader(event, 'content-type');
  if (contentType && !/^application\/([\w.+-]+\+)?json\b/i.test(String(contentType).trim())) {
    throw unsupportedMediaType('Content-Type must be application/json');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : String(event.body);
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw payloadTooLarge(`Request body must not exceed ${MAX_BODY_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Request body must be a JSON object');
  }
  return parsed;
}

function decodeParams(params) {
  const decoded = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    try {
      decoded[key] = decodeURIComponent(value);
    } catch {
      decoded[key] = value;
    }
  }
  return decoded;
}

const THROTTLING_ERRORS = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'LimitExceededException',
]);

/** Converts any error into an API response; unexpected errors are logged and hidden. */
export function errorResponse(err, requestId) {
  if (err instanceof AppError) {
    const error = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    if (err.statusCode >= 500) logger.error('Request failed', { requestId, error: err });
    return json(err.statusCode, { error, requestId });
  }
  if (THROTTLING_ERRORS.has(err?.name)) {
    logger.warn('Downstream throttling', { requestId, error: err });
    const unavailable = serviceUnavailable('The service is busy, please retry shortly');
    return json(503, { error: { code: unavailable.code, message: unavailable.message }, requestId }, { 'Retry-After': '1' });
  }
  logger.error('Unhandled error', { requestId, error: err });
  return json(500, {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    requestId,
  });
}

/**
 * Creates a Lambda handler for API Gateway REST proxy events, routing on
 * `${httpMethod} ${resource}` where `resource` is the route template (e.g. "/posts/{postId}").
 *
 * @param {Record<string, {auth?: 'none'|'optional'|'required', handler: (req: object) => Promise<object>}>} routes
 *
 * Handlers receive `req`:
 *   { event, context, requestId, method, resource, path, params, query, headers(name), body, identity }
 * `req.body` is the parsed JSON object (parsed lazily on first access).
 */
export function createApiHandler(routes) {
  return async function apiHandler(event, context) {
    const requestId = event?.requestContext?.requestId ?? context?.awsRequestId ?? 'local';
    const routeKey = `${event?.httpMethod} ${event?.resource}`;
    const route = routes[routeKey];
    const started = Date.now();
    let response;
    try {
      if (!route) {
        throw new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${event?.httpMethod} ${event?.path ?? event?.resource}`);
      }
      const identity = await resolveIdentity(event, route.auth ?? 'none');
      let parsedBody;
      const req = {
        event,
        context,
        requestId,
        method: event.httpMethod,
        resource: event.resource,
        path: event.path,
        params: decodeParams(event.pathParameters),
        query: event.queryStringParameters ?? {},
        identity,
        header: (name) => getHeader(event, name),
        get body() {
          if (parsedBody === undefined) parsedBody = parseJsonBody(event);
          return parsedBody;
        },
      };
      response = await route.handler(req);
    } catch (err) {
      response = errorResponse(err, requestId);
    }
    logger.info('request', {
      requestId,
      route: routeKey,
      status: response?.statusCode,
      durationMs: Date.now() - started,
    });
    return response;
  };
}
