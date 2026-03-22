/**
 * Integration test: Content script request attribution.
 *
 * Tests whether fetch() calls from content scripts are correctly
 * attributed as 'cs' source rather than 'page'.
 *
 * Gap #6: CS fetch() runs in the page's network stack. The initiator URL
 * and stack trace may not contain chrome-extension://, causing detectSource()
 * to classify the request as 'page' instead of 'cs'.
 */
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { enableNetworkMonitoring, detectSource } from '../../src/cdp/network.js';
import type { NetworkRequest, SourceLabel } from '../../src/types/events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/content-script-fetch');

describe('Content script attribution', () => {
  it('CS fetch to httpbin.org is captured on the page CDP session', async () => {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        `--disable-extensions-except=${FIXTURE}`,
        `--load-extension=${FIXTURE}`,
        '--no-sandbox',
      ],
      protocolTimeout: 30_000,
    });

    try {
      // Wait for SW
      const bgFilter = (t: any) =>
        t.type() === 'service_worker' && t.url().startsWith('chrome-extension://');
      let sw: any = null;
      for (let i = 0; i < 20; i++) {
        sw = browser.targets().find(bgFilter);
        if (sw) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!sw) sw = await browser.waitForTarget(bgFilter, { timeout: 15_000 });
      const extensionId = new URL(sw.url()).hostname;

      // Monitor page network
      const page = (await browser.pages())[0];
      const pageCdp = await page.createCDPSession();

      const captured: NetworkRequest[] = [];
      await enableNetworkMonitoring(pageCdp, 'page', (req) => {
        if (req.url.includes('httpbin.org')) captured.push(req);
      });

      // Navigate — CS will inject and fetch
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 5000));

      // The CS fetch should appear on the page session
      // (because CS fetches go through the page's network stack)
      expect(captured.length).toBeGreaterThan(0);

      // Check what source label was assigned
      const httpbinReq = captured[0];
      // Document the current behavior:
      // If initiator has chrome-extension:// → 'cs' (correct)
      // If initiator is the page URL → 'page' (incorrect — this is the gap)
      const hasExtensionInitiator =
        httpbinReq.initiator?.url?.includes('chrome-extension://') ||
        httpbinReq.initiator?.stackTrace?.includes('chrome-extension://');

      if (hasExtensionInitiator) {
        expect(httpbinReq.source).toBe('cs');
      } else {
        // Known gap: CS fetch without chrome-extension:// in initiator
        // is misclassified as 'page'. This test documents the gap.
        expect(httpbinReq.source).toBe('page');
        console.warn(
          'CS attribution gap: fetch from content script classified as "page".',
          'Initiator:', httpbinReq.initiator?.url,
        );
      }
    } finally {
      await browser.close();
    }
  });

  it('detectSource correctly identifies CS when initiator has chrome-extension://', () => {
    // When Chrome DOES include extension URL in initiator, we get it right
    expect(detectSource('page', 'chrome-extension://abc/content.js')).toBe('cs');
    expect(detectSource('page', undefined, 'fetch@chrome-extension://abc/content.js:5')).toBe('cs');
  });

  it('CS fetch is NOT captured on SW CDP session (only page session)', async () => {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        `--disable-extensions-except=${FIXTURE}`,
        `--load-extension=${FIXTURE}`,
        '--no-sandbox',
      ],
      protocolTimeout: 30_000,
    });

    try {
      const bgFilter = (t: any) =>
        t.type() === 'service_worker' && t.url().startsWith('chrome-extension://');
      let sw: any = null;
      for (let i = 0; i < 20; i++) {
        sw = browser.targets().find(bgFilter);
        if (sw) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!sw) sw = await browser.waitForTarget(bgFilter, { timeout: 15_000 });

      // Monitor SW network
      const swCdp = await sw.createCDPSession();
      await swCdp.send('Network.enable');

      let swHttpbinCount = 0;
      swCdp.on('Network.requestWillBeSent', (p: any) => {
        if (p.request.url.includes('httpbin.org')) swHttpbinCount++;
      });

      const page = (await browser.pages())[0];
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 5000));

      // CS fetches should NOT appear on the SW session
      // (they go through the page network stack, not the SW)
      expect(swHttpbinCount).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
