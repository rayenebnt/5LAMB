// Input validation helpers built on zod (v4).

import { z } from 'zod';
import { validationError } from './errors.mjs';

export { z };

/**
 * Validates `data` against a zod schema and returns the parsed (coerced / trimmed) value.
 * Throws a 400 VALIDATION_ERROR AppError listing every issue.
 */
export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => {
    const field = issue.path.length ? issue.path.join('.') : undefined;
    if (issue.code === 'unrecognized_keys') {
      return { field: field ?? '(root)', message: `Unknown field(s): ${issue.keys.join(', ')}` };
    }
    return { field: field ?? '(root)', message: issue.message };
  });
  throw validationError(details);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Common reusable schemas. */
export const schemas = {
  uuid: z.string().regex(UUID_RE, 'Must be a valid identifier (UUID)'),
  /** Page size for list endpoints. */
  limit: (max = 50, fallback = 10) => z.coerce.number().int().min(1).max(max).default(fallback),
  cursor: z.string().min(1).max(2048).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email('Invalid e-mail address')).pipe(z.string().max(254)),
  /** Cognito default policy: 8+ chars with upper, lower and digit. */
  password: z
    .string()
    .min(8, 'Password must contain at least 8 characters')
    .max(256)
    .regex(/[a-z]/, 'Password must contain a lowercase letter')
    .regex(/[A-Z]/, 'Password must contain an uppercase letter')
    .regex(/[0-9]/, 'Password must contain a digit'),
  httpsUrl: z
    .string()
    .trim()
    .max(2048)
    .url('Must be a valid URL')
    .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://'),
};

/** Parses the query string with a schema; missing query string is treated as {}. */
export function validateQuery(schema, query) {
  return validate(schema, query ?? {});
}
