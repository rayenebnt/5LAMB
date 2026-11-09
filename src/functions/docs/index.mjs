// API documentation and health check:
//   GET /docs          interactive documentation (Swagger UI loaded from a CDN)
//   GET /openapi.json  OpenAPI 3 document (docs/openapi.yaml converted at build time)
//   GET /health        liveness probe for external monitoring

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../../lib/config.mjs';
import { serviceUnavailable } from '../../lib/errors.mjs';
import { createApiHandler, getHeader, html, ok } from '../../lib/http.mjs';
import { logger } from '../../lib/logger.mjs';

const SWAGGER_UI_VERSION = '5.17.14';
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

let cachedSpec;

/** Loads the OpenAPI document once per execution environment. */
export function loadSpec() {
  if (!cachedSpec) {
    const path = process.env.OPENAPI_SPEC_PATH || fileURLToPath(new URL('./openapi.json', import.meta.url));
    try {
      cachedSpec = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      logger.error('OpenAPI document unavailable', { path, error: err });
      throw serviceUnavailable('The OpenAPI document is not available (run npm run build)');
    }
  }
  return cachedSpec;
}

/** Test helper: forget the cached document. */
export function resetSpecCache() {
  cachedSpec = undefined;
}

/** Base URL of the API as seen by the caller (used as the OpenAPI server). */
export function publicBaseUrl(event) {
  const host = getHeader(event, 'host');
  if (!host) return null;
  const stage = event?.requestContext?.stage;
  return `https://${host}${stage ? `/${stage}` : ''}`;
}

export function swaggerPage() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blogify API - documentation</title>
<link rel="stylesheet" href="${CDN}/swagger-ui.css">
<style>body { margin: 0; background: #fafafa; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="${CDN}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
<script>
window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: 'openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    persistAuthorization: true,
    displayRequestDuration: true,
  });
};
</script>
</body>
</html>`;
}

const CSP = [
  "default-src 'none'",
  "script-src https://cdn.jsdelivr.net 'unsafe-inline'",
  "style-src https://cdn.jsdelivr.net 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

async function getDocs() {
  return html(swaggerPage(), {
    'Content-Security-Policy': CSP,
    'Cache-Control': 'public, max-age=3600',
  });
}

async function getOpenApi(req) {
  const spec = loadSpec();
  const baseUrl = publicBaseUrl(req.event);
  const document = baseUrl ? { ...spec, servers: [{ url: baseUrl, description: 'Cette API' }] } : spec;
  return ok(document, { 'Cache-Control': 'public, max-age=300' });
}

async function getHealth() {
  return ok(
    { status: 'ok', service: 'blogify', version: config.appVersion, stage: config.stage, time: new Date().toISOString() },
    { 'Cache-Control': 'no-store' },
  );
}

export const routes = {
  'GET /docs': { auth: 'none', handler: getDocs },
  'GET /openapi.json': { auth: 'none', handler: getOpenApi },
  'GET /health': { auth: 'none', handler: getHealth },
};

export const handler = createApiHandler(routes);
