// Tag projections, maintained asynchronously by the projector from the DynamoDB stream:
//   - membership items  TAG#<tag> / POST#<postId>: one per (tag, published post), carrying a copy of
//     the post summary and indexed in GSI1 (TAG#<tag> / <publishedAt>#<postId>) for GET /posts?tag=
//   - counter items     TAGS / TAG#<tag>: number of published posts having the tag, for GET /tags
//
// The stream is delivered at least once, so a counter is only ever changed in the same transaction
// as the creation or deletion of the membership item it counts, guarded by a condition on that
// item: replaying a record can neither count a post twice nor decrement a counter twice.

import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo } from '../lib/aws.mjs';
import {
  batchWriteAll,
  cancellationReasons,
  indexKeys,
  isTransactionCanceled,
  keys,
  queryAll,
  tableName,
} from '../lib/db.mjs';
import { nowIso } from '../lib/ids.mjs';
import { ENTITY, POST_SUMMARY_ATTRIBUTES } from '../lib/schema.mjs';
import { normalizeTags } from '../lib/text.mjs';

/** Post attributes copied into membership items, under the same names as on post items. */
export const MEMBERSHIP_SUMMARY_ATTRIBUTES = Object.freeze(
  POST_SUMMARY_ATTRIBUTES.filter((name) => name !== 'entityType'),
);

/** Partition key shared by every tag counter item. */
const COUNTERS_PARTITION = keys.tagCounter('').PK;

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function pick(source, names) {
  return Object.fromEntries(
    names.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]),
  );
}

/** Normalised tags of a post item (`tags` may be a list or a DynamoDB string set); [] when none. */
export function postTags(post) {
  const tags = post?.tags;
  if (!Array.isArray(tags) && !(tags instanceof Set)) return [];
  return normalizeTags([...tags].map(String));
}

/**
 * Compares two tag lists: `added` (only in the new list), `removed` (only in the old list) and
 * `kept` (in both). Duplicates are ignored and the order of the input lists is preserved.
 * @param {string[]} [oldTags]
 * @param {string[]} [newTags]
 */
export function diffTags(oldTags = [], newTags = []) {
  const before = new Set(oldTags ?? []);
  const after = new Set(newTags ?? []);
  return {
    added: [...after].filter((tag) => !before.has(tag)),
    removed: [...before].filter((tag) => !after.has(tag)),
    kept: [...after].filter((tag) => before.has(tag)),
  };
}

/** Membership item of a published post for one of its tags (post summary + GSI1 keys). */
export function tagMembershipItem(post, tag) {
  const sortDate = post.publishedAt || post.updatedAt || post.createdAt;
  return {
    ...pick(post, MEMBERSHIP_SUMMARY_ATTRIBUTES),
    ...keys.tagPost(tag, post.postId),
    ...indexKeys.postByTag(tag, sortDate, post.postId),
    entityType: ENTITY.TAG_POST,
    tag,
  };
}

/** Transaction item adding `delta` to the counter of `tag` (created on first use). */
function counterUpdate(tag, delta) {
  return {
    Update: {
      TableName: tableName(),
      Key: keys.tagCounter(tag),
      UpdateExpression: 'ADD #postCount :delta SET #tag = :tag, #updatedAt = :now, #entityType = :entityType',
      ExpressionAttributeNames: {
        '#postCount': 'postCount',
        '#tag': 'tag',
        '#updatedAt': 'updatedAt',
        '#entityType': 'entityType',
      },
      ExpressionAttributeValues: { ':delta': delta, ':tag': tag, ':now': nowIso(), ':entityType': ENTITY.TAG },
    },
  };
}

/** True when a transaction was cancelled because its first item (the membership) failed its condition. */
function membershipConditionFailed(err) {
  return isTransactionCanceled(err) && cancellationReasons(err)[0] === 'ConditionalCheckFailed';
}

/** Deletes a membership and decrements the counter. Returns false when it was already deleted. */
async function removeMembership(tag, postId) {
  try {
    await dynamo().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: tableName(),
              Key: keys.tagPost(tag, postId),
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
          counterUpdate(tag, -1),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (membershipConditionFailed(err)) return false; // already applied by a previous delivery
    throw err;
  }
}

/** Creates a membership and increments the counter. Returns false when it already existed. */
async function addMembership(post, tag) {
  const item = tagMembershipItem(post, tag);
  try {
    await dynamo().send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
          counterUpdate(tag, 1),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (!membershipConditionFailed(err)) throw err;
    // Already counted by a previous delivery: only refresh the post summary.
    await dynamo().send(new PutCommand({ TableName: tableName(), Item: item }));
    return false;
  }
}

/**
 * Applies the tag changes between two versions of a post to the tag projections.
 * `before` / `after` are the post items when published, null otherwise (a post that is not
 * published has no membership). Memberships are refreshed for the tags that are kept.
 * @returns {Promise<{ added: string[], removed: string[], kept: string[] }>}
 */
export async function projectTags(before, after) {
  const diff = diffTags(postTags(before), postTags(after));
  const postId = (after ?? before)?.postId;
  for (const tag of diff.removed) await removeMembership(tag, postId);
  for (const tag of diff.added) await addMembership(after, tag);
  await batchWriteAll(diff.kept.map((tag) => ({ PutRequest: { Item: tagMembershipItem(after, tag) } })));
  return diff;
}

/** Orders tags by decreasing number of posts, then alphabetically. */
export function compareTagCounts(a, b) {
  return b.postCount - a.postCount || compareStrings(a.tag, b.tag);
}

/**
 * Tags having at least one published post: `[{ tag, postCount }]`, most used first.
 */
export async function listTags() {
  const counters = await queryAll({
    KeyConditionExpression: 'PK = :pk',
    FilterExpression: '#postCount > :zero',
    ExpressionAttributeNames: { '#postCount': 'postCount' },
    ExpressionAttributeValues: { ':pk': COUNTERS_PARTITION, ':zero': 0 },
  });
  return counters
    .map((counter) => ({ tag: counter.tag, postCount: Number(counter.postCount) }))
    .filter(({ tag, postCount }) => typeof tag === 'string' && tag !== '' && postCount > 0)
    .sort(compareTagCounts);
}
