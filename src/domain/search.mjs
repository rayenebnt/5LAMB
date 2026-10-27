// Full-text search on an inverted index stored in the table and maintained by the projector:
// one item per (term, published post) — TERM#<term> / POST#<postId> — holding the relevance score
// of the term for the post and a copy of the post summary. A search therefore costs one Query
// per query term and no further read.

import { batchWriteAll, keys, queryAll } from '../lib/db.mjs';
import { ENTITY } from '../lib/schema.mjs';
import { stripMarkdown, tokenize } from '../lib/text.mjs';
import { postTags } from './tags.mjs';

/** Points given to a term for each part of a post where it appears. */
export const TERM_WEIGHTS = Object.freeze({
  title: 10, // once per distinct title token
  tag: 6, // once per distinct tag token
  excerpt: 3, // once per distinct excerpt token
  contentMax: 5, // content: one point per occurrence, capped
});

/** Number of terms indexed per post (title and tag terms are always indexed on top). */
export const MAX_TERMS_PER_POST = 150;
/** Number of distinct query tokens used by a search. */
export const MAX_QUERY_TERMS = 8;
/** Number of index items read per query term. */
export const MAX_POSTS_PER_TERM = 500;

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Partition of the index items of a term. */
const termPartition = (term) => keys.term(term, '').PK;

/**
 * Search tokens of a tag: its words ("serverless-aws" -> serverless, aws), plus the whole tag when
 * it has a single word, so that tags whose other parts are too short or stop words
 * ("e-commerce") are indexed as a whole too.
 */
function tagTokens(tag) {
  const tokens = tokenize(tag.replace(/-/g, ' '));
  return tokens.length === 1 ? [...new Set([...tokens, tag])] : tokens;
}

