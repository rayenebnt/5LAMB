// Minimal structured logger.
// Lambda functions use LoggingConfig.LogFormat=JSON: objects passed to console.* are
// emitted as structured JSON (with timestamp, level and requestId added by the runtime).

import { config } from './config.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function enabled(level) {
  const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
  return LEVELS[level] >= threshold;
}

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

function write(level, message, fields = {}) {
  if (!enabled(level)) return;
  const entry = { message, ...fields };
  if (entry.error) entry.error = serializeError(entry.error);
  const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : console[level];
  fn(entry);
}

export const logger = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};
