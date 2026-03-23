import puppeteer, { type Browser, type CDPSession } from 'puppeteer';
import { type BrowserConfig } from '../types/config.js';
import { STEALTH_ARGS, MAC_UA, applyPageStealth } from './stealth.js';
import { logger } from '../logger.js';

export interface LaunchResult {
  browser: Browser;
  extensionId: string;
}

/**
 * Launch Chrome with an extension loaded.
 * Returns the browser and extension ID once the service worker is detected.
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
    '--disable-sync',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--disable-hang-monitor',
    ...config.extraArgs,
  ];

  if (config.userDataDir) {
    args.push(`--user-data-dir=${config.userDataDir}`);
  }

  log.info({ extensionPath, headless: config.headless }, 'Launching Chrome');

  const browser = await puppeteer.launch({
    headless: config.headless,
    executablePath: config.executablePath,
    args,
    defaultViewport: { width: 1512, height: 982, deviceScaleFactor: 2 }, // MacBook Pro 14" Retina
    protocolTimeout: 30_000,
  });

  // Find extension background target — service_worker (MV3) or background_page (MV2)
  const bgFilter = (t: any) =>
    (t.type() === 'service_worker' || t.type() === 'background_page') &&
    t.url().startsWith('chrome-extension://');

  // Give Chrome time to register extension targets
  await new Promise((r) => setTimeout(r, 3000));

  let swTarget = browser.targets().find(bgFilter);
  if (!swTarget) {
    log.debug('Background target not in existing targets, waiting...');
    try {
      swTarget = await browser.waitForTarget(bgFilter, { timeout: 10_000 });
    } catch {
      log.warn('No background target found after 10s — extension may have no SW/background page');
    }
  } else {
    log.debug({ type: swTarget.type() }, 'Background target found in existing targets');
  }

  // Extract extension ID from the background target URL, or try to find it from any extension target
  let extensionId = 'unknown';
  if (swTarget) {
    extensionId = new URL(swTarget.url()).hostname;
  } else {
    // Fallback: look for ANY chrome-extension:// target
    const anyExtTarget = browser.targets().find((t: any) => t.url().startsWith('chrome-extension://'));
    if (anyExtTarget) {
      extensionId = new URL(anyExtTarget.url()).hostname;
    }
  }
  log.info({ extensionId, hasBgTarget: !!swTarget }, 'Extension loaded');

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

  return { browser, extensionId };
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