function countOccurrences(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * Relevance score of every term of a post: title tokens +10, tag tokens +6 (each once), excerpt
 * tokens +3 (once), content tokens +1 per occurrence (at most +5). Keeps the 150 best terms;
 * title and tag terms are always kept. Ties are broken alphabetically so that the result is
 * deterministic (re-projecting an unchanged post yields the same terms).
 * @returns {Map<string, number>} term -> score, best first
 */
export function computeSearchTerms(post) {
  const titleTerms = new Set(tokenize(post?.title));
  const tagTerms = new Set(postTags(post).flatMap(tagTokens));
  const excerptTerms = new Set(tokenize(post?.excerpt));
  const contentCounts = countOccurrences(tokenize(stripMarkdown(post?.content)));

  const scores = new Map();
  const add = (term, points) => scores.set(term, (scores.get(term) ?? 0) + points);
  for (const term of titleTerms) add(term, TERM_WEIGHTS.title);
  for (const term of tagTerms) add(term, TERM_WEIGHTS.tag);
  for (const term of excerptTerms) add(term, TERM_WEIGHTS.excerpt);
  for (const [term, count] of contentCounts) add(term, Math.min(count, TERM_WEIGHTS.contentMax));

  const ranked = [...scores].sort(([termA, scoreA], [termB, scoreB]) => scoreB - scoreA || compareStrings(termA, termB));
  const alwaysKept = (term) => titleTerms.has(term) || tagTerms.has(term);
  const keptCount = ranked.filter(([term]) => alwaysKept(term)).length;
  let otherSlots = Math.max(0, MAX_TERMS_PER_POST - keptCount);
  const selected = ranked.filter(([term]) => {
    if (alwaysKept(term)) return true;
    if (otherSlots === 0) return false;
    otherSlots -= 1;
    return true;
  });
  return new Map(selected);
}

/** Index item of a term for a published post (score + post summary). */
export function searchTermItem(post, term, score) {
  return {
    ...keys.term(term, post.postId),
    entityType: ENTITY.TERM,
    term,
    score,
    postId: post.postId,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    coverImageUrl: post.coverImageUrl ?? null,
    tags: post.tags ?? [],
    authorId: post.authorId,
    authorName: post.authorName,
    publishedAt: post.publishedAt,
    readingTimeMinutes: post.readingTimeMinutes,
  };
}

/**
 * Updates the index of a post between two versions: deletes the items of the terms that
 * disappeared and (re)writes every current term item (refreshing the copied summary).
 * `before` / `after` are the post items when published, null otherwise.
 * @returns {Promise<{ put: number, deleted: number }>}
 */
export async function projectSearchTerms(before, after) {
  const oldTerms = before ? computeSearchTerms(before) : new Map();
  const newTerms = after ? computeSearchTerms(after) : new Map();
  const postId = (after ?? before)?.postId;
  const deletes = [...oldTerms.keys()]
    .filter((term) => !newTerms.has(term))
    .map((term) => ({ DeleteRequest: { Key: keys.term(term, postId) } }));
  const puts = [...newTerms].map(([term, score]) => ({ PutRequest: { Item: searchTermItem(after, term, score) } }));
  await batchWriteAll([...deletes, ...puts]);
  return { put: puts.length, deleted: deletes.length };
}

/** Distinct search terms of a query string (at most MAX_QUERY_TERMS, in query order). */
export function queryTerms(query) {
  return [...new Set(tokenize(query))].slice(0, MAX_QUERY_TERMS);
}

/**
 * Merges the index items found for each query term into one match per post:
 * `{ post, matchedTerms, score }` where `post` is the summary copied in the index item.
 * @param {object[][]} itemsByTerm index items, one array per (distinct) query term
 */
export function aggregateMatches(itemsByTerm) {
  const matches = new Map();
  for (const items of itemsByTerm) {
    for (const item of items) {
      if (!item?.postId) continue;
      const match = matches.get(item.postId) ?? { post: item, matchedTerms: 0, score: 0 };
      match.matchedTerms += 1;
      match.score += Number(item.score) || 0;
      matches.set(item.postId, match);
    }
  }
  return [...matches.values()];
}

/** Ranking: most matched terms first, then highest score, then most recently published. */
export function compareMatches(a, b) {
  return (
    b.matchedTerms - a.matchedTerms ||
    b.score - a.score ||
    compareStrings(b.post.publishedAt ?? '', a.post.publishedAt ?? '') ||
    compareStrings(b.post.postId, a.post.postId)
  );
}

/** Public representation of a match (post summary in the API shape + relevance). */
export function toSearchResult({ post, score, matchedTerms }) {
  return {
    id: post.postId,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt ?? '',
    coverImageUrl: post.coverImageUrl ?? null,
    tags: [...(post.tags ?? [])],
    author: { id: post.authorId ?? null, name: post.authorName ?? null },
    publishedAt: post.publishedAt ?? null,
    readingTimeMinutes: post.readingTimeMinutes ?? null,
    score,
    matchedTerms,
  };
}

/**
 * Searches published posts: one Query per distinct query term (in parallel, newest posts first,
 * at most MAX_POSTS_PER_TERM items each), then ranking with `compareMatches`.
 * @param {string} query trimmed query string
 * @param {{ limit?: number }} [options] number of results to return
 * @returns {Promise<{ query: string, terms: string[], total: number, items: object[] }>}
 */
export async function searchPosts(query, { limit = 10 } = {}) {
  const terms = queryTerms(query);
  if (terms.length === 0) return { query, terms, total: 0, items: [] };

  const itemsByTerm = await Promise.all(
    terms.map((term) =>
      queryAll(
        {
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': termPartition(term) },
          ScanIndexForward: false,
          Limit: MAX_POSTS_PER_TERM,
        },
        { maxItems: MAX_POSTS_PER_TERM },
      ),
    ),
  );
  const ranked = aggregateMatches(itemsByTerm).sort(compareMatches);
  return { query, terms, total: ranked.length, items: ranked.slice(0, limit).map(toSearchResult) };
}
