// Shared post lookup and visibility rules (used by posts, comments and other domains).

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo } from '../lib/aws.mjs';
import { keys, tableName } from '../lib/db.mjs';
import { can, isOwner, PERMISSIONS } from '../lib/auth.mjs';
import { POST_STATUS } from '../lib/schema.mjs';

/** Reads a post item by id (null when it does not exist). */
export async function getPostItem(postId, { consistent = false } = {}) {
  const { Item } = await dynamo().send(
    new GetCommand({ TableName: tableName(), Key: keys.post(postId), ConsistentRead: consistent }),
  );
  return Item ?? null;
}

/** Resolves a slug to a post id through the slug uniqueness item (null when unknown). */
export async function getPostIdBySlug(slug) {
  const { Item } = await dynamo().send(new GetCommand({ TableName: tableName(), Key: keys.slug(slug) }));
  return Item?.postId ?? null;
}

/**
 * A post is visible when it is published, or to its author, or to users allowed to read
 * any post (editors and administrators). Invisible posts must be reported as 404.
 */
export function canViewPost(identity, post) {
  if (!post) return false;
  if (post.status === POST_STATUS.PUBLISHED) return true;
  return isOwner(identity, post.authorId) || can(identity, PERMISSIONS.POST_READ_ANY);
}
