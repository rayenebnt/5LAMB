import '../helpers/env.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../src/lib/validation.mjs';
import { SLUG_RE } from '../../src/lib/text.mjs';
import { isUuid } from '../../src/lib/ids.mjs';
import {
  autoSlugCandidates,
  buildPostItem,
  canTransition,
  computePostChanges,
  createPostSchema,
  listPostsQuerySchema,
  planPostListing,
  postIdParamsSchema,
  toApiPost,
  transitionBodySchema,
  transitionChanges,
  updatePostSchema,
  WORKFLOW,
} from '../../src/domain/posts.mjs';
import { users } from '../helpers/events.mjs';

const POST_ID = '0192f5a1-7c2b-7d3e-8f40-000000000001';
const CREATED = '2026-10-01T10:00:00.000Z';
const NOW = '2026-10-27T12:00:00.000Z';

function storedPost(overrides = {}) {
  return {
    PK: `POST#${POST_ID}`,
    SK: 'POST',
    GSI1PK: 'POSTS#draft',
    GSI1SK: `${CREATED}#${POST_ID}`,
    GSI2PK: `USER#${users.author.userId}`,
    GSI2SK: `POST#${CREATED}#${POST_ID}`,
    entityType: 'POST',
    postId: POST_ID,
    slug: 'mon-article',
    title: 'Mon article',
    content: 'Un contenu **initial**.',
    excerpt: 'Un contenu initial.',
    customExcerpt: false,
    coverImageUrl: null,
    tags: ['aws'],
    status: 'draft',
    allowComments: true,
    authorId: users.author.userId,
    authorName: users.author.name,
    readingTimeMinutes: 1,
    commentCount: 2,
    reviewNote: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    submittedAt: null,
    publishedAt: null,
    version: 3,
    ...overrides,
  };
}

/** Asserts a 400 VALIDATION_ERROR mentioning `field` (or the root object). */
function assertInvalid(schema, input, field) {
  assert.throws(
    () => validate(schema, input),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'VALIDATION_ERROR');
      if (field) {
        const fields = err.details.map((detail) => detail.field);
        assert.ok(fields.includes(field), `expected an issue on "${field}", got ${JSON.stringify(err.details)}`);
      }
      return true;
    },
    JSON.stringify(input),
  );
}

