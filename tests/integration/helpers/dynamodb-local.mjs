// Integration-test helpers for DynamoDB Local (docker: `npm run ddb:start`).
// - creates the table exactly as declared in template.yaml (keys, GSIs, projections, stream)
// - replays the DynamoDB Stream into the Lambda stream handlers (projector / notifier),
//   applying the same event filters as the event source mappings of template.yaml.

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
} from '@aws-sdk/client-dynamodb-streams';
import { loadTemplate } from '../../helpers/template.mjs';

export const ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';

const clientConfig = {
  endpoint: ENDPOINT,
  region: process.env.AWS_REGION || 'eu-west-3',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
};

export const rawClient = new DynamoDBClient(clientConfig);
const streamsClient = new DynamoDBStreamsClient(clientConfig);

/** True when DynamoDB Local answers on ENDPOINT. */
export async function isDynamoLocalAvailable() {
  try {
    await rawClient.send(new ListTablesCommand({ Limit: 1 }));
    return true;
  } catch {
    return false;
  }
}

/** Creates a table with the schema of BlogTable in template.yaml. */
export async function createTableFromTemplate(tableName) {
  const props = loadTemplate().Resources.BlogTable.Properties;
  await rawClient.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: props.AttributeDefinitions,
      KeySchema: props.KeySchema,
      GlobalSecondaryIndexes: props.GlobalSecondaryIndexes,
      StreamSpecification: { StreamEnabled: true, StreamViewType: props.StreamSpecification.StreamViewType },
    }),
  );
  for (let i = 0; i < 50; i += 1) {
    const { Table } = await rawClient.send(new DescribeTableCommand({ TableName: tableName }));
    if (Table.TableStatus === 'ACTIVE') return Table;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Table ${tableName} did not become ACTIVE`);
}

export async function deleteTable(tableName) {
  try {
    await rawClient.send(new DeleteTableCommand({ TableName: tableName }));
  } catch {
    // ignore
  }
}

/** Evaluates a (simplified) Lambda event filter pattern against a stream record. */
export function matchesPattern(pattern, value) {
  if (Array.isArray(pattern)) {
    return pattern.some((expected) => (typeof expected === 'object' ? false : expected === value));
  }
  if (pattern && typeof pattern === 'object') {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(pattern).every(([key, sub]) => matchesPattern(sub, value[key]));
  }
  return pattern === value;
}

/** Event source mappings (stream consumers) declared in template.yaml. */
export function streamConsumers() {
  const consumers = [];
  for (const [id, resource] of Object.entries(loadTemplate().Resources)) {
    if (resource.Type !== 'AWS::Serverless::Function') continue;
    for (const event of Object.values(resource.Properties.Events ?? {})) {
      if (event.Type !== 'DynamoDB') continue;
      const filters = (event.Properties.FilterCriteria?.Filters ?? []).map((f) => JSON.parse(f.Pattern));
      const name = resource.Properties.CodeUri.replace(/^dist\//, '').replace(/\/$/, '');
      consumers.push({ id, name, filters });
    }
  }
  return consumers;
}

/**
 * Reads the table stream and dispatches new records to the given handlers
 * ({ projector: handler, notifier: handler }), honouring template filters.
 * Call `drain()` after writes; it processes every record available so far.
 */
export class StreamReplayer {
  constructor(tableName, handlers) {
    this.tableName = tableName;
    this.handlers = handlers;
    this.iterators = new Map();
    this.consumers = streamConsumers().filter((c) => handlers[c.name]);
    this.delivered = [];
  }

  async #streamArn() {
    const { Table } = await rawClient.send(new DescribeTableCommand({ TableName: this.tableName }));
    return Table.LatestStreamArn;
  }

  async #readNewRecords() {
    const streamArn = await this.#streamArn();
    const { StreamDescription } = await streamsClient.send(new DescribeStreamCommand({ StreamArn: streamArn }));
    const records = [];
    for (const shard of StreamDescription.Shards ?? []) {
      let iterator = this.iterators.get(shard.ShardId);
      if (iterator === undefined) {
        ({ ShardIterator: iterator } = await streamsClient.send(
          new GetShardIteratorCommand({ StreamArn: streamArn, ShardId: shard.ShardId, ShardIteratorType: 'TRIM_HORIZON' }),
        ));
      }
      while (iterator) {
        const response = await streamsClient.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: 1000 }));
        records.push(...(response.Records ?? []));
        const next = response.NextShardIterator ?? null;
        if (!response.Records?.length) {
          iterator = next;
          break;
        }
        iterator = next;
      }
      this.iterators.set(shard.ShardId, iterator);
    }
    records.sort((a, b) => (BigInt(a.dynamodb.SequenceNumber) < BigInt(b.dynamodb.SequenceNumber) ? -1 : 1));
    return records.map((record) => ({
      eventID: record.eventID,
      eventName: record.eventName,
      eventVersion: '1.1',
      eventSource: 'aws:dynamodb',
      awsRegion: clientConfig.region,
      eventSourceARN: streamArn,
      dynamodb: record.dynamodb,
    }));
  }

  /** Dispatches every pending stream record; returns { [consumer]: records[] }. */
  async drain() {
    const records = await this.#readNewRecords();
    const dispatched = {};
    for (const consumer of this.consumers) {
      const matching = records.filter((record) =>
        consumer.filters.length === 0 ? true : consumer.filters.some((pattern) => matchesPattern(pattern, record)),
      );
      dispatched[consumer.name] = matching;
      if (!matching.length) continue;
      const result = await this.handlers[consumer.name]({ Records: matching });
      if (result?.batchItemFailures?.length) {
        throw new Error(`${consumer.name} reported failures: ${JSON.stringify(result.batchItemFailures)}`);
      }
    }
    this.delivered.push(dispatched);
    return dispatched;
  }
}
