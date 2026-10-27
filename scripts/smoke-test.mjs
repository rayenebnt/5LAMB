#!/usr/bin/env node
// End-to-end smoke test of a deployed Blogify stack (real AWS resources).
// It plays a complete editorial scenario through the public REST API:
// registration, login, post CRUD + optimistic locking, media upload (presigned POST),
// review workflow, asynchronous projections (tags, search), comments and moderation.
//
// Requires AWS credentials able to read the stack outputs and administer the user pool
// (an editor account is created directly in Cognito, test users are deleted at the end).
//
// Usage: node scripts/smoke-test.mjs [--stack blogify-dev] [--region eu-west-3] [--api-url URL] [--keep]

import {
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { color, parseArgs, stackOutputs } from './lib/cli.mjs';

const args = parseArgs();
const region = args.region;
const outputs = await stackOutputs(args.stack ?? 'blogify-dev', region);
const API = String(args['api-url'] ?? outputs.ApiUrl).replace(/\/+$/, '');
const userPoolId = outputs.UserPoolId;
const cognito = new CognitoIdentityProviderClient(region ? { region } : {});

const run = Date.now().toString(36);
const password = `Smoke-${run}-Aa1`;
const tag = `smoke-${run}`;
const createdUsers = [];
const results = [];

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function api(method, path, { token, body, headers = {}, expect } = {}) {
  const response = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (expect !== undefined && ![expect].flat().includes(response.status)) {
    throw new Error(`${method} ${path} -> ${response.status} (expected ${expect}): ${text.slice(0, 300)}`);
  }
  return { status: response.status, data, headers: response.headers };
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    results.push({ name, ok: true });
    console.log(`${color.green('✔')} ${name} ${color.dim(`(${Date.now() - started} ms)`)}`);
    return value;
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`${color.red('✘')} ${name} - ${err.message}`);
    throw err;
  }
}

/** Polls `fn` until it returns a truthy value (eventually consistent projections). */
async function eventually(fn, { timeoutMs = 30000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError ?? new Error(`condition not met within ${timeoutMs} ms`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createUserWithRole(role) {
  const email = `smoke-${role}-${run}@example.com`;
  const { User } = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: `Smoke ${role}` },
      ],
    }),
  );
  createdUsers.push(User.Username);
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: User.Username, Password: password, Permanent: true }),
  );
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: User.Username, GroupName: role }));
  return email;
}

console.log(color.bold(`Blogify smoke test - ${API} (run ${run})\n`));
const state = {};

