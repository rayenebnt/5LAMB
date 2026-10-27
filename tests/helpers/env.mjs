// Default environment for unit tests (imported first by every test file).
const defaults = {
  AWS_REGION: 'eu-west-3',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  STAGE: 'test',
  TABLE_NAME: 'blogify-test',
  MEDIA_BUCKET: 'blogify-test-media',
  USER_POOL_ID: 'eu-west-3_TestPool1',
  USER_POOL_CLIENT_ID: 'test-client-id',
  TOPIC_ARN: 'arn:aws:sns:eu-west-3:123456789012:blogify-test-new-posts',
  EVENT_BUS_NAME: 'default',
  ALLOWED_ORIGIN: '*',
  PUBLIC_SITE_URL: 'https://blog.example.com',
  LOG_LEVEL: 'silent',
};

for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
