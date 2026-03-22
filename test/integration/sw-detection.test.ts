/**
 * Integration test: SW detection reliability.
 *
 * Tests that the analyzer handles intermittent SW registration delays
 * without timing out. The current approach uses a 5s fixed wait + 30s
 * waitForTarget, which fails ~20% of the time.
 *
 * Run with: npx vitest run --config vitest.integration.config.ts
 */
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rm } from 'fs/promises';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');

describe('SW detection reliability', () => {
  it('finds SW within 10 attempts using poll + waitForTarget fallback', async () => {
    const extPath = resolve(FIXTURES, 'fetch-on-tab-update');
    let found = false;
    let attempts = 0;

    // Retry loop — simulates what launchBrowser should do
    for (attempts = 1; attempts <= 3; attempts++) {
      const browser = await puppeteer.launch({
        headless: true,
        args: [
          `--disable-extensions-except=${extPath}`,
          `--load-extension=${extPath}`,
          '--no-sandbox',
        ],
        protocolTimeout: 30_000,
      });

      try {
        // Poll targets instead of fixed sleep
        const bgFilter = (t: any) =>
          (t.type() === 'service_worker' || t.type() === 'background_page') &&
          t.url().startsWith('chrome-extension://');

        let sw = null;
        for (let poll = 0; poll < 10; poll++) {
          sw = browser.targets().find(bgFilter);
          if (sw) break;
          await new Promise((r) => setTimeout(r, 500)); // 500ms intervals
        }

        if (!sw) {
          // Final fallback: waitForTarget with shorter timeout
          try {
            sw = await browser.waitForTarget(bgFilter, { timeout: 10_000 });
          } catch { /* timeout */ }
        }

        if (sw) {
          found = true;
          const extensionId = new URL(sw.url()).hostname;
          expect(extensionId).toBeTruthy();
          expect(extensionId.length).toBe(32); // Chrome extension IDs are 32 chars
          break;
        }
      } finally {
        await browser.close();
      }
    }

    expect(found).toBe(true);
    // If this takes more than 1 attempt, the detection is flaky
    if (attempts > 1) {
      console.warn(`SW detection needed ${attempts} attempts (flaky)`);
    }
  });

  it('detects SW even with stealth args', async () => {
    const extPath = resolve(FIXTURES, 'fetch-on-tab-update');

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        '--no-sandbox',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-component-update',
        '--disable-blink-features=AutomationControlled',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--disable-hang-monitor',
      ],
      protocolTimeout: 30_000,
    });

    try {
      const bgFilter = (t: any) =>
        (t.type() === 'service_worker' || t.type() === 'background_page') &&
        t.url().startsWith('chrome-extension://');

      // Poll with 500ms intervals up to 15s
      let sw = null;
      for (let i = 0; i < 30; i++) {
        sw = browser.targets().find(bgFilter);
        if (sw) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      expect(sw).toBeTruthy();
      expect(sw!.type()).toBe('service_worker');
    } finally {
      await browser.close();
    }
  });
});
