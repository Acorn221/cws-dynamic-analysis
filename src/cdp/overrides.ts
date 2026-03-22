/**
 * CDP Fetch-based request/response overrides.
 * Intercepts specific URLs and replaces responses with mocked data.
 * Operates post-TLS inside the browser — undetectable by extensions.
 */
import type { CDPSession } from 'puppeteer';
import { logger } from '../logger.js';

const log = logger.child({ component: 'overrides' });

export interface Override {
  urlPattern: string;
  action: 'mock' | 'block';
  status?: number;
  body?: string;
  contentType?: string;
}

export async function enableOverrides(
  session: CDPSession,
  overrides: Override[],
): Promise<void> {
  if (overrides.length === 0) return;

  const patterns = overrides.map((o) => ({
    urlPattern: o.urlPattern,
    requestStage: o.action === 'block' ? 'Request' as const : 'Response' as const,
  }));

  await session.send('Fetch.enable', { patterns });

  session.on('Fetch.requestPaused', async (event) => {
    const url = event.request.url;
    const requestId = event.requestId;
    const isResponse = 'responseStatusCode' in event;

    const override = overrides.find((o) => matchPattern(o.urlPattern, url));
    if (!override) {
      if (isResponse) {
        await session.send('Fetch.continueResponse', { requestId }).catch(() => {});
      } else {
        await session.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
      return;
    }

    if (override.action === 'block') {
      log.info({ url: url.slice(0, 100) }, 'BLOCKED');
      await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      return;
    }

    if (isResponse) {
      const body = override.body ?? '{}';
      const bodyB64 = Buffer.from(body, 'utf-8').toString('base64');
      const bodyLen = Buffer.byteLength(body, 'utf-8');

      log.info({ url: url.slice(0, 100), bodyLen }, 'MOCKED');

      await session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: override.status ?? 200,
        responseHeaders: [
          { name: 'Content-Type', value: override.contentType ?? 'application/json' },
          { name: 'Content-Length', value: String(bodyLen) },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: bodyB64,
      });
    } else {
      await session.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  });

  log.info({ count: overrides.length }, 'Overrides enabled');
}

function matchPattern(pattern: string, url: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(url);
}
