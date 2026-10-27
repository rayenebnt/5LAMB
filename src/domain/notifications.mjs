// Notifications of new posts (Amazon SNS e-mails + Amazon EventBridge events) and newsletter
// subscriptions.
//
// When a post is published for the first time, the notifier (DynamoDB Streams consumer):
//   1. writes an idempotency marker (POST#<postId> / NOTIFICATION) with a conditional Put,
//   2. e-mails the subscribers through the SNS topic: plain-text French message carrying a
//      "tags" message attribute that subscription filter policies match against,
//   3. emits a "PostPublished" event on EventBridge for integrations.
// Stream records are delivered at least once: the marker makes duplicate deliveries (and later
// re-publications of the same post) harmless. When SNS fails the marker is removed and the error
// is rethrown so that the record is retried. EventBridge failures are only logged: retrying the
// record would e-mail the subscribers a second time.
//
// Subscriptions are SNS "email" subscriptions (double opt-in: SNS e-mails a confirmation link),
// optionally restricted to some tags with a filter policy on the "tags" message attribute.

import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  ListSubscriptionsByTopicCommand,
  PublishCommand,
  SubscribeCommand,
} from '@aws-sdk/client-sns';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { dynamo, eventBridge, sns } from '../lib/aws.mjs';
import { config } from '../lib/config.mjs';
import { isConditionalCheckFailed, keys, tableName } from '../lib/db.mjs';
import { AppError, badRequest, conflict, isAwsError, serviceUnavailable } from '../lib/errors.mjs';
import { nowIso } from '../lib/ids.mjs';
import { logger } from '../lib/logger.mjs';
import { ENTITY, POST_STATUS } from '../lib/schema.mjs';
import { normalizeTags, toAsciiSubject } from '../lib/text.mjs';

/** EventBridge event emitted when a post is published for the first time. */
export const POST_PUBLISHED_EVENT = Object.freeze({
  source: 'blogify.posts',
  detailType: 'PostPublished',
});

/** Result of `notifyPostPublished`. */
export const NOTIFY_OUTCOME = Object.freeze({
  NOTIFIED: 'notified',
  ALREADY_NOTIFIED: 'already_notified',
});

export const SUBSCRIPTION_STATUS = Object.freeze({
  PENDING_CONFIRMATION: 'pending_confirmation',
  CONFIRMED: 'confirmed',
});

/** SubscriptionArn reported by SNS until the confirmation link of the e-mail is clicked. */
const PENDING_CONFIRMATION_ARN = 'PendingConfirmation';

const EMAIL_PROTOCOLS = new Set(['email', 'email-json']);

/** SNS errors caused by our own capacity (throttling, quotas): not the client's fault. */
const SNS_CAPACITY_ERRORS = [
  'ThrottledException',
  'SubscriptionLimitExceededException',
  'FilterPolicyLimitExceededException',
];

function topicArn() {
  const arn = config.topicArn;
  if (!arn) throw new Error('TOPIC_ARN is not configured');
  return arn;
}