try {
  await step('GET /health', async () => {
    const { data } = await api('GET', '/health', { expect: 200 });
    assert(data.status === 'ok', 'health status should be ok');
  });

  await step('GET /openapi.json', async () => {
    const { data } = await api('GET', '/openapi.json', { expect: 200 });
    assert(data.openapi && Object.keys(data.paths).length > 20, 'OpenAPI document expected');
  });

  await step('POST /auth/register (guest author)', async () => {
    state.authorEmail = `smoke-author-${run}@example.com`;
    const { data } = await api('POST', '/auth/register', {
      body: { email: state.authorEmail, password, name: 'Smoke Author' },
      expect: 201,
    });
    createdUsers.push(data.userId);
    assert(data.role === 'guest-author', 'new users must be guest authors');
    if (!data.confirmed) {
      await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: state.authorEmail }));
    }
  });

  state.authorToken = await step('POST /auth/login (author)', async () => {
    const { data } = await api('POST', '/auth/login', { body: { email: state.authorEmail, password }, expect: 200 });
    assert(data.idToken && data.refreshToken, 'tokens expected');
    return data.idToken;
  });

  await step('GET /me (author)', async () => {
    const { data } = await api('GET', '/me', { token: state.authorToken, expect: 200 });
    assert(data.role === 'guest-author', `unexpected role ${data.role}`);
  });

  await step('POST /posts without token is rejected (401)', async () => {
    await api('POST', '/posts', { body: { title: 'x' }, expect: 401 });
  });

  state.post = await step('POST /posts (draft)', async () => {
    const { data, headers } = await api('POST', '/posts', {
      token: state.authorToken,
      body: {
        title: `Smoke ${run} : architecture serverless`,
        content: `# Bonjour\n\nArticle de test ${run} sur **AWS Lambda** et DynamoDB.`,
        tags: [tag, 'serverless'],
      },
      expect: 201,
    });
    assert(data.status === 'draft' && headers.get('etag'), 'draft with ETag expected');
    return data;
  });

  await step('GET /posts/{id} anonymous on a draft (404)', async () => {
    await api('GET', `/posts/${state.post.id}`, { expect: 404 });
  });

  await step('PATCH /posts/{id} with If-Match', async () => {
    const { data } = await api('PATCH', `/posts/${state.post.id}`, {
      token: state.authorToken,
      headers: { 'If-Match': `"v${state.post.version}"` },
      body: { excerpt: 'Un article de démonstration Blogify.' },
      expect: 200,
    });
    assert(data.version === state.post.version + 1, 'version must increase');
    state.post = data;
  });

  await step('PATCH /posts/{id} with a stale If-Match (412)', async () => {
    await api('PATCH', `/posts/${state.post.id}`, {
      token: state.authorToken,
      headers: { 'If-Match': '"v1"' },
      body: { title: 'Conflicting update' },
      expect: 412,
    });
  });

  await step('POST /media + presigned upload + processing', async () => {
    const { data: media } = await api('POST', '/media', {
      token: state.authorToken,
      body: { filename: 'pixel.png', contentType: 'image/png', size: PNG_1x1.length, altText: 'Pixel' },
      expect: 201,
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(media.upload.fields)) form.append(key, value);
    form.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'pixel.png');
    const upload = await fetch(media.upload.url, { method: 'POST', body: form });
    assert(upload.status === 204 || upload.status === 201, `S3 upload failed with ${upload.status}`);
    state.media = await eventually(async () => {
      const { data } = await api('GET', `/media/${media.id}`, { token: state.authorToken, expect: 200 });
      return data.status === 'ready' ? data : null;
    });
    assert(state.media.url, 'ready media must expose a URL');
  });

  await step('POST /posts/{id}/publish by a guest author (403)', async () => {
    await api('POST', `/posts/${state.post.id}/publish`, { token: state.authorToken, expect: 403 });
  });

  await step('POST /posts/{id}/submit (in_review)', async () => {
    const { data } = await api('POST', `/posts/${state.post.id}/submit`, { token: state.authorToken, expect: 200 });
    assert(data.status === 'in_review', 'post should be in review');
  });

  state.editorToken = await step('Editor account (Cognito) + POST /auth/login', async () => {
    const email = await createUserWithRole('editor');
    const { data } = await api('POST', '/auth/login', { body: { email, password }, expect: 200 });
    return data.idToken;
  });

  await step('GET /posts?status=in_review (editor review queue)', async () => {
    const { data } = await api('GET', '/posts?status=in_review&limit=50', { token: state.editorToken, expect: 200 });
    assert(data.items.some((p) => p.id === state.post.id), 'post should be in the review queue');
  });

  await step('POST /posts/{id}/publish (editor)', async () => {
    const { data } = await api('POST', `/posts/${state.post.id}/publish`, { token: state.editorToken, expect: 200 });
    assert(data.status === 'published' && data.publishedAt, 'post should be published');
    state.post = data;
  });

  await step('GET /posts/{slug} anonymous', async () => {
    const { data } = await api('GET', `/posts/${state.post.slug}`, { expect: 200 });
    assert(data.id === state.post.id && data.content, 'full post expected');
  });

  await step('GET /posts?tag= (asynchronous tag projection)', async () => {
    await eventually(async () => {
      const { data } = await api('GET', `/posts?tag=${tag}`, { expect: 200 });
      return data.items.some((p) => p.id === state.post.id);
    });
  });

  await step('GET /search?q= (asynchronous search index)', async () => {
    await eventually(async () => {
      const { data } = await api('GET', `/search?q=${run}`, { expect: 200 });
      return data.items.some((p) => p.id === state.post.id);
    });
  });

  await step('GET /tags', async () => {
    const { data } = await api('GET', '/tags', { expect: 200 });
    assert(data.items.some((t) => t.tag === tag && t.postCount >= 1), 'tag should be counted');
  });

  state.comment = await step('POST /posts/{id}/comments anonymous (pending)', async () => {
    const { data } = await api('POST', `/posts/${state.post.id}/comments`, {
      body: { body: 'Super article !', authorName: 'Lecteur anonyme' },
      expect: 201,
    });
    assert(data.status === 'pending', 'anonymous comments need moderation');
    return data;
  });

  await step('GET /comments?status=pending (moderation queue)', async () => {
    const { data } = await api('GET', '/comments?status=pending&limit=100', { token: state.editorToken, expect: 200 });
    assert(data.items.some((c) => c.id === state.comment.id), 'comment should be in the queue');
  });

  await step('PATCH comment -> approved', async () => {
    const { data } = await api('PATCH', `/posts/${state.post.id}/comments/${state.comment.id}`, {
      token: state.editorToken,
      body: { status: 'approved' },
      expect: 200,
    });
    assert(data.status === 'approved', 'comment should be approved');
  });

  await step('GET /posts/{id}/comments anonymous', async () => {
    const { data } = await api('GET', `/posts/${state.post.id}/comments`, { expect: 200 });
    assert(data.items.some((c) => c.id === state.comment.id), 'approved comment should be public');
    assert(!JSON.stringify(data).includes('@example.com'), 'e-mails must never be public');
  });
} catch {
  // the failing step has already been reported
} finally {
  if (!args.keep) {
    console.log(color.dim('\nCleaning up...'));
    const token = state.editorToken ?? state.authorToken;
    if (state.media && token) await api('DELETE', `/media/${state.media.id}`, { token }).catch(() => {});
    if (state.post && token) await api('DELETE', `/posts/${state.post.id}`, { token }).catch(() => {});
    for (const username of createdUsers) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username })).catch(() => {});
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${color.bold('Result:')} ${color.green(`${results.length - failed} passed`)}, ${failed ? color.red(`${failed} failed`) : '0 failed'}`,
  );
  process.exitCode = failed ? 1 : 0;
}
