/**
 * Extension interaction phase — opens the extension's popup and options
 * pages to trigger activation. Actual intelligent interaction (clicking
 * through onboarding, accepting ToS, etc.) is handled by the subagent
 * via `da interact` commands, not by this module.
 */
import type { Page, Browser } from 'puppeteer';
import { logger } from '../logger.js';

const log = logger.child({ component: 'ext-interact' });

interface InteractConfig {
  extensionId: string;
}

/**
 * Open extension popup and options pages to trigger activation.
 * Pages are opened, given time to render/initialize, then closed.
 */
export async function interactWithExtension(
  browser: Browser,
  config: InteractConfig,
): Promise<{ turns: number; actions: string[] }> {
  const actions: string[] = [];

  const pagePaths = ['popup.html', 'options.html'];

  // Get the SW CDP session to create tabs
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes(config.extensionId),
    { timeout: 5000 },
  ).catch(() => null);

  for (const pagePath of pagePaths) {
    let page: Page | null = null;
    try {
      if (swTarget) {
        // Open via chrome.tabs.create (works reliably for extension pages)
        const swCdp = await swTarget.createCDPSession();
        await swCdp.send('Runtime.enable');
        await swCdp.send('Runtime.evaluate', {
          expression: `chrome.tabs.create({url: chrome.runtime.getURL('${pagePath}')})`,
          awaitPromise: true,
        });
        await swCdp.detach().catch(() => {});

        // Wait for the new tab to appear
        await new Promise((r) => setTimeout(r, 3000));

        // Find the newly opened extension page
        const pages = await browser.pages();
        page = pages.find((p) => p.url().includes(pagePath)) ?? null;
      }

      if (!page) {
        // Fallback: try direct navigation
        page = await browser.newPage();
        await page.goto(`chrome-extension://${config.extensionId}/${pagePath}`, {
          waitUntil: 'load',
          timeout: 8000,
        }).catch(() => null);
      }

      if (!page) continue;

      log.info({ url: page.url() }, 'Extension page opened');

      // Wait for JS frameworks to render and extension to self-activate
      await page.evaluate(() => new Promise((r) => setTimeout(r, 3000)));

      const elementCount = await page.evaluate(() => document.querySelectorAll('*').length).catch(() => 0);
      log.info({ url: page.url(), elementCount }, 'Extension page rendered');
    } catch (err: any) {
      log.warn({ pagePath, err: err.message }, 'Extension page interaction failed');
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  return { turns: 0, actions };
}
