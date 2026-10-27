// Centralised access to environment variables.
// Getters read process.env lazily so tests can change values at runtime.

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

export const config = {
  get stage() {
    return str('STAGE', 'dev');
  },
  get tableName() {
    return str('TABLE_NAME', 'blogify-local');
  },
  /** Optional endpoint override (DynamoDB Local) - never set in AWS. */
  get dynamodbEndpoint() {
    return str('DYNAMODB_ENDPOINT');
  },
  get mediaBucket() {
    return str('MEDIA_BUCKET');
  },
  /** CloudFront domain serving the media bucket (empty = presigned GET URLs). */
  get mediaCdnDomain() {
    return str('MEDIA_CDN_DOMAIN');
  },
  get userPoolId() {
    return str('USER_POOL_ID');
  },
  get userPoolClientId() {
    return str('USER_POOL_CLIENT_ID');
  },
  get topicArn() {
    return str('TOPIC_ARN');
  },
  get eventBusName() {
    return str('EVENT_BUS_NAME', 'default');
  },
  get allowedOrigin() {
    return str('ALLOWED_ORIGIN', '*');
  },
  /** Demo mode: confirm new accounts without the e-mail verification code. */
  get autoConfirmUsers() {
    return bool('AUTO_CONFIRM_USERS', false);
  },
  get maxImageBytes() {
    return int('MAX_IMAGE_MB', 10) * 1024 * 1024;
  },
  get maxVideoBytes() {
    return int('MAX_VIDEO_MB', 200) * 1024 * 1024;
  },
  get uploadUrlTtlSeconds() {
    return int('UPLOAD_URL_TTL_SECONDS', 900);
  },
  get downloadUrlTtlSeconds() {
    return int('DOWNLOAD_URL_TTL_SECONDS', 3600);
  },
  /** Public front-end URL used to build links in notification e-mails. */
  get publicSiteUrl() {
    return str('PUBLIC_SITE_URL').replace(/\/+$/, '');
  },
  get logLevel() {
    return str('LOG_LEVEL', 'info').toLowerCase();
  },
  get appVersion() {
    return str('APP_VERSION', '1.0.0');
  },
};
