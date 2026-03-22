/**
 * Integration test: Cookie-gated extension behavior.
 *
 * Tests that extensions gated behind login cookies can be triggered
 * by injecting cookies via CDP before browsing.
 *
 * Gap: Extensions like Ad Skipper Prime Video (checks x-main cookie),
 * Similarweb (checks localStorage auth) are dormant without login.
 */
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rm } from 'fs/promises';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/cookie-gated');

async function launchWithExtension() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      `--disable-extensions-except=${FIXTURE}`,
      `--load-extension=${FIXTURE}`,
      '--no-sandbox',
    ],
    protocolTimeout: 30_000,
  });

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

  return { browser, sw };
}

describe('Cookie-gated extensions', () => {
  it('extension is dormant WITHOUT auth cookie', async () => {
    const { browser, sw } = await launchWithExtension();

    try {
      const cdp = await sw.createCDPSession();
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');

      let bgswCount = 0;
      cdp.on('Network.requestWillBeSent', (p: any) => {
        if (p.request.url.includes('httpbin.org')) bgswCount++;
      });

      const page = (await browser.pages())[0];
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 3000));

      // Without the cookie, extension should be dormant
      expect(bgswCount).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it('extension exfils WITH auth cookie injected via CDP', async () => {
    const { browser, sw } = await launchWithExtension();

    try {
      const cdp = await sw.createCDPSession();
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');

      let bgswCount = 0;
      cdp.on('Network.requestWillBeSent', (p: any) => {
        if (p.request.url.includes('httpbin.org')) bgswCount++;
      });

      // Inject the auth cookie via CDP BEFORE navigating
      const page = (await browser.pages())[0];
      const pageCdp = await page.createCDPSession();
      await pageCdp.send('Network.setCookie', {
        name: 'x-session-token',
        value: 'test-auth-token-12345',
        domain: '.example.com',
        path: '/',
        httpOnly: false,
        secure: false,
      });

      await page.goto('https://example.com', { waitUntil: 'load', timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 3000));

      // With the cookie, extension should exfil
      expect(bgswCount).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});
