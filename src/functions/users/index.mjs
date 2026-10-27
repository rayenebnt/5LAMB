// Profiles (GET/PATCH /me, public GET /authors/{userId}) and user administration
// (GET/POST /users, PATCH /users/{userId}: permission user:manage, i.e. administrators).

import {
  getOrCreateProfile,
  getProfile,
  inviteUser,
  listUsers,
  toApiMe,
  toPublicProfile,
  updateProfile,
  updateUser,
} from '../../domain/users.mjs';
import { ALL_ROLES, assertCan, PERMISSIONS } from '../../lib/auth.mjs';
import { notFound } from '../../lib/errors.mjs';
import { cacheHeaders, created, createApiHandler, ok } from '../../lib/http.mjs';
import { schemas, validate, z } from '../../lib/validation.mjs';

/** PATCH bodies must change at least one field. */
const requireAtLeastOneField = (schema) =>
  schema.refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one field must be provided',
  });

const name = z.string().trim().min(1, 'Name is required').max(80);
const role = z.enum(ALL_ROLES);

/** Path parameter: a Cognito sub (lower-cased, as issued by Cognito). */
const userIdParams = z.object({ userId: schemas.uuid.transform((value) => value.toLowerCase()) });

const updateMeSchema = requireAtLeastOneField(
  z.strictObject({
    name: name.optional(),
    // An empty biography is stored as null (a single representation of "no biography").
    bio: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .optional()
      .transform((value) => (value === '' ? null : value)),
    avatarUrl: schemas.httpsUrl.nullable().optional(),
    website: schemas.httpsUrl.nullable().optional(),
  }),
);

const listUsersQuery = z.strictObject({
  limit: schemas.limit(60, 20),
  cursor: schemas.cursor,
  role: role.optional(),
});

const inviteSchema = z.strictObject({ email: schemas.email, name, role });

const updateUserSchema = requireAtLeastOneField(
  z.strictObject({ role: role.optional(), enabled: z.boolean().optional() }),
);

async function getMe(req) {
  const profile = await getOrCreateProfile(req.identity);
  return ok(toApiMe(profile, req.identity), cacheHeaders(req.identity));
}

async function updateMe(req) {
  const changes = validate(updateMeSchema, req.body);
  const profile = await updateProfile(req.identity, changes);
  return ok(toApiMe(profile, req.identity), cacheHeaders(req.identity));
}

async function getAuthor(req) {
  const { userId } = validate(userIdParams, req.params);
  const profile = await getProfile(userId);
  if (!profile) throw notFound('Author not found');
  return ok(toPublicProfile(profile), cacheHeaders(null));
}

async function listAllUsers(req) {
  assertCan(req.identity, PERMISSIONS.USER_MANAGE);
  const query = validate(listUsersQuery, req.query);
  return ok(await listUsers(query), cacheHeaders(req.identity));
}

async function createUser(req) {
  assertCan(req.identity, PERMISSIONS.USER_MANAGE);
  const input = validate(inviteSchema, req.body);
  const user = await inviteUser(input, req.identity);
  return created(user, `/users/${user.id}`);
}

async function patchUser(req) {
  assertCan(req.identity, PERMISSIONS.USER_MANAGE);
  const { userId } = validate(userIdParams, req.params);
  const changes = validate(updateUserSchema, req.body);
  return ok(await updateUser(req.identity, userId, changes));
}

export const routes = {
  'GET /me': { auth: 'required', handler: getMe },
  'PATCH /me': { auth: 'required', handler: updateMe },
  'GET /authors/{userId}': { auth: 'none', handler: getAuthor },
  'GET /users': { auth: 'required', handler: listAllUsers },
  'POST /users': { auth: 'required', handler: createUser },
  'PATCH /users/{userId}': { auth: 'required', handler: patchUser },
};

export const handler = createApiHandler(routes);
