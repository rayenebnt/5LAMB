#!/usr/bin/env node
// Creates the Blogify table in DynamoDB Local (same schema as template.yaml).
// Usage: npm run ddb:start && node scripts/create-local-table.mjs [tableName]
import { createTableFromTemplate, isDynamoLocalAvailable, ENDPOINT } from '../tests/integration/helpers/dynamodb-local.mjs';

const tableName = process.argv[2] ?? 'blogify-local';
if (!(await isDynamoLocalAvailable())) {
  console.error(`DynamoDB Local is not reachable on ${ENDPOINT} (run: npm run ddb:start)`);
  process.exit(1);
}
try {
  await createTableFromTemplate(tableName);
  console.log(`Table ${tableName} created on ${ENDPOINT}`);
} catch (err) {
  if (err.name === 'ResourceInUseException') console.log(`Table ${tableName} already exists on ${ENDPOINT}`);
  else throw err;
}
