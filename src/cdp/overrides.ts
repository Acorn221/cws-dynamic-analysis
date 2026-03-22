/**
 * CDP Fetch-based request/response overrides.
 * Intercepts specific URLs and replaces responses with mocked data.
 * Operates post-TLS inside the browser — undetectable by extensions.
 */
import type { CDPSession } from 'puppeteer';
import { logger } from '../logger.js';

const log = logger.child({ component: 'overrides' });

export interface Override {
  /** URL pattern (wildcards: * = 0+ chars, ? = 1 char) */
  urlPattern: string;
  /** What to do: mock = replace response, block = fail request */
  action: 'mock' | 'block';
  /** For mock: response status code (default 200) */
  status?: number;
  /** For mock: response body (string — will be base64 encoded internally) */
  body?: string;
  /** For mock: content type (default application/json) */
  contentType?: string;
}

/**
 * Enable overrides on a CDP session. Call alongside Network.enable —
 * both can be active simultaneously (Network for passive logging,
 * Fetch for active interception).
 */
export async function enableOverrides(
  session: CDPSession,
  overrides: Override[],
): Promise<void> {
  if (overrides.length === 0) return;

  // Register patterns — intercept at Response stage for mocks (so we can
  // read original headers), Request stage for blocks (don't even send)
  const patterns = overrides.map((o) => ({
    urlPattern: o.urlPattern,
    requestStage: o.action === 'block' ? 'Request' : 'Response',
  }));

  await session.send('Fetch.enable', { patterns } as any);

  // @ts-ignore — CDPSession event type
  session.on('Fetch.requestPaused', async (event: any) => {
    const url: string = event.request.url;
    const requestId: string = event.requestId;
    const isResponseStage = event.responseStatusCode !== undefined;

    // Find matching override
    const override = overrides.find((o) => matchPattern(o.urlPattern, url));
    if (!override) {
      // No match — continue unmodified
      if (isResponseStage) {
        await session.send('Fetch.continueResponse', { requestId } as any).catch(() => {});
      } else {
        await session.send('Fetch.continueRequest', { requestId } as any).catch(() => {});
      }
      return;
    }

    if (override.action === 'block') {
      log.info({ url: url.slice(0, 100), pattern: override.urlPattern }, 'BLOCKED request');
      await session.send('Fetch.failRequest', {
        requestId,
        errorReason: 'BlockedByClient',
      } as any);
      return;
    }

    // Mock response
    if (isResponseStage) {
      const body = override.body ?? '{}';
      const contentType = override.contentType ?? 'application/json';
      const bodyBytes = Buffer.from(body, 'utf-8');

      log.info({
        url: url.slice(0, 100),
        pattern: override.urlPattern,
        bodyLen: bodyBytes.length,
      }, 'MOCKED response');

      await session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: override.status ?? 200,
        responseHeaders: [
          { name: 'Content-Type', value: contentType },
          { name: 'Content-Length', value: String(bodyBytes.length) },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: bodyBytes.toString('base64'),
      } as any);
    } else {
      // Request stage for a mock — continue to response stage
      await session.send('Fetch.continueRequest', { requestId } as any).catch(() => {});
    }
  });

  log.info({ count: overrides.length, patterns: overrides.map((o) => o.urlPattern) }, 'Overrides enabled');
}

/** Simple wildcard pattern matcher (* = any chars, ? = one char) */
function matchPattern(pattern: string, url: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return regex.test(url);
}
