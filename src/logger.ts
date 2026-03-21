import pino from 'pino';

// No colors by default — ANSI codes waste LLM agent tokens.
// Set FORCE_COLOR=1 for human-readable colored output.
const colorize = process.env.FORCE_COLOR === '1';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize } }
      : undefined,
});
