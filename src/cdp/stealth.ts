/**
 * Stealth configuration — emulates a MacBook Pro 14" M1 Pro running
 * Chrome 131 on macOS Sonoma 14.4. Every fingerprint value is sourced
 * from a real device to pass bot detection checks.
 */
import type { Page } from 'puppeteer';

// MacBook Pro 14" M1 Pro, macOS Sonoma 14.4, Chrome 131.0.6778.86
export const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36';

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
 * Apply page-level stealth patches. Must be called before navigating.
 * Covers every fingerprint vector that bot detection frameworks check.
 */
export async function applyPageStealth(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    // ---- navigator core properties ----

    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
    Object.defineProperty(navigator, 'language', { get: () => 'en-GB' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 10 }); // M1 Pro: 10 cores
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'doNotTrack', { get: () => null });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

    // ---- navigator.plugins (headless has empty array) ----

    const fakePlugins = {
      length: 5,
      0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      1: { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
      2: { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
      3: { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
      4: { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: '' },
      item: (i: number) => (fakePlugins as any)[i],
      namedItem: (name: string) => Array.from({ length: 5 }, (_, i) => (fakePlugins as any)[i]).find((p: any) => p.name === name),
      refresh: () => {},
      [Symbol.iterator]: function* () { for (let i = 0; i < 5; i++) yield (fakePlugins as any)[i]; },
    };
    Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

    // ---- navigator.userAgentData (Chrome 90+) ----

    const brands = [
      { brand: 'Google Chrome', version: '131' },
      { brand: 'Chromium', version: '131' },
      { brand: 'Not_A Brand', version: '24' },
    ];

    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands,
        mobile: false,
        platform: 'macOS',
        toJSON: () => ({ brands, mobile: false, platform: 'macOS' }),
        getHighEntropyValues: async (hints: string[]) => {
          const values: any = {
            brands,
            mobile: false,
            platform: 'macOS',
          };
          if (hints.includes('architecture')) values.architecture = 'arm';
          if (hints.includes('bitness')) values.bitness = '64';
          if (hints.includes('model')) values.model = '';
          if (hints.includes('platformVersion')) values.platformVersion = '14.4.0';
          if (hints.includes('uaFullVersion')) values.uaFullVersion = '131.0.6778.86';
          if (hints.includes('fullVersionList')) {
            values.fullVersionList = [
              { brand: 'Google Chrome', version: '131.0.6778.86' },
              { brand: 'Chromium', version: '131.0.6778.86' },
              { brand: 'Not_A Brand', version: '24.0.0.0' },
            ];
          }
          return values;
        },
      }),
    });

    // ---- Screen (MacBook Pro 14" logical resolution, Retina) ----

    Object.defineProperty(screen, 'width', { get: () => 1512 });
    Object.defineProperty(screen, 'height', { get: () => 982 });
    Object.defineProperty(screen, 'availWidth', { get: () => 1512 });
    Object.defineProperty(screen, 'availHeight', { get: () => 944 }); // minus dock
    Object.defineProperty(screen, 'colorDepth', { get: () => 30 }); // 10-bit
    Object.defineProperty(screen, 'pixelDepth', { get: () => 30 });
    Object.defineProperty(window, 'devicePixelRatio', { get: () => 2 }); // Retina
    Object.defineProperty(window, 'outerWidth', { get: () => 1512 });
    Object.defineProperty(window, 'outerHeight', { get: () => 944 });

    // ---- WebGL (Apple M1 Pro GPU) ----

    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      if (param === 37445) return 'Google Inc. (Apple)';              // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'ANGLE (Apple, APPLE M1 Pro, OpenGL 4.1)'; // UNMASKED_RENDERER_WEBGL
      return getParam.call(this, param);
    };
    // Also patch WebGL2
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (param: number) {
        if (param === 37445) return 'Google Inc. (Apple)';
        if (param === 37446) return 'ANGLE (Apple, APPLE M1 Pro, OpenGL 4.1)';
        return getParam2.call(this, param);
      };
    }

    // ---- chrome.runtime (exists on real Chrome, missing in some headless) ----

    if (!window.chrome) (window as any).chrome = {};
    if (!window.chrome.runtime) (window as any).chrome.runtime = {};

    // ---- Permissions API (headless may differ) ----

    const origQuery = Permissions.prototype.query;
    Permissions.prototype.query = function (desc: any) {
      if (desc.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus);
      }
      return origQuery.call(this, desc);
    };
  });
}
