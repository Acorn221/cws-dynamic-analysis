/**
 * Integration test: Agent-driven mode.
 *
 * Verifies that `da run --agent-driven` works end-to-end:
 * - Launches Chrome, instruments SW, waits for agent
 * - Agent navigates via interact commands, extension captures traffic
 * - Agent sends finish signal, post-processing generates reports
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { rm, readFile, writeFile, stat } from 'fs/promises';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');

describe('Agent-driven mode', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    cleanupDirs.length = 0;
  });

  it('captures SW traffic when subagent navigates pages', async () => {
    const fixtureDir = resolve(FIXTURES, 'fetch-on-tab-update');
    const outputDir = `/tmp/cws-test-agent-driven-${Date.now()}`;
    cleanupDirs.push(outputDir);

    // Launch in agent-driven mode
    const { analyze } = await import('../../src/analyzer.js');
    const { defaultConfig } = await import('../../src/types/config.js');

    const config = defaultConfig('test', fixtureDir);
    config.outputDir = outputDir;
    config.browser.headless = true;
    config.browser.stealth = false;
    config.instrument = false;
    config.agentDriven = true;
    config.scenario.maxDuration = 30;
    config.scenario.timeAcceleration = false;

    // Run analyze in background — it will wait for .finish signal
    const analyzePromise = analyze(config);

    // Wait for session.json to appear
    const sessionPath = join(outputDir, 'session.json');
    for (let i = 0; i < 30; i++) {
      try {
        await stat(sessionPath);
        break;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Read session and connect
    const session = JSON.parse(await readFile(sessionPath, 'utf-8'));
    expect(session.wsEndpoint).toBeTruthy();
    expect(session.extensionId).toBeTruthy();

    const browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint });

    // Navigate to a page — this triggers the extension's tabs.onUpdated listener
    const page = await browser.newPage();
    await page.goto('https://www.example.com', { waitUntil: 'load', timeout: 10000 });
    await new Promise(r => setTimeout(r, 2000));

    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    browser.disconnect();

    // Signal finish
    await writeFile(join(outputDir, '.finish'), new Date().toISOString());

    // Wait for analyze to complete
    const result = await analyzePromise;
    expect(result.summary.status).toBe('completed');

    // Verify SW traffic was captured during agent-driven phase
    const db = new Database(resolve(outputDir, 'events.db'), { readonly: true });
    const bgswCount = (db.prepare("SELECT count(*) c FROM requests WHERE source='bgsw'").get() as any).c;
    expect(bgswCount).toBeGreaterThan(0);

    // Verify output files exist
    const summaryExists = await stat(join(outputDir, 'summary.json')).then(() => true).catch(() => false);
    expect(summaryExists).toBe(true);

    const llmSummaryExists = await stat(join(outputDir, 'llm_summary.md')).then(() => true).catch(() => false);
    expect(llmSummaryExists).toBe(true);

    db.close();
  }, 60_000);
});
