// Newsletter subscriptions: public sign-up and administrator listing.
// A subscriber receives an e-mail for every new post, or only for the posts having one of the
// tags they chose (SNS filter policy on the "tags" message attribute set by the notifier).

import { assertCan, PERMISSIONS } from '../../lib/auth.mjs';
import { accepted, cacheHeaders, createApiHandler, ok } from '../../lib/http.mjs';
import { normalizeTag } from '../../lib/text.mjs';
import { schemas, validate, z } from '../../lib/validation.mjs';
import {
  listSubscriptions,
  subscribe,
  SUBSCRIPTION_STATUS,
  toApiSubscription,
} from '../../domain/notifications.mjs';

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TAG_LENGTH)
  .refine((tag) => normalizeTag(tag) !== '', 'Tag must contain at least one letter or digit');

const subscribeSchema = z.strictObject({
  email: schemas.email,
  tags: z.array(tagSchema).max(MAX_TAGS, `At most ${MAX_TAGS} tags are allowed`).optional(),
});

const listQuerySchema = z.strictObject({ cursor: schemas.cursor });

/** POST /subscriptions (public): starts an e-mail subscription confirmed by the subscriber. */
async function createSubscription(req) {
  const { email, tags } = await subscribe(validate(subscribeSchema, req.body));
  // SNS answers alike whether or not the address was already subscribed with the same tags,
  // so the response never reveals who is subscribed.
  return accepted({
    email,
    tags,
    status: SUBSCRIPTION_STATUS.PENDING_CONFIRMATION,
    message: 'Check your inbox (and spam folder) to confirm your subscription.',
  });
}

/** GET /subscriptions (administrators): newsletter subscribers, one SNS page at a time. */
async function getSubscriptions(req) {
  assertCan(req.identity, PERMISSIONS.SUBSCRIPTION_READ);
  const { cursor } = validate(listQuerySchema, req.query);
  const { subscriptions, nextCursor } = await listSubscriptions({ cursor });
  return ok({ items: subscriptions.map(toApiSubscription), nextCursor }, cacheHeaders(req.identity));
}

export const routes = {
  'POST /subscriptions': { auth: 'none', handler: createSubscription },
  'GET /subscriptions': { auth: 'required', handler: getSubscriptions },
};

export const handler = createApiHandler(routes);
