// Item attribute catalogue shared by the code.
// The GSIs use an ALL projection: DynamoDB caps INCLUDE projections at 20 non-key attributes
// per index, and the overloaded GSIs serve several entity types (posts, tag memberships,
// comments, media). Listings map index items to summaries (toApiPost without includeContent),
// so post bodies never reach list responses.

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

/** Post attributes shown in listings, also copied into tag memberships (GSI1, TAG#<tag>). */
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

/** Comment attributes shown in the moderation queue (GSI1). */
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

/** Media attributes shown in media listings (GSI1 all media, GSI2 by owner). */
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
