#!/usr/bin/env node
// Guided live demo of a deployed Blogify stack, for the oral presentation.
// Each step explains what it shows, sends one real request and prints the response; press
// Enter to go on (or use --auto). Demo accounts are created on the fly and, unless --keep is
// given, deleted at the end together with the demo post and media.
//
// Usage: node scripts/demo.mjs [--stack blogify-dev] [--region eu-west-3] [--auto] [--keep]

import { createInterface } from 'node:readline/promises';
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
const API = String(outputs.ApiUrl).replace(/\/+$/, '');
const userPoolId = outputs.UserPoolId;
const cognito = new CognitoIdentityProviderClient(region ? { region } : {});
const prompt = args.auto ? null : createInterface({ input: process.stdin, output: process.stdout });

const run = Date.now().toString(36);
const password = `Demo-${run}-Aa1`;
const tag = `demo-${run}`;
const createdUsers = [];
const state = {};
let stepNumber = 0;

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Shortens tokens and long strings so that responses stay readable on a projector. */
function shorten(value) {
  return JSON.stringify(
    value,
    (key, v) => {
      if (typeof v !== 'string') return v;
      if (/token|session|policy|signature|credential/i.test(key) && v.length > 24) return `${v.slice(0, 20)}…`;
      return v.length > 120 ? `${v.slice(0, 117)}…` : v;
    },
    2,
  );
}

async function api(method, path, { token, body, headers = {}, quiet = false } = {}) {
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
  if (!quiet) {
    const status = response.status < 300 ? color.green(response.status) : color.yellow(response.status);
    console.log(`${color.bold(`${method} ${path}`)}${token ? color.dim('  (Authorization: Bearer …)') : ''} → ${status}`);
    for (const name of ['location', 'etag']) {
      if (response.headers.get(name)) console.log(color.dim(`${name}: ${response.headers.get(name)}`));
    }
    if (data !== undefined) console.log(color.dim(shorten(data)));
  }
  return { status: response.status, data };
}

async function step(title, explanation, fn) {
  stepNumber += 1;
  console.log(`\n${color.bold(`── Étape ${stepNumber} · ${title}`)}`);
  console.log(explanation);
  if (prompt) await prompt.question(color.dim('[Entrée pour exécuter]'));
  await fn();
}

async function eventually(fn, { timeoutMs = 30000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function createEditor() {
  const email = `demo-editeur-${run}@example.com`;
  const { User } = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: 'Élodie Éditrice' },
      ],
    }),
  );
  createdUsers.push(User.Username);
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: User.Username, Password: password, Permanent: true }),
  );
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: User.Username, GroupName: 'editor' }));
  return email;
}

console.log(color.bold('Démonstration Blogify — API headless serverless'));
console.log(`API : ${API}`);
console.log(`Documentation interactive : ${API}/docs`);

