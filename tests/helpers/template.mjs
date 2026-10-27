// Loads template.yaml (CloudFormation short-form intrinsic tags supported) for consistency tests.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const TEMPLATE_PATH = fileURLToPath(new URL('../../template.yaml', import.meta.url));

const INTRINSICS = {
  '!Ref': 'Ref',
  '!Condition': 'Condition',
  '!Sub': 'Fn::Sub',
  '!GetAtt': 'Fn::GetAtt',
  '!If': 'Fn::If',
  '!Not': 'Fn::Not',
  '!Equals': 'Fn::Equals',
  '!And': 'Fn::And',
  '!Or': 'Fn::Or',
  '!Join': 'Fn::Join',
  '!Select': 'Fn::Select',
  '!Split': 'Fn::Split',
  '!FindInMap': 'Fn::FindInMap',
  '!Base64': 'Fn::Base64',
  '!ImportValue': 'Fn::ImportValue',
  '!GetAZs': 'Fn::GetAZs',
  '!Cidr': 'Fn::Cidr',
};

const customTags = Object.entries(INTRINSICS).flatMap(([tag, fn]) => [
  { tag, resolve: (value) => ({ [fn]: fn === 'Fn::GetAtt' ? String(value).split('.') : value }) },
  { tag, collection: 'seq', resolve: (seq) => ({ [fn]: seq.toJSON() }) },
  { tag, collection: 'map', resolve: (map) => ({ [fn]: map.toJSON() }) },
]);

export function loadTemplate() {
  return parse(readFileSync(TEMPLATE_PATH, 'utf8'), { customTags });
}

/**
 * Every API Gateway route declared on Lambda functions:
 * [{ functionId, codeUri, method, path, routeKey, publicRoute }]
 */
export function apiRoutes(template = loadTemplate()) {
  const routes = [];
  for (const [functionId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'AWS::Serverless::Function') continue;
    for (const event of Object.values(resource.Properties.Events ?? {})) {
      if (event.Type !== 'Api') continue;
      const { Path: path, Method: method, Auth: auth } = event.Properties;
      routes.push({
        functionId,
        codeUri: resource.Properties.CodeUri,
        method: method.toUpperCase(),
        path,
        routeKey: `${method.toUpperCase()} ${path}`,
        publicRoute: auth?.Authorizer === 'NONE',
      });
    }
  }
  return routes;
}
