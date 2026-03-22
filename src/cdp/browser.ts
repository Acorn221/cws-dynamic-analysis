import puppeteer, { type Browser, type CDPSession } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteerExtra from 'puppeteer-extra';
import { type BrowserConfig } from '../types/config.js';
import { STEALTH_ARGS, MAC_UA, applyPageStealth } from './stealth.js';
import { logger } from '../logger.js';

puppeteerExtra.use(StealthPlugin());

export interface LaunchResult {
  browser: Browser;
  extensionId: string;
  browserSession: CDPSession;
}

/**
 * Launch Chrome with an extension loaded and return the browser instance
 * plus a browser-level CDP session with auto-attach configured.
 */
export async function launchBrowser(
  extensionPath: string,
  config: BrowserConfig,
): Promise<LaunchResult> {
  const log = logger.child({ component: 'browser' });

  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    ...STEALTH_ARGS,
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--disable-hang-monitor',
    ...config.extraArgs,
  ];

  if (config.userDataDir) {
    args.push(`--user-data-dir=${config.userDataDir}`);
  }

  const launchFn = config.stealth ? puppeteerExtra.launch : puppeteer.launch;

  log.info({ extensionPath, headless: config.headless }, 'Launching Chrome');

  const browser = await launchFn.call(
    config.stealth ? puppeteerExtra : puppeteer,
    {
      headless: config.headless,
      executablePath: config.executablePath,
      args,
      defaultViewport: { width: 1512, height: 982, deviceScaleFactor: 2 }, // MacBook Pro 14" Retina
      protocolTimeout: 30_000,
    },
  );

  // Find extension service worker — check existing targets first,
  // then wait for new ones if not found yet
  const swFilter = (t: any) =>
    t.type() === 'service_worker' && t.url().startsWith('chrome-extension://');

  // Give Chrome a moment to register targets after launch
  await new Promise((r) => setTimeout(r, 2000));

  let swTarget = browser.targets().find(swFilter);
  if (!swTarget) {
    log.debug('SW not in existing targets, waiting...');
    swTarget = await browser.waitForTarget(swFilter, { timeout: 30_000 });
  } else {
    log.debug('SW found in existing targets');
  }

  // Extract extension ID from the service worker URL
  const extensionId = new URL(swTarget.url()).hostname;
  log.info({ extensionId }, 'Extension loaded');

  // Apply page-level stealth to all pages + auto-apply to new ones
  for (const p of await browser.pages()) {
    await applyPageStealth(p).catch(() => {});
  }
  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const p = await target.page().catch(() => null);
      if (p) await applyPageStealth(p).catch(() => {});
    }
  });

  // Create browser-level CDP session for auto-attach
  const browserSession = await (browser as any)
    .target()
    .createCDPSession() as CDPSession;

  return { browser, extensionId, browserSession };
}

/**
 * Gracefully shut down the browser
 */
export async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // Force kill if graceful close fails
    browser.process()?.kill('SIGKILL');
  }
}
