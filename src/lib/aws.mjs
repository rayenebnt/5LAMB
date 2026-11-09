// Lazily created AWS SDK v3 clients (one instance per Lambda execution environment,
// reused across invocations to benefit from connection keep-alive).

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SNSClient } from '@aws-sdk/client-sns';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { config } from './config.mjs';

// Without explicit timeouts a hung connection would only end with the Lambda timeout (and,
// for the notifier, leave its idempotency marker behind): fail fast and let the SDK retry.
const REQUEST_HANDLER = { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true };
const CLIENT_OPTIONS = { maxAttempts: 3, requestHandler: REQUEST_HANDLER };

let documentClient;
let s3Client;
let cognitoClient;
let snsClient;
let eventBridgeClient;

export function dynamo() {
  if (!documentClient) {
    const endpoint = config.dynamodbEndpoint;
    // A local endpoint (DynamoDB Local) never needs real credentials; it rejects some real ones.
    const client = new DynamoDBClient(
      endpoint
        ? { ...CLIENT_OPTIONS, endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
        : CLIENT_OPTIONS,
    );
    documentClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return documentClient;
}

export function s3() {
  if (!s3Client) s3Client = new S3Client(CLIENT_OPTIONS);
  return s3Client;
}

export function cognito() {
  if (!cognitoClient) cognitoClient = new CognitoIdentityProviderClient(CLIENT_OPTIONS);
  return cognitoClient;
}

export function sns() {
  if (!snsClient) snsClient = new SNSClient(CLIENT_OPTIONS);
  return snsClient;
}

export function eventBridge() {
  if (!eventBridgeClient) eventBridgeClient = new EventBridgeClient(CLIENT_OPTIONS);
  return eventBridgeClient;
}

/** Test helper: forget cached clients (e.g. after changing DYNAMODB_ENDPOINT). */
export function resetClients() {
  documentClient = undefined;
  s3Client = undefined;
  cognitoClient = undefined;
  snsClient = undefined;
  eventBridgeClient = undefined;
}
