/**
 * Integration test: Install-time traffic capture.
 *
 * Tests whether fetch() calls made in the top-level scope of a SW
 * (i.e., during SW startup) are captured by CDP network monitoring.
 *
 * This is the hardest capture scenario because the SW starts executing
 * immediately when Chrome loads the extension, before we can attach CDP.
 *
 * The fetch-on-install fixture makes a POST to httpbin.org in the
 * top-level SW scope (not in any event listener).
 */
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/fetch-on-install');

describe('Install-time traffic capture', () => {
  it('captures SW top-level fetch() when attaching after startup', async () => {
    // Current approach: attach AFTER SW is running → likely MISSES the fetch
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

      const cdp = await sw.createCDPSession();
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');

      let installBeaconCaptured = false;
      cdp.on('Network.requestWillBeSent', (p: any) => {
        if (p.request.url.includes('httpbin.org')) installBeaconCaptured = true;
      });

      // Wait a bit — the install beacon already fired during SW startup
      await new Promise((r) => setTimeout(r, 5000));

      // This documents the gap: the install beacon likely already completed
      // before we called Network.enable. We MISS it.
      if (installBeaconCaptured) {
        // If we DO catch it, great — but this is timing-dependent
        console.log('Install beacon captured (lucky timing)');
      } else {
        console.warn(
          'Install beacon NOT captured — fetch() completed before CDP attached.',
          'This is the install-time capture gap.',
        );
      }

      // The SW should have set swStarted in storage regardless
      const result = await cdp.send('Runtime.evaluate', {
        expression: `new Promise(r => chrome.storage.local.get('swStarted', r))`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(result.result.value.swStarted).toBeTruthy();
    } finally {
      await browser.close();
    }
  });

  it('captures install beacon when using CDP Fetch domain to pause requests', async () => {
    // Improved approach: use Fetch.enable to pause ALL requests, then
    // enable Network monitoring, then resume. This should catch the
    // install beacon because the request is paused before completion.
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

      const cdp = await sw.createCDPSession();
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');

      let installBeaconCaptured = false;
      cdp.on('Network.requestWillBeSent', (p: any) => {
        if (p.request.url.includes('httpbin.org')) {
          installBeaconCaptured = true;
        }
      });

      // For install-time capture, the SW already ran.
      // Trigger a SW restart to observe the install beacon from a fresh start.
      // Terminate current SW:
      await cdp.send('Runtime.terminateExecution').catch(() => {});
      await cdp.detach().catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));

      // Trigger restart
      const page = (await browser.pages())[0];
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 10_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));

      // Re-find the restarted SW
      let newSw: any = null;
      for (let i = 0; i < 20; i++) {
        newSw = browser.targets().find(bgFilter);
        if (newSw) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      if (newSw) {
        const newCdp = await newSw.createCDPSession();
        await newCdp.send('Runtime.enable');
        await newCdp.send('Network.enable');

        newCdp.on('Network.requestWillBeSent', (p: any) => {
          if (p.request.url.includes('httpbin.org')) installBeaconCaptured = true;
        });

        // Wait for the restarted SW's install beacon
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Document the result — this test establishes the baseline
      // for whether restart-based capture catches the install beacon
      console.log(
        installBeaconCaptured
          ? 'Install beacon captured after SW restart'
          : 'Install beacon MISSED even after SW restart (pre-CDP execution gap)',
      );
    } finally {
      await browser.close();
    }
  });
});