/** User-provided text on a single line: control characters and line breaks become spaces. */
function oneLine(value) {
  return String(value ?? '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
}

/** Normalised tags of a post image (a list, or a string set unmarshalled as a Set). */
function postTags(post) {
  const tags = post?.tags instanceof Set ? [...post.tags] : post?.tags;
  return Array.isArray(tags) ? normalizeTags(tags.filter((tag) => typeof tag === 'string')) : [];
}

// ---------------------------------------------------------------------------
// Notification content (pure functions)
// ---------------------------------------------------------------------------

/** True when a change publishes a post that was not published before (first publication). */
export function isFirstPublication(newPost, oldPost) {
  return newPost?.status === POST_STATUS.PUBLISHED && oldPost?.status !== POST_STATUS.PUBLISHED;
}

/** Public URL of a post on the front-end (`PUBLIC_SITE_URL/posts/<slug>`), null when not configured. */
export function postUrl(slug) {
  const siteUrl = config.publicSiteUrl;
  return siteUrl && slug ? `${siteUrl}/posts/${encodeURIComponent(slug)}` : null;
}

/** E-mail subject (SNS only accepts printable ASCII subjects shorter than 100 characters). */
export function notificationSubject(post) {
  return toAsciiSubject(`Nouvel article : ${oneLine(post.title)}`);
}

/** Plain-text French e-mail announcing a new post. */
export function notificationMessage(post) {
  const author = oneLine(post.authorName);
  const minutes = Number(post.readingTimeMinutes);
  const tags = postTags(post);
  const excerpt = oneLine(post.excerpt);
  const url = postUrl(post.slug);

  const lines = [
    'Bonjour,',
    '',
    "Un nouvel article vient d'être publié sur Blogify :",
    '',
    `« ${oneLine(post.title)} »`,
  ];
  if (author) lines.push(`Auteur : ${author}`);
  if (Number.isInteger(minutes) && minutes > 0) {
    lines.push(`Temps de lecture : environ ${minutes} minute${minutes > 1 ? 's' : ''}`);
  }
  if (tags.length) lines.push(`Tags : ${tags.join(', ')}`);
  if (excerpt) lines.push('', excerpt);
  if (url) lines.push('', `Lire l'article : ${url}`);
  lines.push(
    '',
    'Bonne lecture !',
    "L'équipe Blogify",
    '',
    '--',
    'Vous recevez cet e-mail car vous êtes abonné(e) aux nouveaux articles de Blogify.',
    'Pour vous désabonner, utilisez le lien figurant en bas de ce message.',
  );
  return lines.join('\n');
}

/** SNS message attributes: the post tags (String.Array), matched by subscription filter policies. */
export function notificationAttributes(post) {
  const tags = postTags(post);
  if (!tags.length) return undefined;
  return { tags: { DataType: 'String.Array', StringValue: JSON.stringify(tags) } };
}

/** Detail of the PostPublished EventBridge event. */
export function postPublishedDetail(post) {
  return {
    postId: post.postId,
    slug: post.slug ?? null,
    title: post.title ?? null,
    excerpt: post.excerpt ?? null,
    tags: postTags(post),
    authorId: post.authorId ?? null,
    authorName: post.authorName ?? null,
    publishedAt: post.publishedAt ?? null,
    url: postUrl(post.slug),
  };
}

// ---------------------------------------------------------------------------
// Notification delivery
// ---------------------------------------------------------------------------

/**
 * Writes the idempotency marker of a post.
 * @returns {Promise<boolean>} false when the marker already exists (post already notified)
 */
export async function claimNotification(postId) {
  try {
    await dynamo().send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...keys.notification(postId), entityType: ENTITY.NOTIFICATION, postId, createdAt: nowIso() },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/** Removes the idempotency marker so that the notification can be attempted again. */
export async function releaseNotification(postId) {
  await dynamo().send(new DeleteCommand({ TableName: tableName(), Key: keys.notification(postId) }));
}

/**
 * E-mails the subscribers of the topic (filtered by their tag filter policy).
 * @returns {Promise<string|undefined>} SNS message id
 */
export async function publishNewPostEmail(post) {
  const { MessageId } = await sns().send(
    new PublishCommand({
      TopicArn: topicArn(),
      Subject: notificationSubject(post),
      Message: notificationMessage(post),
      MessageAttributes: notificationAttributes(post),
    }),
  );
  return MessageId;
}

/**
 * Emits the PostPublished event. Never throws: failures are logged and not retried, because
 * retrying the stream record would e-mail the subscribers again.
 * @returns {Promise<boolean>} true when EventBridge accepted the event
 */
export async function emitPostPublishedEvent(post) {
  try {
    const response = await eventBridge().send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: config.eventBusName,
            Source: POST_PUBLISHED_EVENT.source,
            DetailType: POST_PUBLISHED_EVENT.detailType,
            Detail: JSON.stringify(postPublishedDetail(post)),
          },
        ],
      }),
    );
    if (response?.FailedEntryCount > 0) {
      const failed = response.Entries?.find((entry) => entry?.ErrorCode) ?? {};
      logger.error('PostPublished event rejected by EventBridge', {
        postId: post.postId,
        errorCode: failed.ErrorCode,
        errorMessage: failed.ErrorMessage,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('PostPublished event could not be sent to EventBridge', { postId: post.postId, error: err });
    return false;
  }
}

/**
 * Notifies the first publication of a post: idempotency marker, SNS e-mail, EventBridge event.
 * Throws when the marker cannot be written or the e-mail cannot be sent (the caller retries).
 * @param {object} post post item (stream NewImage)
 * @returns {Promise<'notified'|'already_notified'>}
 */
export async function notifyPostPublished(post) {
  const { postId } = post;
  if (!(await claimNotification(postId))) {
    logger.info('Post already notified (duplicate delivery or re-publication)', { postId });
    return NOTIFY_OUTCOME.ALREADY_NOTIFIED;
  }

  let messageId;
  try {
    messageId = await publishNewPostEmail(post);
  } catch (err) {
    try {
      await releaseNotification(postId);
    } catch (releaseErr) {
      // The retried record will find the marker and skip the post: make it visible.
      logger.error('Notification marker could not be removed: the post will not be notified', {
        postId,
        error: releaseErr,
      });
    }
    throw err;
  }
  logger.info('Subscribers notified of a new post', { postId, messageId });

  await emitPostPublishedEvent(post);
  return NOTIFY_OUTCOME.NOTIFIED;
}

// ---------------------------------------------------------------------------
// Newsletter subscriptions
// ---------------------------------------------------------------------------

function snsUnavailable(err) {
  logger.warn('Amazon SNS capacity error', { error: err });
  return serviceUnavailable('The newsletter service is busy, please retry later');
}

/**
 * SNS subscription attributes delivering only the posts having at least one of `tags`
 * (undefined when there is no tag: every new post is delivered).
 */
export function subscriptionAttributes(tags = []) {
  if (!tags.length) return undefined;
  return { FilterPolicy: JSON.stringify({ tags }), FilterPolicyScope: 'MessageAttributes' };
}

/**
 * Subscribes an e-mail address to the new posts (optionally only those having one of `tags`).
 * SNS e-mails a confirmation link; deliveries start once it is clicked (double opt-in).
 * @param {{ email: string, tags?: string[] }} input validated e-mail address and raw tags
 * @returns {Promise<{ email: string, tags: string[] }>} the address and the normalised tags
 */
export async function subscribe({ email, tags = [] }) {
  const normalizedTags = normalizeTags(tags);
  try {
    await sns().send(
      new SubscribeCommand({
        TopicArn: topicArn(),
        Protocol: 'email',
        Endpoint: email,
        ReturnSubscriptionArn: true,
        Attributes: subscriptionAttributes(normalizedTags),
      }),
    );
  } catch (err) {
    if (isAwsError(err, 'InvalidParameterException')) {
      // SNS refuses to subscribe an endpoint again with different attributes (other tags).
      if (/already exists/i.test(err.message ?? '')) {
        throw conflict('This e-mail address is already subscribed with different tags', 'ALREADY_SUBSCRIBED');
      }
      logger.info('Subscription rejected by Amazon SNS', { reason: err.message });
      throw new AppError(400, 'INVALID_PARAMETER', 'Invalid subscription request');
    }
    if (isAwsError(err, ...SNS_CAPACITY_ERRORS)) throw snsUnavailable(err);
    throw err;
  }
  return { email, tags: normalizedTags };
}

/**
 * Newsletter subscriptions are the e-mail ones, pending or confirmed. Other endpoints (e.g. a queue
 * subscribed by an operator) and SNS placeholders such as "Deleted" are not subscribers.
 */
function isNewsletterSubscription(subscription) {
  const arn = subscription?.SubscriptionArn ?? '';
  const active = arn === PENDING_CONFIRMATION_ARN || arn.startsWith('arn:');
  return active && EMAIL_PROTOCOLS.has(subscription?.Protocol);
}

/**
 * One page of the newsletter subscriptions of the topic.
 * @param {{ cursor?: string }} [options] cursor: SNS NextToken returned with the previous page
 * @returns {Promise<{ subscriptions: object[], nextCursor: string|null }>} raw SNS subscriptions
 */
export async function listSubscriptions({ cursor } = {}) {
  let response;
  try {
    response = await sns().send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn(), NextToken: cursor }),
    );
  } catch (err) {
    if (cursor && isAwsError(err, 'InvalidParameterException')) throw badRequest('Invalid pagination cursor');
    if (isAwsError(err, ...SNS_CAPACITY_ERRORS)) throw snsUnavailable(err);
    throw err;
  }
  return {
    subscriptions: (response?.Subscriptions ?? []).filter(isNewsletterSubscription),
    nextCursor: response?.NextToken ?? null,
  };
}

/** API representation of an SNS subscription. */
export function toApiSubscription(subscription) {
  const pending = subscription.SubscriptionArn === PENDING_CONFIRMATION_ARN;
  return {
    email: subscription.Endpoint,
    status: pending ? SUBSCRIPTION_STATUS.PENDING_CONFIRMATION : SUBSCRIPTION_STATUS.CONFIRMED,
    subscriptionArn: pending ? null : subscription.SubscriptionArn,
  };
}
