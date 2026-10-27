// Write side of posts: CRUD and editorial workflow. Every route sits behind the API Gateway
// authorizer; ownership, status and workflow rules are enforced by src/domain/posts.mjs.

import { createApiHandler, created, etag, noContent, ok, parseIfMatch } from '../../lib/http.mjs';
import { validate } from '../../lib/validation.mjs';
import {
  createPost,
  createPostSchema,
  deletePost,
  postIdParamsSchema,
  toApiPost,
  transitionBodySchema,
  transitionPost,
  updatePost,
  updatePostSchema,
} from '../../domain/posts.mjs';

const fullPost = (post) => toApiPost(post, { includeContent: true });
const versionHeaders = (post) => ({ ETag: etag(post.version) });

/** POST /posts: new draft owned by the caller. */
async function createPostRoute(req) {
  const input = validate(createPostSchema, req.body);
  const post = await createPost(req.identity, input);
  return created(fullPost(post), `/posts/${post.postId}`, versionHeaders(post));
}

/** PATCH /posts/{postId}: partial update, optional If-Match. */
async function updatePostRoute(req) {
  const { postId } = validate(postIdParamsSchema, req.params);
  const ifMatch = parseIfMatch(req.header('If-Match'));
  const patch = validate(updatePostSchema, req.body);
  const post = await updatePost(req.identity, postId, patch, { ifMatch });
  return ok(fullPost(post), versionHeaders(post));
}

/** DELETE /posts/{postId}: optional If-Match. */
async function deletePostRoute(req) {
  const { postId } = validate(postIdParamsSchema, req.params);
  const ifMatch = parseIfMatch(req.header('If-Match'));
  await deletePost(req.identity, postId, { ifMatch });
  return noContent();
}

/** POST /posts/{postId}/{action}: editorial workflow transition, optional If-Match. */
function transitionRoute(action) {
  return async (req) => {
    const { postId } = validate(postIdParamsSchema, req.params);
    const ifMatch = parseIfMatch(req.header('If-Match'));
    const { note } = validate(transitionBodySchema(action), req.body);
    const post = await transitionPost(req.identity, postId, action, { note, ifMatch });
    return ok(fullPost(post), versionHeaders(post));
  };
}

export const routes = {
  'POST /posts': { auth: 'required', handler: createPostRoute },
  'PATCH /posts/{postId}': { auth: 'required', handler: updatePostRoute },
  'DELETE /posts/{postId}': { auth: 'required', handler: deletePostRoute },
  'POST /posts/{postId}/submit': { auth: 'required', handler: transitionRoute('submit') },
  'POST /posts/{postId}/publish': { auth: 'required', handler: transitionRoute('publish') },
  'POST /posts/{postId}/unpublish': { auth: 'required', handler: transitionRoute('unpublish') },
  'POST /posts/{postId}/reject': { auth: 'required', handler: transitionRoute('reject') },
  'POST /posts/{postId}/archive': { auth: 'required', handler: transitionRoute('archive') },
};

export const handler = createApiHandler(routes);
