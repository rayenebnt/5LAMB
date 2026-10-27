// Application errors are converted to JSON responses by the HTTP router:
// { "error": { "code": "...", "message": "...", "details": [...] }, "requestId": "..." }

export class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status code
   * @param {string} code stable machine-readable error code
   * @param {string} message human readable message
   * @param {unknown} [details] optional extra information (e.g. validation issues)
   */
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message = 'Bad request', details) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const validationError = (details, message = 'Request validation failed') =>
  new AppError(400, 'VALIDATION_ERROR', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message = 'Resource conflict', code = 'CONFLICT') =>
  new AppError(409, code, message);

export const preconditionFailed = (
  message = 'The resource was modified by another request (version mismatch)',
) => new AppError(412, 'PRECONDITION_FAILED', message);

export const payloadTooLarge = (message = 'Payload too large') =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', message);

export const unsupportedMediaType = (message = 'Unsupported media type') =>
  new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message);

export const tooManyRequests = (message = 'Too many requests, please retry later') =>
  new AppError(429, 'TOO_MANY_REQUESTS', message);

export const serviceUnavailable = (message = 'Service temporarily unavailable') =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message);

/** True when an AWS SDK v3 error has the given exception name. */
export function isAwsError(err, ...names) {
  return Boolean(err) && names.includes(err.name);
}
