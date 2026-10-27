import '../helpers/env.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFirstPublication,
  notificationAttributes,
  notificationMessage,
  notificationSubject,
  postPublishedDetail,
  postUrl,
} from '../../src/domain/notifications.mjs';
import { users } from '../helpers/events.mjs';

const POST_ID = '0192f5a1-7c2b-7d3e-8f40-000000000001';

/** Published post item (only the attributes used by notifications matter here). */
function post(overrides = {}) {
  return {
    postId: POST_ID,
    slug: 'architecture-serverless',
    title: 'Architecture serverless : Lambda & DynamoDB',
    excerpt: 'Lambda, API Gateway et DynamoDB au service d’un blog headless.',
    tags: ['aws', 'serverless'],
    status: 'published',
    authorId: users.author.userId,
    authorName: users.author.name,
    readingTimeMinutes: 3,
    publishedAt: '2026-10-27T10:00:00.000Z',
    ...overrides,
  };
}

/** Sets an environment variable for the duration of a test. */
function withEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const lines = (message) => message.split('\n');

describe('first publication detection', () => {
  test('only a change that makes a post published for the first time is announced', () => {
    const at = (status) => (status ? { status } : null);
    const cases = [
      // [new status, old status, expected]
      ['published', null, true], // INSERT of a published post
      ['published', 'draft', true],
      ['published', 'in_review', true],
      ['published', 'archived', true], // re-publications are filtered by the idempotency marker
      ['published', 'published', false], // edit, new comment count...
      ['draft', 'published', false], // unpublish
      ['archived', 'published', false],
      ['in_review', 'draft', false],
      [null, 'published', false], // REMOVE
    ];
    for (const [now, before, expected] of cases) {
      assert.equal(isFirstPublication(at(now), at(before)), expected, `${before} -> ${now}`);
    }
  });
});

describe('post URL', () => {
  test('is built from PUBLIC_SITE_URL and the encoded slug', () => {
    assert.equal(postUrl('architecture-serverless'), 'https://blog.example.com/posts/architecture-serverless');
    assert.equal(postUrl('a b/c'), 'https://blog.example.com/posts/a%20b%2Fc');
    assert.equal(postUrl(undefined), null);
  });

  test('ignores trailing slashes of PUBLIC_SITE_URL', (t) => {
    withEnv(t, 'PUBLIC_SITE_URL', 'https://www.example.org/blog//');
    assert.equal(postUrl('mon-article'), 'https://www.example.org/blog/posts/mon-article');
  });

  test('is null when PUBLIC_SITE_URL is not configured', (t) => {
    withEnv(t, 'PUBLIC_SITE_URL', '');
    assert.equal(postUrl('mon-article'), null);
  });
});

describe('e-mail subject', () => {
  test('is printable ASCII as required by Amazon SNS', () => {
    assert.equal(notificationSubject(post()), 'Nouvel article : Architecture serverless : Lambda & DynamoDB');
    assert.equal(
      notificationSubject(post({ title: 'Été : «Lambda» — déjà là… 🚀' })),
      'Nouvel article : Ete : "Lambda" - deja la...',
    );
  });

  test('is shortened under 100 characters and stays on one line', () => {
    const long = notificationSubject(post({ title: 'Éléphant '.repeat(30) }));
    assert.ok(long.length <= 99, `${long.length} characters`);
    assert.match(long, /^Nouvel article : Elephant Elephant .*\.\.\.$/);
    assert.match(long, /^[\x20-\x7e]+$/);

    assert.equal(notificationSubject(post({ title: 'Ligne 1\r\nLigne\t2' })), 'Nouvel article : Ligne 1 Ligne 2');
    assert.equal(notificationSubject(post({ title: '🚀' })), 'Nouvel article :');
  });
});

