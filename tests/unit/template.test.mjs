// Consistency checks between template.yaml, the function routers, the shared schema
// catalogue and the OpenAPI document.
import '../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadTemplate, apiRoutes } from '../helpers/template.mjs';

const template = loadTemplate();
const routes = apiRoutes(template);
const root = fileURLToPath(new URL('../../', import.meta.url));
const functionName = (codeUri) => codeUri.replace(/^dist\//, '').replace(/\/$/, '');

test('GSI projections are ALL and respect the DynamoDB limits', () => {
  const indexes = template.Resources.BlogTable.Properties.GlobalSecondaryIndexes;
  assert.deepEqual(indexes.map((index) => index.IndexName), ['GSI1', 'GSI2']);
  let projected = 0;
  for (const index of indexes) {
    assert.equal(index.Projection.ProjectionType, 'ALL', index.IndexName);
    // CreateTable rejects INCLUDE lists longer than 20 attributes, or 100 across all indexes.
    const attributes = index.Projection.NonKeyAttributes ?? [];
    assert.ok(attributes.length <= 20, `${index.IndexName}: ${attributes.length} projected attributes`);
    projected += attributes.length;
  }
  assert.ok(projected <= 100);
});

test('every function has a source entry point', () => {
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'AWS::Serverless::Function') continue;
    const entry = `${root}src/functions/${functionName(resource.Properties.CodeUri)}/index.mjs`;
    assert.ok(existsSync(entry), `${id}: missing ${entry}`);
  }
});

test('function routers match the API events of template.yaml (route keys and auth modes)', async () => {
  const byFunction = new Map();
  for (const route of routes) {
    const name = functionName(route.codeUri);
    if (!byFunction.has(name)) byFunction.set(name, []);
    byFunction.get(name).push(route);
  }
  for (const [name, templateRoutes] of byFunction) {
    const mod = await import(`../../src/functions/${name}/index.mjs`);
    assert.ok(mod.routes, `${name} must export its routes`);
    assert.deepEqual(Object.keys(mod.routes).sort(), templateRoutes.map((r) => r.routeKey).sort(), name);
    for (const route of templateRoutes) {
      const { auth } = mod.routes[route.routeKey];
      if (route.publicRoute) {
        assert.ok(['none', 'optional'].includes(auth), `${route.routeKey} is public in template but auth=${auth}`);
      } else {
        assert.equal(auth, 'required', `${route.routeKey} is protected by the authorizer`);
      }
    }
  }
});

test('OpenAPI document describes exactly the deployed routes', () => {
  const spec = parse(readFileSync(`${root}docs/openapi.yaml`, 'utf8'));
  const documented = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (item[method]) documented.push({ key: `${method.toUpperCase()} ${path}`, operation: item[method] });
    }
  }
  assert.deepEqual(documented.map((d) => d.key).sort(), routes.map((r) => r.routeKey).sort());
  for (const { key, operation } of documented) {
    const route = routes.find((r) => r.routeKey === key);
    const security = operation.security ?? spec.security ?? [];
    const requiresBearer = security.length > 0 && security.every((s) => Object.keys(s).length > 0);
    if (!route.publicRoute) assert.ok(requiresBearer, `${key} must document bearer authentication`);
    else assert.ok(!requiresBearer, `${key} is public: security must be empty or optional`);
    assert.ok(operation.operationId, `${key} needs an operationId`);
    assert.ok(operation.summary, `${key} needs a summary`);
  }
});
