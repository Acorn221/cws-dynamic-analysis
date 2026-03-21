/**
 * Scenario engine — runs the 7-phase browsing scenario against
 * a Chrome instance with an extension loaded.
 */
import type { Page } from 'puppeteer';
import type { ScenarioConfig, PhaseId, CanaryConfig } from '../types/config.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'scenario' });

/**
 * Execute the full scenario sequence on the given page.
 */
export async function runScenario(
  page: Page,
  config: ScenarioConfig,
  canary: CanaryConfig,
  canaryPort: number,
): Promise<void> {
  const startTime = Date.now();
  const canaryBase = `http://127.0.0.1:${canaryPort}`;

  for (const phaseId of config.phases) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= config.maxDuration) {
      log.warn({ elapsed }, 'Max duration reached, stopping scenario');
      break;
    }

    const phaseDuration = config.phaseDurations[phaseId] ?? 60;
    log.info({ phaseId, phaseDuration }, 'Starting phase');

    try {
      await Promise.race([
        runPhase(phaseId, page, config, canary, canaryBase),
        sleep(phaseDuration * 1000),
      ]);
    } catch (err) {
      log.error({ err, phaseId }, 'Phase failed');
    }

    log.info({ phaseId }, 'Phase complete');
  }
}

async function runPhase(
  phaseId: PhaseId,
  page: Page,
  config: ScenarioConfig,
  canary: CanaryConfig,
  canaryBase: string,
): Promise<void> {
  switch (phaseId) {
    case 'install':
      return runInstallPhase(page);
    case 'browse':
      return runBrowsePhase(page, config);
    case 'login':
      return runLoginPhase(page, canary, canaryBase);
    case 'banking':
      return runBankingPhase(page, canary, canaryBase);
    case 'shopping':
      return runShoppingPhase(page, canary, canaryBase);
    case 'idle':
      return runIdlePhase(page);
    case 'tabs':
      return runTabsPhase(page);
  }
}

// --- Phase implementations ---

async function runInstallPhase(page: Page): Promise<void> {
  await page.goto('about:blank');
  await sleep(3000);
  await page.goto('https://www.example.com', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await sleep(5000);
}

async function runBrowsePhase(page: Page, config: ScenarioConfig): Promise<void> {
  for (const site of config.browsingSites) {
    try {
      log.debug({ site }, 'Visiting site');
      await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await sleep(randomBetween(2000, 5000));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(randomBetween(1000, 3000));
    } catch (err) {
      log.warn({ site }, 'Failed to load site');
    }
  }
}

async function runLoginPhase(
  page: Page,
  canary: CanaryConfig,
  canaryBase: string,
): Promise<void> {
  log.info('Navigating to canary login page');
  await page.goto(`${canaryBase}/login`, { waitUntil: 'networkidle2', timeout: 10000 });
  await sleep(1000);

  // Type email with human-like delays
  await humanType(page, '#email', canary.email);
  await sleep(500);

  // Type password
  await humanType(page, '#password', canary.password);
  await sleep(500);

  // Click remember me
  await page.click('#remember').catch(() => {});
  await sleep(300);

  // Submit the form
  log.info('Submitting canary login form');
  await page.click('button[type="submit"]').catch(() => {});
  await sleep(3000);
}

async function runBankingPhase(
  page: Page,
  canary: CanaryConfig,
  canaryBase: string,
): Promise<void> {
  log.info('Navigating to canary banking page');
  await page.goto(`${canaryBase}/banking`, { waitUntil: 'networkidle2', timeout: 10000 });
  await sleep(2000);

  // Scroll through account info (extensions may scrape visible data)
  await page.evaluate(() => window.scrollTo(0, 300));
  await sleep(2000);

  // Fill transfer form
  await humanType(page, '#toAccount', '9876543210');
  await sleep(300);
  await humanType(page, '#routingNumber', '021000021');
  await sleep(300);
  await humanType(page, '#amount', '500.00');
  await sleep(500);

  log.info('Submitting canary transfer form');
  await page.click('button[type="submit"]').catch(() => {});
  await sleep(3000);
}

async function runShoppingPhase(
  page: Page,
  canary: CanaryConfig,
  canaryBase: string,
): Promise<void> {
  log.info('Navigating to canary checkout page');
  await page.goto(`${canaryBase}/checkout`, { waitUntil: 'networkidle2', timeout: 10000 });
  await sleep(1000);

  // Fill payment form with canary CC data
  await humanType(page, '#cardName', 'Test Canary User');
  await sleep(300);
  await humanType(page, '#cardNumber', canary.creditCard);
  await sleep(300);
  await humanType(page, '#expiry', '12/28');
  await sleep(300);
  await humanType(page, '#cvv', '123');
  await sleep(300);

  // Billing address
  await humanType(page, '#address', '123 Canary Street');
  await sleep(300);
  await humanType(page, '#city', 'Canaryville');
  await sleep(300);
  await humanType(page, '#zip', '90210');
  await sleep(500);

  log.info('Submitting canary checkout form');
  await page.click('button[type="submit"]').catch(() => {});
  await sleep(3000);
}

async function runIdlePhase(page: Page): Promise<void> {
  await page.goto('https://en.wikipedia.org/wiki/Browser_extension', {
    waitUntil: 'networkidle2',
    timeout: 15000,
  }).catch(() => {});
  log.info('Idle phase — monitoring for delayed behavior');
  // Phase duration timer in runScenario handles the wait
  await sleep(60_000);
}

async function runTabsPhase(page: Page): Promise<void> {
  const browser = page.browser();
  const sites = [
    'https://www.google.com/search?q=bank+account+login',
    'https://www.github.com',
    'https://news.ycombinator.com',
    'https://www.reddit.com/r/programming',
    'https://mail.google.com',
  ];

  const openPages: Page[] = [];
  for (const site of sites) {
    try {
      const p = await browser.newPage();
      openPages.push(p);
      await p.goto(site, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      await sleep(randomBetween(800, 2000));
    } catch (err) {
      log.warn({ site }, 'Failed to open tab');
    }
  }

  await sleep(3000);

  for (const p of openPages) {
    try { await p.close(); } catch { /* ignore */ }
    await sleep(randomBetween(300, 800));
  }
}

// --- Helpers ---

/**
 * Type text character by character with human-like delays.
 * This is important because keylogger extensions hook keydown/keyup events.
 */
async function humanType(page: Page, selector: string, text: string): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout: 5000 });
    await page.click(selector);
    await page.type(selector, text, { delay: randomBetween(50, 150) });
  } catch (err) {
    log.warn({ selector }, 'Failed to type into field');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
