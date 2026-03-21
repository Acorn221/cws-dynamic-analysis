/**
 * Scenario engine — runs the 7-phase browsing scenario against
 * a Chrome instance with an extension loaded.
 */
import type { Page } from 'puppeteer';
import type { ScenarioConfig, PhaseId } from '../types/config.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'scenario' });

export type PhaseRunner = (page: Page, config: ScenarioConfig) => Promise<void>;

const phases: Record<PhaseId, PhaseRunner> = {
  install: runInstallPhase,
  browse: runBrowsePhase,
  login: runLoginPhase,
  banking: runBankingPhase,
  shopping: runShoppingPhase,
  idle: runIdlePhase,
  tabs: runTabsPhase,
};

/**
 * Execute the full scenario sequence on the given page.
 */
export async function runScenario(
  page: Page,
  config: ScenarioConfig,
): Promise<void> {
  const startTime = Date.now();

  for (const phaseId of config.phases) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= config.maxDuration) {
      log.warn({ elapsed }, 'Max duration reached, stopping scenario');
      break;
    }

    const runner = phases[phaseId];
    if (!runner) {
      log.warn({ phaseId }, 'Unknown phase, skipping');
      continue;
    }

    const phaseDuration = config.phaseDurations[phaseId] ?? 60;
    log.info({ phaseId, phaseDuration }, 'Starting phase');

    try {
      await Promise.race([
        runner(page, config),
        sleep(phaseDuration * 1000),
      ]);
    } catch (err) {
      log.error({ err, phaseId }, 'Phase failed');
    }

    log.info({ phaseId }, 'Phase complete');
  }
}

// --- Phase implementations ---

async function runInstallPhase(page: Page, _config: ScenarioConfig): Promise<void> {
  // Just wait — observe extension onInstalled behavior, initial beacons
  await page.goto('about:blank');
  await sleep(5000);
  // Navigate to a simple page to trigger content scripts
  await page.goto('https://www.example.com', { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(10000);
}

async function runBrowsePhase(page: Page, config: ScenarioConfig): Promise<void> {
  for (const site of config.browsingSites) {
    try {
      await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Simulate reading — scroll down, dwell
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await sleep(randomBetween(3000, 8000));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(randomBetween(2000, 5000));
    } catch (err) {
      log.warn({ site, err }, 'Failed to load site in browse phase');
    }
  }
}

async function runLoginPhase(page: Page, _config: ScenarioConfig): Promise<void> {
  // Navigate to our canary login page
  // TODO: Serve canary pages locally and navigate there
  log.info('Login phase — canary form fill (stub)');
  await sleep(5000);
}

async function runBankingPhase(page: Page, _config: ScenarioConfig): Promise<void> {
  log.info('Banking phase — canary account data (stub)');
  await sleep(5000);
}

async function runShoppingPhase(page: Page, _config: ScenarioConfig): Promise<void> {
  log.info('Shopping phase — canary CC data (stub)');
  await sleep(5000);
}

async function runIdlePhase(page: Page, _config: ScenarioConfig): Promise<void> {
  // Leave browser idle on a benign page — detect delayed/scheduled behavior
  await page.goto('https://www.wikipedia.org', { waitUntil: 'networkidle2', timeout: 15000 });
  log.info('Idle phase — monitoring for delayed behavior');
  // The phase duration timer handles the wait
  await sleep(60000);
}

async function runTabsPhase(page: Page, _config: ScenarioConfig): Promise<void> {
  const browser = page.browser();
  const sites = [
    'https://www.google.com',
    'https://www.github.com',
    'https://news.ycombinator.com',
    'https://www.stackoverflow.com',
    'https://www.twitter.com',
  ];

  // Open tabs rapidly
  const pages: Page[] = [];
  for (const site of sites) {
    try {
      const newPage = await browser.newPage();
      pages.push(newPage);
      await newPage.goto(site, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(randomBetween(1000, 3000));
    } catch (err) {
      log.warn({ site, err }, 'Failed to open tab');
    }
  }

  await sleep(5000);

  // Close tabs
  for (const p of pages) {
    try { await p.close(); } catch { /* ignore */ }
    await sleep(randomBetween(500, 1500));
  }
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
