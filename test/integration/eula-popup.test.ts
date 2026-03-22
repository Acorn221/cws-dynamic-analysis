/**
 * Integration test: EULA/popup click reliability.
 *
 * Tests that the interact flow can open extension popups and click
 * buttons to accept EULA/ToS, activating gated behavior.
 *
 * Gap: Smart Adblocker's EULA couldn't be clicked. page.evaluate(el.click())
 * doesn't fire Vue/React handlers. Need to verify multiple click strategies.
 */
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/eula-popup');

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
  return { browser, sw, extensionId };
}

describe('EULA popup interaction', () => {
  it('extension is dormant without EULA acceptance', async () => {
    const { browser, sw } = await launchWithExtension();
    try {
      const cdp = await sw.createCDPSession();
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');

      let exfilCount = 0;
      cdp.on('Network.requestWillBeSent', (p: any) => {
        if (p.request.url.includes('httpbin.org')) exfilCount++;
      });

      const page = (await browser.pages())[0];
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 3000));

      expect(exfilCount).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it('can open popup via chrome.tabs.create and click EULA button', async () => {
    const { browser, sw, extensionId } = await launchWithExtension();
    try {
      // Open popup page via SW (same approach as interact.ts)
      const swCdp = await sw.createCDPSession();
      await swCdp.send('Runtime.enable');
      await swCdp.send('Runtime.evaluate', {
        expression: `chrome.tabs.create({url: chrome.runtime.getURL('popup.html')})`,
        awaitPromise: true,
      });
      await new Promise((r) => setTimeout(r, 2000));

      // Find the popup page
      const pages = await browser.pages();
      const popupPage = pages.find((p) => p.url().includes('popup.html'));
      expect(popupPage).toBeTruthy();

      // Verify the EULA button exists
      const btnText = await popupPage!.evaluate(() => {
        const btn = document.getElementById('accept-btn');
        return btn?.textContent;
      });
      expect(btnText).toContain('Accept');

      // Click using evaluate (same as our interact.ts)
      await popupPage!.evaluate(() => {
        const btn = document.getElementById('accept-btn') as HTMLElement;
        btn?.click();
      });
      await new Promise((r) => setTimeout(r, 1000));

      // Verify storage was set
      const result = await swCdp.send('Runtime.evaluate', {
        expression: `new Promise(r => chrome.storage.local.get('eulaAccepted', r))`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(result.result.value).toEqual({ eulaAccepted: true });
    } finally {
      await browser.close();
    }
  });

  it('exfils AFTER EULA acceptance + navigation', async () => {
    const { browser, sw, extensionId } = await launchWithExtension();
    try {
      const swCdp = await sw.createCDPSession();
      await swCdp.send('Runtime.enable');
      await swCdp.send('Network.enable');

      let exfilCount = 0;
      swCdp.on('Network.requestWillBeSent', (p: any) => {
        if (p.request.url.includes('httpbin.org')) exfilCount++;
      });

      // Accept EULA via popup
      await swCdp.send('Runtime.evaluate', {
        expression: `chrome.tabs.create({url: chrome.runtime.getURL('popup.html')})`,
        awaitPromise: true,
      });
      await new Promise((r) => setTimeout(r, 2000));
      const pages = await browser.pages();
      const popupPage = pages.find((p) => p.url().includes('popup.html'));
      await popupPage!.evaluate(() => {
        (document.getElementById('accept-btn') as HTMLElement)?.click();
      });
      await new Promise((r) => setTimeout(r, 1000));

      // Now navigate — exfil should trigger
      const page = (await browser.pages())[0];
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 3000));

      expect(exfilCount).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  it('dispatchEvent MouseEvent click works as fallback', async () => {
    // Some frameworks (Vue, React) don't respond to el.click() because
    // their event listeners use capture phase or synthetic events.
    // dispatchEvent(new MouseEvent(...)) is more reliable.
    const { browser, sw, extensionId } = await launchWithExtension();
    try {
      const swCdp = await sw.createCDPSession();
      await swCdp.send('Runtime.enable');

      await swCdp.send('Runtime.evaluate', {
        expression: `chrome.tabs.create({url: chrome.runtime.getURL('popup.html')})`,
        awaitPromise: true,
      });
      await new Promise((r) => setTimeout(r, 2000));

      const pages = await browser.pages();
      const popupPage = pages.find((p) => p.url().includes('popup.html'));

      // Use dispatchEvent instead of el.click()
      await popupPage!.evaluate(() => {
        const btn = document.getElementById('accept-btn');
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await new Promise((r) => setTimeout(r, 1000));

      const result = await swCdp.send('Runtime.evaluate', {
        expression: `new Promise(r => chrome.storage.local.get('eulaAccepted', r))`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(result.result.value).toEqual({ eulaAccepted: true });
    } finally {
      await browser.close();
    }
  });
});
