import '../helpers/env.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { indexKeys, keys } from '../../src/lib/db.mjs';
import { POST_SUMMARY_ATTRIBUTES } from '../../src/lib/schema.mjs';
import {
  MAX_TERMS_PER_POST,
  computeSearchTerms,
  searchTermItem,
} from '../../src/domain/search.mjs';
import {
  MEMBERSHIP_SUMMARY_ATTRIBUTES,
  diffTags,
  postTags,
  tagMembershipItem,
} from '../../src/domain/tags.mjs';
import { RELEVANT_FIELDS, hasRelevantChange, publishedPost } from '../../src/functions/projector/index.mjs';
import { users } from '../helpers/events.mjs';

const POST_ID = '0192f5a1-7c2b-7d3e-8f40-000000000001';

/** A published post item as stored by the posts functions. */
function post(overrides = {}) {
  return {
    ...keys.post(POST_ID),
    ...indexKeys.postByStatus('published', '2026-10-27T10:00:00.000Z', POST_ID),
    ...indexKeys.postByAuthor(users.author.userId, '2026-10-27T09:00:00.000Z', POST_ID),
    entityType: 'POST',
    postId: POST_ID,
    slug: 'architecture-serverless',
    title: 'Architecture serverless',
    content: 'Lambda, API Gateway et DynamoDB.',
    excerpt: 'Lambda, API Gateway et DynamoDB.',
    customExcerpt: false,
    coverImageUrl: 'https://cdn.example.com/media/cover.png',
    tags: ['aws', 'serverless'],
    status: 'published',
    allowComments: true,
    authorId: users.author.userId,
    authorName: users.author.name,
    readingTimeMinutes: 1,
    commentCount: 2,
    reviewNote: null,
    createdAt: '2026-10-27T09:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    submittedAt: '2026-10-27T09:30:00.000Z',
    publishedAt: '2026-10-27T10:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

const terms = (overrides) => computeSearchTerms({ title: '', excerpt: '', content: '', tags: [], ...overrides });

describe('computeSearchTerms', () => {
  test('weights: title +10, tags +6, excerpt +3, content +1 per occurrence; best terms first', () => {
    assert.deepEqual([...computeSearchTerms(post())], [
      ['serverless', 16], // title + tag
      ['architecture', 10],
      ['aws', 6],
      ['api', 4], // excerpt + content
      ['dynamodb', 4],
      ['gateway', 4],
      ['lambda', 4],
    ]);
  });

  test('title, tag and excerpt tokens count once; content occurrences are capped at 5', () => {
    const result = terms({
      title: 'Lambda lambda LAMBDA',
      tags: ['cache', 'cache-aside'],
      excerpt: 'queue queue queue',
      content: `${'cache '.repeat(9)} queue queue stream`,
    });
    assert.equal(result.get('lambda'), 10);
    assert.equal(result.get('cache'), 6 + 5);
    assert.equal(result.get('aside'), 6);
    assert.equal(result.get('queue'), 3 + 2);
    assert.equal(result.get('stream'), 1);
  });

  test('text is normalised: case, accents, stop words and short tokens', () => {
    const result = terms({ title: 'Café crème à Montréal : the best of AI' });
    assert.deepEqual([...result.keys()].sort(), ['ai', 'best', 'cafe', 'creme', 'montreal']);
  });

  test('content is indexed as plain text (Markdown and HTML stripped, code blocks ignored)', () => {
    const result = terms({
      content: '# Titre\n\nVoir [la doc](https://docs.example.com/secret-path) et `npm test`.\n\n```js\nhiddenCode()\n```\n<b>gras</b>',
    });
    assert.deepEqual([...result.keys()].sort(), ['doc', 'gras', 'npm', 'test', 'titre', 'voir']);
  });

  test('tags are split on hyphens; a tag yielding a single token is also indexed as a whole', () => {
    const result = terms({ tags: ['Serverless AWS', 'e-commerce', 'go', 'it'] });
    assert.deepEqual([...result], [['aws', 6], ['commerce', 6], ['e-commerce', 6], ['go', 6], ['serverless', 6]]);
  });

  test(`keeps the ${MAX_TERMS_PER_POST} best terms, title and tag terms always included`, () => {
    const words = Array.from({ length: 200 }, (_, i) => `w${String(i).padStart(3, '0')}`);
    const result = terms({ title: 'Alpha beta', tags: ['gamma'], content: `${words.join(' ')} ${'hot '.repeat(4)}` });
    assert.equal(result.size, MAX_TERMS_PER_POST);
    for (const term of ['alpha', 'beta', 'gamma', 'hot', 'w000', 'w145']) assert.ok(result.has(term), term);
    assert.equal(result.has('w146'), false, 'ties are broken alphabetically');
    assert.deepEqual([...result.keys()].slice(0, 4), ['alpha', 'beta', 'gamma', 'hot']);
  });

  test('title and tag terms are kept even beyond the limit', () => {
    const titleWords = Array.from({ length: 160 }, (_, i) => `t${i}`);
    const result = terms({ title: titleWords.join(' '), content: 'frequent '.repeat(5) });
    assert.equal(result.size, 160);
    assert.equal(result.has('frequent'), false);
  });

  test('is deterministic and handles empty posts', () => {
    assert.deepEqual([...computeSearchTerms(post())], [...computeSearchTerms(post())]);
    assert.equal(computeSearchTerms({}).size, 0);
    assert.equal(computeSearchTerms(null).size, 0);
    assert.equal(terms({ title: 'the and of', content: 'le la les' }).size, 0);
  });
});

describe('diffTags', () => {
  test('splits tags into added, removed and kept, preserving order', () => {
    assert.deepEqual(diffTags(['aws', 'serverless', 'lambda'], ['lambda', 'dynamodb', 'aws']), {
      added: ['dynamodb'],
      removed: ['serverless'],
      kept: ['lambda', 'aws'],
    });
  });

  test('handles missing lists and duplicates', () => {
    assert.deepEqual(diffTags(null, ['a']), { added: ['a'], removed: [], kept: [] });
    assert.deepEqual(diffTags(['a'], undefined), { added: [], removed: ['a'], kept: [] });
    assert.deepEqual(diffTags(), { added: [], removed: [], kept: [] });
    assert.deepEqual(diffTags(['a', 'a'], ['a', 'b', 'b']), { added: ['b'], removed: [], kept: ['a'] });
  });
});

describe('postTags', () => {
  test('normalises list and string set values', () => {
    assert.deepEqual(postTags({ tags: ['aws', 'AWS', 'Serverless Computing'] }), ['aws', 'serverless-computing']);
    assert.deepEqual(postTags({ tags: new Set(['b', 'a']) }), ['b', 'a']);
    assert.deepEqual(postTags({}), []);
    assert.deepEqual(postTags(null), []);
    assert.deepEqual(postTags({ tags: 'aws' }), []);
  });
});

describe('hasRelevantChange', () => {
  test('INSERT and REMOVE records (a single image) are always relevant', () => {
    assert.equal(hasRelevantChange(null, post()), true);
    assert.equal(hasRelevantChange(post(), null), true);
    assert.equal(hasRelevantChange(undefined, undefined), true);
  });

  test('changes limited to other attributes are not relevant', () => {
    assert.equal(hasRelevantChange(post(), post()), false);
    const commented = post({ commentCount: 3, updatedAt: '2026-10-28T08:00:00.000Z', version: 4, GSI1SK: 'x' });
    assert.equal(hasRelevantChange(post(), commented), false);
    assert.equal(hasRelevantChange(post({ tags: ['aws', 'serverless'] }), post({ tags: ['aws', 'serverless'] })), false);
  });

  test('a change of any projected attribute is relevant', () => {
    const changed = {
      status: 'draft',
      title: 'Autre titre',
      slug: 'autre-titre',
      excerpt: 'Autre extrait',
      content: 'Autre contenu',
      tags: ['serverless', 'aws'],
      coverImageUrl: null,
      publishedAt: '2026-10-28T10:00:00.000Z',
      authorName: 'Renamed',
      readingTimeMinutes: 2,
      allowComments: false,
    };
    assert.deepEqual(Object.keys(changed).sort(), [...RELEVANT_FIELDS].sort());
    for (const [field, value] of Object.entries(changed)) {
      assert.equal(hasRelevantChange(post(), post({ [field]: value })), true, field);
    }
  });
});

test('publishedPost returns the image only when the post is published', () => {
  const published = post();
  assert.equal(publishedPost(published), published);
  for (const status of ['draft', 'in_review', 'archived']) assert.equal(publishedPost(post({ status })), null);
  assert.equal(publishedPost(null), null);
  assert.equal(publishedPost(undefined), null);
});

describe('projection items', () => {
  test('tag membership: post summary under the same attribute names + tag keys and GSI1 keys', () => {
    const item = tagMembershipItem(post(), 'aws');
    const { content, customExcerpt, GSI1PK, GSI1SK, GSI2PK, GSI2SK, PK, SK, entityType, ...summary } = post();
    assert.deepEqual(item, {
      ...summary,
      PK: `TAG#aws`,
      SK: `POST#${POST_ID}`,
      GSI1PK: 'TAG#aws',
      GSI1SK: `2026-10-27T10:00:00.000Z#${POST_ID}`,
      entityType: 'TAG_POST',
      tag: 'aws',
    });
    assert.deepEqual(Object.keys(summary).sort(), [...MEMBERSHIP_SUMMARY_ATTRIBUTES].sort());
    assert.deepEqual(
      MEMBERSHIP_SUMMARY_ATTRIBUTES,
      POST_SUMMARY_ATTRIBUTES.filter((name) => name !== 'entityType'),
    );
  });

  test('tag membership omits absent attributes', () => {
    const { submittedAt, reviewNote, ...partial } = post();
    const item = tagMembershipItem(partial, 'aws');
    assert.equal('submittedAt' in item, false);
    assert.equal('reviewNote' in item, false);
    assert.equal(item.title, 'Architecture serverless');
  });

  test('search term: score and post summary', () => {
    assert.deepEqual(searchTermItem(post(), 'lambda', 4), {
      PK: 'TERM#lambda',
      SK: `POST#${POST_ID}`,
      entityType: 'TERM',
      term: 'lambda',
      score: 4,
      postId: POST_ID,
      slug: 'architecture-serverless',
      title: 'Architecture serverless',
      excerpt: 'Lambda, API Gateway et DynamoDB.',
      coverImageUrl: 'https://cdn.example.com/media/cover.png',
      tags: ['aws', 'serverless'],
      authorId: users.author.userId,
      authorName: users.author.name,
      publishedAt: '2026-10-27T10:00:00.000Z',
      readingTimeMinutes: 1,
    });
    assert.equal(searchTermItem(post({ coverImageUrl: undefined }), 'aws', 6).coverImageUrl, null);
  });
});