try {
  await step('Santé de l’API', 'Point de supervision public, servi par une fonction Lambda.', async () => {
    await api('GET', '/health');
  });

  await step(
    'Inscription d’un auteur invité',
    'Cognito crée le compte ; la plateforme lui attribue le rôle le plus faible : guest-author.',
    async () => {
      state.authorEmail = `demo-auteur-${run}@example.com`;
      const { status, data } = await api('POST', '/auth/register', {
        body: { email: state.authorEmail, password, name: 'Alex Auteur' },
      });
      if (status !== 201) throw new Error('inscription impossible');
      createdUsers.push(data.userId);
      if (!data.confirmed) {
        await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: state.authorEmail }));
      }
    },
  );

  await step('Connexion', 'Cognito renvoie un jeton d’identité JWT (60 min) et un refresh token.', async () => {
    const { data } = await api('POST', '/auth/login', { body: { email: state.authorEmail, password } });
    if (!data?.idToken) throw new Error('connexion impossible');
    state.authorToken = data.idToken;
  });

  await step('Profil et permissions', 'Le jeton porte le rôle ; GET /me liste les permissions associées.', async () => {
    await api('GET', '/me', { token: state.authorToken });
  });

  await step(
    'Sécurité à la périphérie',
    'Sans jeton, API Gateway refuse la requête avant même d’invoquer la logique métier.',
    async () => {
      await api('POST', '/posts', { body: { title: 'Sans jeton' } });
    },
  );

  await step(
    'Création d’un brouillon (CRUD : Create)',
    'Slug, extrait et temps de lecture sont calculés ; réponse 201 avec Location et ETag.',
    async () => {
      const { data } = await api('POST', '/posts', {
        token: state.authorToken,
        body: {
          title: `Démo ${run} : architecture serverless sur AWS`,
          content: `# Introduction\n\nBlogify stocke ce **Markdown** dans DynamoDB (démo ${run}).`,
          tags: [tag, 'serverless'],
        },
      });
      if (!data?.id) throw new Error('création de l’article impossible');
      state.post = data;
    },
  );

  await step('Un brouillon reste privé', 'Un lecteur anonyme reçoit 404 : le brouillon n’est même pas révélé.', async () => {
    await api('GET', `/posts/${state.post.id}`);
  });

  await step(
    'Téléversement d’une image (S3)',
    'L’API renvoie un POST présigné ; le fichier part directement vers S3, puis une Lambda le valide.',
    async () => {
      const { data: media } = await api('POST', '/media', {
        token: state.authorToken,
        body: { filename: 'schema.png', contentType: 'image/png', size: PNG_1x1.length, altText: 'Schéma' },
      });
      const form = new FormData();
      for (const [key, value] of Object.entries(media.upload.fields)) form.append(key, value);
      form.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'schema.png');
      const upload = await fetch(media.upload.url, { method: 'POST', body: form });
      console.log(`${color.bold('POST <bucket S3>')} (multipart, sans passer par l’API) → ${upload.status}`);
      state.media = await eventually(async () => {
        const { data } = await api('GET', `/media/${media.id}`, { token: state.authorToken, quiet: true });
        return data?.status === 'ready' ? data : null;
      });
      await api('GET', `/media/${media.id}`, { token: state.authorToken });
    },
  );

  await step(
    'Modification avec verrouillage optimiste (CRUD : Update)',
    'If-Match transmet la version lue ; une version périmée donne 412 au lieu d’écraser une autre modification.',
    async () => {
      const { data } = await api('PATCH', `/posts/${state.post.id}`, {
        token: state.authorToken,
        headers: { 'If-Match': `"v${state.post.version}"` },
        // A permanent CloudFront URL makes a good cover; a temporary presigned S3 URL does not.
        body: {
          excerpt: 'Un article de démonstration.',
          ...(state.media?.url && !state.media.urlExpiresAt ? { coverImageUrl: state.media.url } : {}),
        },
      });
      if (data?.id) state.post = data;
      await api('PATCH', `/posts/${state.post.id}`, {
        token: state.authorToken,
        headers: { 'If-Match': '"v1"' },
        body: { title: 'Modification concurrente' },
      });
    },
  );

  await step('Un auteur invité ne peut pas publier', 'Contrôle RBAC dans la fonction : 403.', async () => {
    await api('POST', `/posts/${state.post.id}/publish`, { token: state.authorToken });
  });

  await step('Soumission à relecture', 'Workflow éditorial : draft → in_review.', async () => {
    await api('POST', `/posts/${state.post.id}/submit`, { token: state.authorToken });
  });

  await step('L’éditeur relit et publie', 'File de relecture puis publication : in_review → published.', async () => {
    const email = await createEditor();
    const { data } = await api('POST', '/auth/login', { body: { email, password }, quiet: true });
    if (!data?.idToken) throw new Error('connexion de l’éditeur impossible');
    state.editorToken = data.idToken;
    await api('GET', '/posts?status=in_review&limit=5', { token: state.editorToken });
    await api('POST', `/posts/${state.post.id}/publish`, { token: state.editorToken });
  });

  await step('Lecture publique (CRUD : Read)', 'Liste paginée puis lecture par slug, sans authentification.', async () => {
    await api('GET', '/posts?limit=3');
    await api('GET', `/posts/${state.post.slug}`);
  });

  await step(
    'Traitements asynchrones : tags et recherche',
    'DynamoDB Streams déclenche le Projector, qui indexe l’article en moins d’une seconde.',
    async () => {
      await eventually(async () => {
        const { data } = await api('GET', `/search?q=${run}`, { quiet: true });
        return data?.items?.some((p) => p.id === state.post.id);
      });
      await api('GET', `/search?q=${run}`);
      await api('GET', `/posts?tag=${tag}`);
    },
  );

  await step(
    'Commentaire d’un lecteur et modération',
    'Le commentaire anonyme attend la modération ; l’éditeur l’approuve, il devient public.',
    async () => {
      const { data } = await api('POST', `/posts/${state.post.id}/comments`, {
        body: { body: 'Très clair, merci !', authorName: 'Lectrice' },
      });
      state.comment = data;
      await api('GET', '/comments?status=pending&limit=5', { token: state.editorToken });
      await api('PATCH', `/posts/${state.post.id}/comments/${state.comment.id}`, {
        token: state.editorToken,
        body: { status: 'approved' },
      });
      await api('GET', `/posts/${state.post.id}/comments`);
    },
  );

  if (args['subscribe-email']) {
    await step('Abonnement à la newsletter', 'SNS envoie un e-mail de confirmation (double opt-in).', async () => {
      await api('POST', '/subscriptions', { body: { email: args['subscribe-email'], tags: ['serverless'] } });
    });
  }

  if (args.keep) {
    await step('Fin de la démo', 'Les données de démo sont conservées (option --keep).', async () => {});
  } else {
    await step('Suppression (CRUD : Delete)', 'Le Projector supprime ensuite les commentaires et les index associés.', async () => {
      if (state.media) await api('DELETE', `/media/${state.media.id}`, { token: state.editorToken });
      await api('DELETE', `/posts/${state.post.id}`, { token: state.editorToken });
    });
  }
} catch (err) {
  console.error(color.red(`\nArrêt de la démo : ${err.message}`));
  process.exitCode = 1;
} finally {
  prompt?.close();
  if (!args.keep) {
    for (const username of createdUsers) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username })).catch(() => {});
    }
  }
  console.log(color.dim('\nFin de la démonstration.'));
}
