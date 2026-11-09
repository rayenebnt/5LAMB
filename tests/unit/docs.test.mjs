import '../helpers/env.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { handler, resetSpecCache, swaggerPage } from '../../src/functions/docs/index.mjs';
import { apiEvent, parse } from '../helpers/events.mjs';

const specYaml = fileURLToPath(new URL('../../docs/openapi.yaml', import.meta.url));
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'blogify-docs-'));
  const path = join(dir, 'openapi.json');
  writeFileSync(path, JSON.stringify(parseYaml(readFileSync(specYaml, 'utf8'))));
  process.env.OPENAPI_SPEC_PATH = path;
  resetSpecCache();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENAPI_SPEC_PATH;
});

test('GET /health returns the service status', async () => {
  const res = await handler(apiEvent({ resource: '/health' }));
  assert.equal(res.statusCode, 200);
  const body = parse(res);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'blogify');
  assert.equal(body.stage, 'test');
  assert.ok(!Number.isNaN(Date.parse(body.time)));
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('GET /openapi.json serves the document with the caller base URL as server', async () => {
  const event = apiEvent({ resource: '/openapi.json', headers: { Host: 'abc123.execute-api.eu-west-3.amazonaws.com' } });
  const res = await handler(event);
  assert.equal(res.statusCode, 200);
  const spec = parse(res);
  assert.match(spec.openapi, /^3\./);
  assert.ok(Object.keys(spec.paths).length >= 30);
  assert.deepEqual(spec.servers, [{ url: 'https://abc123.execute-api.eu-west-3.amazonaws.com/test', description: 'Cette API' }]);
});

test('GET /openapi.json answers 503 when the document was not built', async () => {
  process.env.OPENAPI_SPEC_PATH = join(dir, 'missing.json');
  resetSpecCache();
  const res = await handler(apiEvent({ resource: '/openapi.json' }));
  assert.equal(res.statusCode, 503);
  process.env.OPENAPI_SPEC_PATH = join(dir, 'openapi.json');
  resetSpecCache();
});

test('GET /docs serves Swagger UI pointing at the relative OpenAPI URL', async () => {
  const res = await handler(apiEvent({ resource: '/docs' }));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /^text\/html/);
  assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.ok(res.body.includes("url: 'openapi.json'"));
  assert.ok(res.body.includes('swagger-ui-dist@5.17.14/swagger-ui-bundle.js'));
  assert.equal(res.body, swaggerPage());
});

test('every $ref of the OpenAPI document resolves', () => {
  const spec = parseYaml(readFileSync(specYaml, 'utf8'));
  const refs = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value);
        else walk(value);
      }
    }
  };
  walk(spec);
  assert.ok(refs.length > 50);
  for (const ref of refs) {
    assert.ok(ref.startsWith('#/'), `external ref ${ref}`);
    const target = ref.slice(2).split('/').reduce((obj, part) => obj?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    assert.ok(target !== undefined, `unresolved ${ref}`);
  }
});
