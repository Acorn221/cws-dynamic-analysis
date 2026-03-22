/**
 * Stealth configuration — emulates a MacBook Pro 14" M1 Pro running
 * Chrome 131 on macOS Sonoma 14.4. Every fingerprint value is sourced
 * from a real device to pass bot detection checks.
 */
import type { Page } from 'puppeteer';

export const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36';

export const STEALTH_ARGS = [
  '--no-sandbox',
  '--no-first-run',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-blink-features=AutomationControlled',
  `--user-agent=${MAC_UA}`,
];

/**
 * Browser-context stealth patches injected via evaluateOnNewDocument.
 * Stored as a string to avoid TS checking DOM types in a Node context.
 */
const STEALTH_SCRIPT = `
(function() {
  // navigator
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
  Object.defineProperty(navigator, 'language', { get: () => 'en-GB' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 10 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
  Object.defineProperty(navigator, 'doNotTrack', { get: () => null });
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

  // plugins (headless has empty array)
  var fp = {
    length: 5,
    0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
    1: { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
    2: { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
    3: { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer' },
    4: { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer' },
    item: function(i) { return fp[i]; },
    namedItem: function(n) { for (var i=0;i<5;i++) if (fp[i].name===n) return fp[i]; },
    refresh: function() {},
  };
  fp[Symbol.iterator] = function*() { for (var i=0;i<5;i++) yield fp[i]; };
  Object.defineProperty(navigator, 'plugins', { get: () => fp });

  // userAgentData
  var brands = [
    { brand: 'Google Chrome', version: '131' },
    { brand: 'Chromium', version: '131' },
    { brand: 'Not_A Brand', version: '24' },
  ];
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => ({
      brands: brands,
      mobile: false,
      platform: 'macOS',
      toJSON: () => ({ brands: brands, mobile: false, platform: 'macOS' }),
      getHighEntropyValues: async (hints) => {
        var v = { brands: brands, mobile: false, platform: 'macOS' };
        if (hints.includes('architecture')) v.architecture = 'arm';
        if (hints.includes('bitness')) v.bitness = '64';
        if (hints.includes('model')) v.model = '';
        if (hints.includes('platformVersion')) v.platformVersion = '14.4.0';
        if (hints.includes('uaFullVersion')) v.uaFullVersion = '131.0.6778.86';
        if (hints.includes('fullVersionList')) v.fullVersionList = [
          { brand: 'Google Chrome', version: '131.0.6778.86' },
          { brand: 'Chromium', version: '131.0.6778.86' },
          { brand: 'Not_A Brand', version: '24.0.0.0' },
        ];
        return v;
      },
    }),
  });

  // screen (MacBook Pro 14")
  Object.defineProperty(screen, 'width', { get: () => 1512 });
  Object.defineProperty(screen, 'height', { get: () => 982 });
  Object.defineProperty(screen, 'availWidth', { get: () => 1512 });
  Object.defineProperty(screen, 'availHeight', { get: () => 944 });
  Object.defineProperty(screen, 'colorDepth', { get: () => 30 });
  Object.defineProperty(screen, 'pixelDepth', { get: () => 30 });
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 2 });
  Object.defineProperty(window, 'outerWidth', { get: () => 1512 });
  Object.defineProperty(window, 'outerHeight', { get: () => 944 });

  // WebGL (Apple M1 Pro)
  var gp = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    if (p === 37445) return 'Google Inc. (Apple)';
    if (p === 37446) return 'ANGLE (Apple, APPLE M1 Pro, OpenGL 4.1)';
    return gp.call(this, p);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    var gp2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Google Inc. (Apple)';
      if (p === 37446) return 'ANGLE (Apple, APPLE M1 Pro, OpenGL 4.1)';
      return gp2.call(this, p);
    };
  }

  // chrome.runtime
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};

  // permissions
  var origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(desc) {
    if (desc.name === 'notifications') return Promise.resolve({ state: 'prompt', onchange: null });
    return origQuery.call(this, desc);
  };
})();
`;

export async function applyPageStealth(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(STEALTH_SCRIPT);
}
