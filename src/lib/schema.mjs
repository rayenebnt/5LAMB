// Item attribute catalogue shared by the code and the SAM template.
// The GSIs use an INCLUDE projection (post bodies are NOT copied into the indexes):
// every attribute returned by a listing served from a GSI must appear below, and
// tests/unit/template.test.mjs checks that template.yaml projects all of them.

export const ENTITY = Object.freeze({
  POST: 'POST',
  SLUG: 'SLUG',
  COMMENT: 'COMMENT',
  NOTIFICATION: 'NOTIFICATION',
  MEDIA: 'MEDIA',
  PROFILE: 'PROFILE',
  TAG_POST: 'TAG_POST',
  TAG: 'TAG',
  TERM: 'TERM',
});

/** Post statuses and editorial workflow. */
export const POST_STATUS = Object.freeze({
  DRAFT: 'draft',
  IN_REVIEW: 'in_review',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
});

export const COMMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SPAM: 'spam',
});

export const MEDIA_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  REJECTED: 'rejected',
});

/** Post attributes available in listings (GSI1 by status / tag, GSI2 by author). */
export const POST_SUMMARY_ATTRIBUTES = Object.freeze([
  'entityType',
  'postId',
  'slug',
  'title',
  'excerpt',
  'coverImageUrl',
  'tags',
  'status',
  'authorId',
  'authorName',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'submittedAt',
  'readingTimeMinutes',
  'commentCount',
  'allowComments',
  'reviewNote',
  'version',
]);

/** Comment attributes available in the moderation queue (GSI1). */
export const COMMENT_ATTRIBUTES = Object.freeze([
  'entityType',
  'commentId',
  'postId',
  'postTitle',
  'parentId',
  'body',
  'authorId',
  'authorName',
  'authorEmail',
  'status',
  'createdAt',
  'updatedAt',
  'moderatedBy',
  'moderatedAt',
]);

/** Media attributes available in media listings (GSI1 all media, GSI2 by owner). */
export const MEDIA_ATTRIBUTES = Object.freeze([
  'entityType',
  'mediaId',
  'ownerId',
  'ownerName',
  'filename',
  'contentType',
  'kind',
  'size',
  'status',
  's3Key',
  'altText',
  'rejectionReason',
  'createdAt',
  'updatedAt',
]);

/** Extra attribute of tag membership items (GSI1, partition TAG#<tag>). */
export const TAG_POST_EXTRA_ATTRIBUTES = Object.freeze(['tag']);

const unique = (...lists) => [...new Set(lists.flat())].sort();

/** Non-key attributes projected into each GSI (must match template.yaml). */
export const GSI_PROJECTIONS = Object.freeze({
  GSI1: unique(POST_SUMMARY_ATTRIBUTES, COMMENT_ATTRIBUTES, MEDIA_ATTRIBUTES, TAG_POST_EXTRA_ATTRIBUTES),
  GSI2: unique(POST_SUMMARY_ATTRIBUTES, MEDIA_ATTRIBUTES),
});
