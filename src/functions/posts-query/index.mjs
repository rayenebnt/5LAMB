// Read side of posts (public delivery API, read-only IAM permissions).
// A token is optional: it reveals the caller's own unpublished posts (every post for editors).
// Business rules live in src/domain/posts.mjs.

import { cacheHeaders, createApiHandler, etag, ok } from '../../lib/http.mjs';
import { POST_STATUS } from '../../lib/schema.mjs';
import { validate } from '../../lib/validation.mjs';
import { getVisiblePost, listPosts, listPostsQuerySchema, toApiPost } from '../../domain/posts.mjs';

/** Unpublished content must never be stored by shared caches. */
const NO_STORE = Object.freeze({ 'Cache-Control': 'private, no-store' });

/** Public caching only for published content requested anonymously. */
const cachingFor = (status, identity) => (status === POST_STATUS.PUBLISHED ? cacheHeaders(identity) : NO_STORE);

/** GET /posts: published posts by default, filtered by tag and/or author; summaries only. */
async function listPostsRoute(req) {
  const query = validate(listPostsQuerySchema, req.query);
  const { items, nextCursor } = await listPosts(req.identity, query);
  return ok({ items: items.map((item) => toApiPost(item)), nextCursor }, cachingFor(query.status, req.identity));
}

/** GET /posts/{postId}: by id or slug, full post with content; invisible posts are 404. */
async function getPostRoute(req) {
  const post = await getVisiblePost(req.identity, req.params.postId);
  return ok(toApiPost(post, { includeContent: true }), {
    ETag: etag(post.version),
    ...cachingFor(post.status, req.identity),
  });
}

export const routes = {
  'GET /posts': { auth: 'optional', handler: listPostsRoute },
  'GET /posts/{postId}': { auth: 'optional', handler: getPostRoute },
};

export const handler = createApiHandler(routes);