describe('createPostSchema', () => {
  test('trims the title and defaults the content', () => {
    assert.deepEqual(validate(createPostSchema, { title: '  Hello  ' }), { title: 'Hello', content: '' });
  });

  test('normalises and de-duplicates tags, keeps Markdown content verbatim', () => {
    const input = validate(createPostSchema, {
      title: 'T',
      content: '    indented code\n',
      excerpt: '  Résumé  ',
      tags: ['AWS', 'aws', ' Serverless Computing ', 'Café'],
      slug: 'mon-slug-2',
      coverImageUrl: 'https://cdn.example.com/cover.png',
      allowComments: false,
    });
    assert.deepEqual(input, {
      title: 'T',
      content: '    indented code\n',
      excerpt: 'Résumé',
      tags: ['aws', 'serverless-computing', 'cafe'],
      slug: 'mon-slug-2',
      coverImageUrl: 'https://cdn.example.com/cover.png',
      allowComments: false,
    });
  });

  test('accepts null for the cover image and the excerpt (automatic excerpt)', () => {
    const input = validate(createPostSchema, { title: 'T', coverImageUrl: null, excerpt: null });
    assert.equal(input.coverImageUrl, null);
    assert.equal(input.excerpt, null);
  });

  test('rejects invalid input with 400 VALIDATION_ERROR', () => {
    assertInvalid(createPostSchema, {}, 'title');
    assertInvalid(createPostSchema, { title: '   ' }, 'title');
    assertInvalid(createPostSchema, { title: 42 }, 'title');
    assertInvalid(createPostSchema, { title: 'x'.repeat(201) }, 'title');
    assertInvalid(createPostSchema, { title: 'T', content: 'x'.repeat(100_001) }, 'content');
    assertInvalid(createPostSchema, { title: 'T', excerpt: 'x'.repeat(501) }, 'excerpt');
    assertInvalid(createPostSchema, { title: 'T', tags: 'aws' }, 'tags');
    assertInvalid(createPostSchema, { title: 'T', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, 'tags');
    assertInvalid(createPostSchema, { title: 'T', tags: ['ok', '!!!'] }, 'tags.1');
    assertInvalid(createPostSchema, { title: 'T', tags: ['   '] }, 'tags.0');
    assertInvalid(createPostSchema, { title: 'T', tags: ['x'.repeat(41)] }, 'tags.0');
    assertInvalid(createPostSchema, { title: 'T', slug: 'Not A Slug' }, 'slug');
    assertInvalid(createPostSchema, { title: 'T', slug: 'double--dash' }, 'slug');
    assertInvalid(createPostSchema, { title: 'T', slug: '' }, 'slug');
    assertInvalid(createPostSchema, { title: 'T', slug: 'a'.repeat(81) }, 'slug');
    assertInvalid(createPostSchema, { title: 'T', slug: POST_ID }, 'slug');
    assertInvalid(createPostSchema, { title: 'T', coverImageUrl: 'javascript:alert(1)' }, 'coverImageUrl');
    assertInvalid(createPostSchema, { title: 'T', coverImageUrl: 'not a url' }, 'coverImageUrl');
    assertInvalid(createPostSchema, { title: 'T', allowComments: 'yes' }, 'allowComments');
  });

  test('server-managed attributes are unknown fields', () => {
    for (const field of ['status', 'authorId', 'authorName', 'version', 'commentCount', 'publishedAt', 'id']) {
      assertInvalid(createPostSchema, { title: 'T', [field]: 'x' }, '(root)');
    }
  });
});

describe('updatePostSchema', () => {
  test('requires at least one field', () => {
    assertInvalid(updatePostSchema, {}, '(root)');
  });

  test('accepts partial updates, null excerpt and null cover image', () => {
    assert.deepEqual(validate(updatePostSchema, { excerpt: null }), { excerpt: null });
    assert.deepEqual(validate(updatePostSchema, { coverImageUrl: null }), { coverImageUrl: null });
    assert.deepEqual(validate(updatePostSchema, { tags: [] }), { tags: [] });
    assert.deepEqual(validate(updatePostSchema, { title: ' New ', tags: ['A B'] }), { title: 'New', tags: ['a-b'] });
  });

  test('rejects nulls where they make no sense and unknown fields', () => {
    assertInvalid(updatePostSchema, { title: null }, 'title');
    assertInvalid(updatePostSchema, { slug: null }, 'slug');
    assertInvalid(updatePostSchema, { tags: null }, 'tags');
    assertInvalid(updatePostSchema, { allowComments: null }, 'allowComments');
    assertInvalid(updatePostSchema, { status: 'published' }, '(root)');
    assertInvalid(updatePostSchema, { title: 'ok', version: 9 }, '(root)');
  });
});

describe('listPostsQuerySchema', () => {
  test('defaults and coercion', () => {
    assert.deepEqual(validate(listPostsQuerySchema, {}), { limit: 10, status: 'published' });
    assert.deepEqual(validate(listPostsQuerySchema, { limit: '50', status: 'in_review' }), { limit: 50, status: 'in_review' });
  });

  test('normalises the tag and the author', () => {
    assert.equal(validate(listPostsQuerySchema, { tag: 'Serverless AWS' }).tag, 'serverless-aws');
    assert.equal(validate(listPostsQuerySchema, { author: 'ME' }).author, 'me');
    assert.equal(validate(listPostsQuerySchema, { author: users.author.userId.toUpperCase() }).author, users.author.userId);
  });

  test('rejects invalid parameters', () => {
    assertInvalid(listPostsQuerySchema, { limit: '0' }, 'limit');
    assertInvalid(listPostsQuerySchema, { limit: '51' }, 'limit');
    assertInvalid(listPostsQuerySchema, { limit: 'abc' }, 'limit');
    assertInvalid(listPostsQuerySchema, { limit: '2.5' }, 'limit');
    assertInvalid(listPostsQuerySchema, { status: 'deleted' }, 'status');
    assertInvalid(listPostsQuerySchema, { tag: '!!!' }, 'tag');
    assertInvalid(listPostsQuerySchema, { author: 'bob' }, 'author');
    assertInvalid(listPostsQuerySchema, { cursor: '' }, 'cursor');
    assertInvalid(listPostsQuerySchema, { sort: 'asc' }, '(root)');
  });
});

describe('path and workflow bodies', () => {
  test('write routes require a post id (UUID), normalised to lowercase', () => {
    assert.deepEqual(validate(postIdParamsSchema, { postId: POST_ID.toUpperCase() }), { postId: POST_ID });
    assertInvalid(postIdParamsSchema, { postId: 'mon-article' }, 'postId');
  });

  test('only reject accepts a (trimmed, optional) note', () => {
    assert.deepEqual(validate(transitionBodySchema('reject'), { note: '  À revoir  ' }), { note: 'À revoir' });
    assert.deepEqual(validate(transitionBodySchema('reject'), {}), {});
    assert.deepEqual(validate(transitionBodySchema('reject'), { note: null }), { note: null });
    assertInvalid(transitionBodySchema('reject'), { note: 'x'.repeat(1001) }, 'note');
    assertInvalid(transitionBodySchema('reject'), { note: 'ok', reason: 'x' }, '(root)');
    for (const action of ['submit', 'publish', 'unpublish', 'archive']) {
      assert.deepEqual(validate(transitionBodySchema(action), {}), {});
      assertInvalid(transitionBodySchema(action), { note: 'x' }, '(root)');
    }
  });
});

describe('toApiPost', () => {
  test('maps a stored item to the API representation without internal attributes', () => {
    const item = storedPost({ coverImageUrl: 'https://cdn.example.com/c.png' });
    assert.deepEqual(toApiPost(item, { includeContent: true }), {
      id: POST_ID,
      slug: 'mon-article',
      title: 'Mon article',
      excerpt: 'Un contenu initial.',
      content: 'Un contenu **initial**.',
      coverImageUrl: 'https://cdn.example.com/c.png',
      tags: ['aws'],
      status: 'draft',
      allowComments: true,
      author: { id: users.author.userId, name: users.author.name },
      readingTimeMinutes: 1,
      commentCount: 2,
      reviewNote: null,
      createdAt: CREATED,
      updatedAt: CREATED,
      submittedAt: null,
      publishedAt: null,
      version: 3,
    });
  });

  test('summaries (listings) never carry the content', () => {
    const summary = toApiPost(storedPost());
    assert.equal('content' in summary, false);
    for (const key of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entityType', 'customExcerpt', 'postId']) {
      assert.equal(key in summary, false, key);
    }
  });

  test('tag membership copies map to the same shape with safe defaults', () => {
    const membership = {
      PK: 'TAG#aws',
      SK: `POST#${POST_ID}`,
      entityType: 'TAG_POST',
      tag: 'aws',
      postId: POST_ID,
      slug: 's',
      title: 'T',
      status: 'published',
      authorId: 'a',
      authorName: 'A',
      createdAt: CREATED,
      updatedAt: CREATED,
      publishedAt: NOW,
      version: 2,
    };
    const post = toApiPost(membership);
    assert.equal(post.excerpt, '');
    assert.deepEqual(post.tags, []);
    assert.equal(post.coverImageUrl, null);
    assert.equal(post.allowComments, true);
    assert.equal(post.commentCount, 0);
    assert.equal(post.publishedAt, NOW);
    assert.equal('tag' in post, false);
  });
});

describe('autoSlugCandidates', () => {
  test('base slug, numbered suffixes up to -5, then random 6-hex suffixes', () => {
    let n = 0;
    const random = () => ['a1b2c3', 'd4e5f6', '0a0b0c'][n++];
    assert.deepEqual([...autoSlugCandidates('Hello World !', random)], [
      'hello-world',
      'hello-world-2',
      'hello-world-3',
      'hello-world-4',
      'hello-world-5',
      'hello-world-a1b2c3',
      'hello-world-d4e5f6',
      'hello-world-0a0b0c',
    ]);
  });

  test('default random suffixes are 6 hexadecimal characters', () => {
    const random = [...autoSlugCandidates('Hello')].slice(5);
    assert.equal(random.length, 3);
    for (const slug of random) assert.match(slug, /^hello-[0-9a-f]{6}$/);
  });

  test('falls back to "post" and folds accents', () => {
    assert.equal(autoSlugCandidates('!!! ???').next().value, 'post');
    assert.equal(autoSlugCandidates("Éléphant à l'œil").next().value, 'elephant-a-l-oeil');
  });

  test('every candidate is a valid slug of at most 80 characters', () => {
    const title = `${'mot '.repeat(19)}${'x'.repeat(30)}`;
    for (const slug of autoSlugCandidates(title)) {
      assert.ok(slug.length <= 80, slug);
      assert.match(slug, SLUG_RE);
    }
    for (const slug of autoSlugCandidates('y'.repeat(120))) {
      assert.equal(slug.length, 80);
      assert.match(slug, SLUG_RE);
    }
  });

  test('a UUID-shaped title is prefixed so that it stays resolvable as a slug', () => {
    const base = autoSlugCandidates(POST_ID).next().value;
    assert.equal(base, `post-${POST_ID}`);
    assert.equal(isUuid(base), false);
  });
});

describe('buildPostItem', () => {
  test('builds a version-1 draft with keys, index keys and derived attributes', () => {
    const input = validate(createPostSchema, { title: 'Titre', content: '# Intro\n\nTexte **gras**.', tags: ['AWS'] });
    const item = buildPostItem({ postId: POST_ID, slug: 'titre', input, author: users.author, now: NOW });
    assert.deepEqual(item, {
      PK: `POST#${POST_ID}`,
      SK: 'POST',
      GSI1PK: 'POSTS#draft',
      GSI1SK: `${NOW}#${POST_ID}`,
      GSI2PK: `USER#${users.author.userId}`,
      GSI2SK: `POST#${NOW}#${POST_ID}`,
      entityType: 'POST',
      postId: POST_ID,
      slug: 'titre',
      title: 'Titre',
      content: '# Intro\n\nTexte **gras**.',
      excerpt: 'Intro Texte gras.',
      customExcerpt: false,
      coverImageUrl: null,
      tags: ['aws'],
      status: 'draft',
      allowComments: true,
      authorId: users.author.userId,
      authorName: users.author.name,
      readingTimeMinutes: 1,
      commentCount: 0,
      reviewNote: null,
      createdAt: NOW,
      updatedAt: NOW,
      submittedAt: null,
      publishedAt: null,
      version: 1,
    });
  });

  test('a provided excerpt is custom; an empty one is automatic', () => {
    const custom = buildPostItem({ postId: POST_ID, slug: 's', input: { title: 'T', content: 'abc', excerpt: 'Mine' }, author: users.author, now: NOW });
    assert.equal(custom.excerpt, 'Mine');
    assert.equal(custom.customExcerpt, true);
    const empty = buildPostItem({ postId: POST_ID, slug: 's', input: { title: 'T', content: 'abc', excerpt: '' }, author: users.author, now: NOW });
    assert.equal(empty.excerpt, 'abc');
    assert.equal(empty.customExcerpt, false);
  });
});

describe('computePostChanges', () => {
  test('sets the provided fields and derived attributes only (never commentCount)', () => {
    const changes = computePostChanges(storedPost(), { title: 'New', content: 'Nouveau **texte**' }, NOW);
    assert.deepEqual(changes, {
      title: 'New',
      content: 'Nouveau **texte**',
      excerpt: 'Nouveau texte',
      readingTimeMinutes: 1,
      updatedAt: NOW,
      version: 4,
      GSI1SK: `${NOW}#${POST_ID}`,
    });
  });

  test('published posts keep their GSI1SK (sorted by publication date)', () => {
    const changes = computePostChanges(storedPost({ status: 'published', publishedAt: CREATED }), { title: 'New' }, NOW);
    assert.equal('GSI1SK' in changes, false);
    assert.equal('GSI1PK' in changes, false);
  });

  test('custom excerpt, back to automatic, and content changes under a custom excerpt', () => {
    assert.deepEqual(
      pick(computePostChanges(storedPost(), { excerpt: 'Mon résumé' }, NOW), 'excerpt', 'customExcerpt'),
      { excerpt: 'Mon résumé', customExcerpt: true },
    );
    const custom = storedPost({ excerpt: 'Mon résumé', customExcerpt: true });
    assert.deepEqual(pick(computePostChanges(custom, { excerpt: null }, NOW), 'excerpt', 'customExcerpt'), {
      excerpt: 'Un contenu initial.',
      customExcerpt: false,
    });
    assert.deepEqual(pick(computePostChanges(custom, { excerpt: '' }, NOW), 'excerpt', 'customExcerpt'), {
      excerpt: 'Un contenu initial.',
      customExcerpt: false,
    });
    const contentOnly = computePostChanges(custom, { content: 'Autre chose' }, NOW);
    assert.equal('excerpt' in contentOnly, false);
    assert.equal('customExcerpt' in contentOnly, false);
  });

  test('reading time follows the content', () => {
    const changes = computePostChanges(storedPost(), { content: 'mot '.repeat(401) }, NOW);
    assert.equal(changes.readingTimeMinutes, 3);
  });

  test('the slug is only part of the changes when it differs', () => {
    assert.equal('slug' in computePostChanges(storedPost(), { slug: 'mon-article' }, NOW), false);
    assert.equal(computePostChanges(storedPost(), { slug: 'autre' }, NOW).slug, 'autre');
  });

  test('cover image can be cleared, comments disabled, tags replaced', () => {
    const changes = computePostChanges(storedPost(), { coverImageUrl: null, allowComments: false, tags: [] }, NOW);
    assert.equal(changes.coverImageUrl, null);
    assert.equal(changes.allowComments, false);
    assert.deepEqual(changes.tags, []);
  });
});

function pick(object, ...names) {
  return Object.fromEntries(names.filter((name) => name in object).map((name) => [name, object[name]]));
}

describe('workflow', () => {
  test('transition table', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(WORKFLOW).map(([action, rule]) => [action, [rule.from, rule.to]])),
      {
        submit: [['draft'], 'in_review'],
        publish: [['draft', 'in_review', 'archived'], 'published'],
        unpublish: [['published'], 'draft'],
        reject: [['in_review'], 'draft'],
        archive: [['draft', 'in_review', 'published'], 'archived'],
      },
    );
  });

  test('who may perform each action', () => {
    const post = storedPost();
    assert.equal(canTransition(users.author, post, 'submit'), true);
    assert.equal(canTransition(users.author2, post, 'submit'), false);
    assert.equal(canTransition(users.editor, post, 'submit'), true);
    assert.equal(canTransition(users.noRole, post, 'submit'), false);
    for (const action of ['publish', 'unpublish', 'reject', 'archive']) {
      assert.equal(canTransition(users.author, post, action), false, action);
      assert.equal(canTransition(users.editor, post, action), true, action);
      assert.equal(canTransition(users.admin, post, action), true, action);
      assert.equal(canTransition(users.noRole, post, action), false, action);
    }
  });

  test('submit records submittedAt and moves the post to the review queue', () => {
    assert.deepEqual(transitionChanges(storedPost(), 'submit', { now: NOW }), {
      status: 'in_review',
      updatedAt: NOW,
      version: 4,
      submittedAt: NOW,
      GSI1PK: 'POSTS#in_review',
      GSI1SK: `${NOW}#${POST_ID}`,
    });
  });

  test('first publication sets publishedAt, clears the review note and sorts by publication date', () => {
    const changes = transitionChanges(storedPost({ status: 'in_review', reviewNote: 'old' }), 'publish', { now: NOW });
    assert.deepEqual(changes, {
      status: 'published',
      updatedAt: NOW,
      version: 4,
      publishedAt: NOW,
      reviewNote: null,
      GSI1PK: 'POSTS#published',
      GSI1SK: `${NOW}#${POST_ID}`,
    });
  });

  test('re-publication keeps the first publication date', () => {
    const changes = transitionChanges(storedPost({ status: 'archived', publishedAt: CREATED }), 'publish', { now: NOW });
    assert.equal(changes.publishedAt, CREATED);
    assert.equal(changes.GSI1SK, `${CREATED}#${POST_ID}`);
  });

  test('unpublish, reject and archive sort by update date and keep publishedAt', () => {
    const unpublished = transitionChanges(storedPost({ status: 'published', publishedAt: CREATED }), 'unpublish', { now: NOW });
    assert.deepEqual(unpublished, {
      status: 'draft',
      updatedAt: NOW,
      version: 4,
      GSI1PK: 'POSTS#draft',
      GSI1SK: `${NOW}#${POST_ID}`,
    });
    const rejected = transitionChanges(storedPost({ status: 'in_review' }), 'reject', { note: 'Trop court', now: NOW });
    assert.equal(rejected.status, 'draft');
    assert.equal(rejected.reviewNote, 'Trop court');
    assert.equal(transitionChanges(storedPost({ status: 'in_review' }), 'reject', { note: '', now: NOW }).reviewNote, null);
    assert.equal(transitionChanges(storedPost({ status: 'in_review' }), 'reject', { now: NOW }).reviewNote, null);
    const archived = transitionChanges(storedPost({ status: 'published', publishedAt: CREATED }), 'archive', { now: NOW });
    assert.equal(archived.GSI1PK, 'POSTS#archived');
    assert.equal(archived.GSI1SK, `${NOW}#${POST_ID}`);
    assert.equal('publishedAt' in archived, false);
  });
});

