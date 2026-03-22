/**
 * Integration tests: Service Worker network capture.
 *
 * These launch real Chrome instances with fixture extensions and verify
 * that SW fetch() calls are captured in the events database.
 *
 * Run with: npx vitest run --config vitest.integration.config.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rm, stat } from 'fs/promises';
import puppeteer, { type Browser } from 'puppeteer';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');

// Helper: launch browser with extension, attach to SW, navigate, check DB
async function runFixture(
  fixtureName: string,
  opts: { navigateTo?: string[]; duration?: number } = {},
): Promise<{ db: Database.Database; browser: Browser; outputDir: string }> {
  const fixtureDir = resolve(FIXTURES, fixtureName);
  const outputDir = `/tmp/cws-test-${fixtureName}-${Date.now()}`;

  // Use the CLI to run the full analysis pipeline
  const { analyze } = await import('../../src/analyzer.js');
  const { defaultConfig } = await import('../../src/types/config.js');

  const config = defaultConfig('test', fixtureDir);
  config.outputDir = outputDir;
  config.browser.headless = true;
  config.browser.stealth = false;
  config.instrument = false;
  config.scenario.phases = ['browse'] as any;
  config.scenario.maxDuration = opts.duration ?? 20;
  config.scenario.timeAcceleration = false; // avoid any Date override issues in tests

  await analyze(config);

  const db = new Database(resolve(outputDir, 'events.db'), { readonly: true });
  return { db, browser: null as any, outputDir };
}

describe('SW network capture', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    cleanupDirs.length = 0;
  });

  it('captures fetch-on-tab-update SW requests as bgsw source', async () => {
    const { db, outputDir } = await runFixture('fetch-on-tab-update');
    cleanupDirs.push(outputDir);

    const total = (db.prepare('SELECT count(*) c FROM requests').get() as any).c;
    expect(total).toBeGreaterThan(0);

    const bgsw = (db.prepare("SELECT count(*) c FROM requests WHERE source='bgsw'").get() as any).c;
    expect(bgsw).toBeGreaterThan(0);

    // Verify httpbin.org was the target
    const httpbin = (db.prepare("SELECT count(*) c FROM requests WHERE source='bgsw' AND url LIKE '%httpbin%'").get() as any).c;
    expect(httpbin).toBeGreaterThan(0);

    // Verify POST method
    const posts = db.prepare("SELECT method, url FROM requests WHERE source='bgsw'").all() as any[];
    expect(posts.every((r: any) => r.method === 'POST')).toBe(true);

    db.close();
  });

  it('captures delayed-fetch alarm-based exfiltration', async () => {
    const { db, outputDir } = await runFixture('delayed-fetch', { duration: 30 });
    cleanupDirs.push(outputDir);

    const total = (db.prepare('SELECT count(*) c FROM requests').get() as any).c;
    expect(total).toBeGreaterThan(0);

    // Delayed-fetch uses chrome.alarms for periodic exfil + an initial config fetch
    const bgsw = (db.prepare("SELECT count(*) c FROM requests WHERE source='bgsw'").get() as any).c;
    // At minimum the config fetch should be captured
    expect(bgsw).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it('does not misclassify SW requests as page source', async () => {
    const { db, outputDir } = await runFixture('fetch-on-tab-update');
    cleanupDirs.push(outputDir);

    // Check that httpbin requests are NOT classified as page
    const pageHttpbin = (db.prepare("SELECT count(*) c FROM requests WHERE source='page' AND url LIKE '%httpbin%'").get() as any).c;
    expect(pageHttpbin).toBe(0);

    // But they ARE classified as bgsw
    const bgswHttpbin = (db.prepare("SELECT count(*) c FROM requests WHERE source='bgsw' AND url LIKE '%httpbin%'").get() as any).c;
    expect(bgswHttpbin).toBeGreaterThan(0);

    db.close();
  });
});
