// Public read-only API: full-text search (GET /search) and tag cloud (GET /tags).
// Both read projections maintained by the projector, which only index published posts.

import { cacheHeaders, createApiHandler, ok } from '../../lib/http.mjs';
import { schemas, validate, z } from '../../lib/validation.mjs';
import { searchPosts } from '../../domain/search.mjs';
import { listTags } from '../../domain/tags.mjs';

const SEARCH_CACHE_SECONDS = 60;
const TAGS_CACHE_SECONDS = 300;

const searchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200),
  limit: schemas.limit(50, 10),
});

const tagsQuerySchema = z.strictObject({});

/** GET /search?q=&limit= */
async function search(req) {
  const { q, limit } = validate(searchQuerySchema, req.query);
  const result = await searchPosts(q, { limit });
  return ok(result, cacheHeaders(null, SEARCH_CACHE_SECONDS));
}

/** GET /tags */
async function tags(req) {
  validate(tagsQuerySchema, req.query);
  const items = await listTags();
  return ok({ items }, cacheHeaders(null, TAGS_CACHE_SECONDS));
}

export const routes = {
  'GET /search': { auth: 'none', handler: search },
  'GET /tags': { auth: 'none', handler: tags },
};

export const handler = createApiHandler(routes);