describe('planPostListing (GET /posts matrix)', () => {
  const ownDrafts = (userId, status = 'draft') => ({
    indexName: 'GSI2',
    keyCondition: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
    names: { '#status': 'status' },
    values: { ':pk': `USER#${userId}`, ':prefix': 'POST#', ':status': status },
    filter: '#status = :status',
  });
  const assertStatus = (statusCode, fn) => assert.throws(fn, (err) => err.statusCode === statusCode);

  test('published posts are public: by status, by tag (with author filter) or by author', () => {
    assert.deepEqual(planPostListing(null, {}), {
      indexName: 'GSI1',
      keyCondition: 'GSI1PK = :pk',
      values: { ':pk': 'POSTS#published' },
    });
    assert.deepEqual(planPostListing(null, { tag: 'aws' }), {
      indexName: 'GSI1',
      keyCondition: 'GSI1PK = :pk',
      values: { ':pk': 'TAG#aws' },
      filter: undefined,
    });
    assert.deepEqual(planPostListing(null, { tag: 'aws', author: users.author.userId }), {
      indexName: 'GSI1',
      keyCondition: 'GSI1PK = :pk',
      values: { ':pk': 'TAG#aws', ':authorId': users.author.userId },
      filter: 'authorId = :authorId',
    });
    assert.deepEqual(planPostListing(null, { author: users.author.userId }), ownDrafts(users.author.userId, 'published'));
  });

  test('author=me requires authentication and resolves to the caller', () => {
    assertStatus(401, () => planPostListing(null, { author: 'me' }));
    assert.deepEqual(planPostListing(users.author2, { author: 'me' }), ownDrafts(users.author2.userId, 'published'));
    assert.equal(
      planPostListing(users.author2, { author: 'me', tag: 'aws' }).values[':authorId'],
      users.author2.userId,
    );
  });

  test('unpublished statuses require authentication', () => {
    for (const status of ['draft', 'in_review', 'archived']) {
      assertStatus(401, () => planPostListing(null, { status }));
    }
  });

  test('authors without POST_READ_ANY only list their own unpublished posts', () => {
    assert.deepEqual(planPostListing(users.author, { status: 'draft' }), ownDrafts(users.author.userId));
    assert.deepEqual(planPostListing(users.author, { status: 'draft', author: 'me' }), ownDrafts(users.author.userId));
    assert.deepEqual(
      planPostListing(users.author, { status: 'in_review', author: users.author.userId }),
      ownDrafts(users.author.userId, 'in_review'),
    );
    assertStatus(403, () => planPostListing(users.author, { status: 'draft', author: users.author2.userId }));
    assert.deepEqual(planPostListing(users.noRole, { status: 'archived' }), ownDrafts(users.noRole.userId, 'archived'));
  });

  test('editors list any status (GSI1) or any author (GSI2)', () => {
    assert.deepEqual(planPostListing(users.editor, { status: 'in_review' }), {
      indexName: 'GSI1',
      keyCondition: 'GSI1PK = :pk',
      values: { ':pk': 'POSTS#in_review' },
    });
    assert.deepEqual(
      planPostListing(users.admin, { status: 'draft', author: users.author.userId }),
      ownDrafts(users.author.userId),
    );
  });

  test('the tag filter only applies to published posts', () => {
    assertStatus(400, () => planPostListing(users.editor, { status: 'draft', tag: 'aws' }));
    assertStatus(400, () => planPostListing(users.author, { status: 'draft', tag: 'aws' }));
  });
});