describe('e-mail message', () => {
  test('is a plain-text French message with the title, author, reading time, tags, excerpt and link', () => {
    assert.equal(
      notificationMessage(post()),
      [
        'Bonjour,',
        '',
        "Un nouvel article vient d'être publié sur Blogify :",
        '',
        '« Architecture serverless : Lambda & DynamoDB »',
        'Auteur : Gaby Guest',
        'Temps de lecture : environ 3 minutes',
        'Tags : aws, serverless',
        '',
        'Lambda, API Gateway et DynamoDB au service d’un blog headless.',
        '',
        "Lire l'article : https://blog.example.com/posts/architecture-serverless",
        '',
        'Bonne lecture !',
        "L'équipe Blogify",
        '',
        '--',
        'Vous recevez cet e-mail car vous êtes abonné(e) aux nouveaux articles de Blogify.',
        'Pour vous désabonner, utilisez le lien figurant en bas de ce message.',
      ].join('\n'),
    );
  });

  test('uses the singular for a one-minute read', () => {
    assert.ok(lines(notificationMessage(post({ readingTimeMinutes: 1 }))).includes('Temps de lecture : environ 1 minute'));
  });

  test('leaves out the details a post does not have', (t) => {
    withEnv(t, 'PUBLIC_SITE_URL', '');
    const message = notificationMessage(
      post({ authorName: undefined, readingTimeMinutes: undefined, tags: [], excerpt: '' }),
    );
    assert.equal(
      message,
      [
        'Bonjour,',
        '',
        "Un nouvel article vient d'être publié sur Blogify :",
        '',
        '« Architecture serverless : Lambda & DynamoDB »',
        '',
        'Bonne lecture !',
        "L'équipe Blogify",
        '',
        '--',
        'Vous recevez cet e-mail car vous êtes abonné(e) aux nouveaux articles de Blogify.',
        'Pour vous désabonner, utilisez le lien figurant en bas de ce message.',
      ].join('\n'),
    );
  });

  test('keeps user-provided text on one line (no forged lines or control characters)', () => {
    const message = notificationMessage(
      post({
        title: "Titre\r\n\r\nLire l'article : https://evil.example",
        authorName: 'Eve\nTemps de lecture : 0',
        excerpt: 'Premier paragraphe.\n\nSecond\u0007 paragraphe.',
      }),
    );
    const messageLines = lines(message);
    assert.ok(messageLines.includes("« Titre Lire l'article : https://evil.example »"));
    assert.ok(messageLines.includes('Auteur : Eve Temps de lecture : 0'));
    assert.ok(messageLines.includes('Premier paragraphe. Second paragraphe.'));
    assert.equal(messageLines.filter((line) => line.startsWith("Lire l'article")).length, 1);
    assert.ok(!messageLines.some((line) => line.startsWith('Temps de lecture : 0')));
    assert.doesNotMatch(message, /[\u0000-\u0009\u000b-\u001f]/);
  });
});

describe('SNS message attributes', () => {
  test('carry the post tags as a String.Array for subscription filter policies', () => {
    const attributes = notificationAttributes(post());
    assert.deepEqual(attributes, { tags: { DataType: 'String.Array', StringValue: '["aws","serverless"]' } });
    assert.deepEqual(JSON.parse(attributes.tags.StringValue), ['aws', 'serverless']);
  });

  test('normalise tags, including string sets read from DynamoDB', () => {
    const attributes = notificationAttributes(post({ tags: new Set(['AWS', 'Serverless Computing', 'aws']) }));
    assert.equal(attributes.tags.StringValue, '["aws","serverless-computing"]');
  });

  test('are omitted when the post has no tag', () => {
    assert.equal(notificationAttributes(post({ tags: [] })), undefined);
    assert.equal(notificationAttributes(post({ tags: undefined })), undefined);
    assert.equal(notificationAttributes(post({ tags: ['', '!!!'] })), undefined);
  });
});

describe('PostPublished event detail', () => {
  test('describes the post for integrations', () => {
    assert.deepEqual(postPublishedDetail(post({ content: 'never sent', commentCount: 4 })), {
      postId: POST_ID,
      slug: 'architecture-serverless',
      title: 'Architecture serverless : Lambda & DynamoDB',
      excerpt: 'Lambda, API Gateway et DynamoDB au service d’un blog headless.',
      tags: ['aws', 'serverless'],
      authorId: users.author.userId,
      authorName: 'Gaby Guest',
      publishedAt: '2026-10-27T10:00:00.000Z',
      url: 'https://blog.example.com/posts/architecture-serverless',
    });
  });

  test('has a stable shape when attributes are missing', (t) => {
    withEnv(t, 'PUBLIC_SITE_URL', '');
    assert.deepEqual(postPublishedDetail({ postId: POST_ID, status: 'published' }), {
      postId: POST_ID,
      slug: null,
      title: null,
      excerpt: null,
      tags: [],
      authorId: null,
      authorName: null,
      publishedAt: null,
      url: null,
    });
  });
});
