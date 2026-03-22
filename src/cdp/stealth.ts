/**
 * Stealth configuration — makes headless Chrome look like a real Mac user.
 * Applied to both interact sessions and run browser launches.
 */
import type { Page } from 'puppeteer';

export const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Chrome args that reduce automation fingerprints */
export const STEALTH_ARGS = [
  '--no-sandbox',
  '--no-first-run',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-blink-features=AutomationControlled',
  `--user-agent=${MAC_UA}`,
];

/**
 * Apply page-level stealth patches after page creation.
 * Fixes navigator properties that Chrome args alone don't cover.
 */
export async function applyPageStealth(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    // navigator.webdriver = false (not undefined — real Chrome has it as false)
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // navigator.platform = MacIntel
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });

    // navigator.userAgentData (Chrome 90+)
    if ('userAgentData' in navigator) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: [
            { brand: 'Google Chrome', version: '131' },
            { brand: 'Chromium', version: '131' },
            { brand: 'Not_A Brand', version: '24' },
          ],
          mobile: false,
          platform: 'macOS',
          getHighEntropyValues: async () => ({
            architecture: 'x86',
            model: '',
            platform: 'macOS',
            platformVersion: '15.2.0',
            uaFullVersion: '131.0.0.0',
          }),
        }),
      });
    }

    // navigator.languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-GB', 'en-US', 'en'],
    });

    // navigator.plugins (headless has empty array)
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5], // just needs to be non-empty
    });

    // chrome.runtime should exist (it does in extensions, but pages check for it)
    if (!window.chrome) (window as any).chrome = {};
    if (!window.chrome.runtime) (window as any).chrome.runtime = {};

    // WebGL renderer — headless shows SwiftShader/llvmpipe
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      if (param === 37445) return 'Google Inc. (Apple)';        // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'ANGLE (Apple, Apple M1, OpenGL 4.1)'; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, param);
    };
  });
}
