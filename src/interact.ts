/**
 * Interactive extension browser session — persistent browser that a
 * Claude Code agent can drive via CLI commands.
 *
 * Flow:
 *   interact start <ext-path>  → launches Chrome, opens popup, dumps DOM
 *   interact action <dir> <json> → executes click/type/scroll, dumps new DOM
 *   interact snapshot <dir>      → re-dump current DOM
 *   interact stop <dir>          → close browser, write browser state
 *
 * The browser persists between calls via wsEndpoint saved to <dir>/session.json.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STEALTH_ARGS, applyPageStealth } from './cdp/stealth.js';
import { logger } from './logger.js';

const log = logger.child({ component: 'interact' });

interface SessionState {
  wsEndpoint: string;
  extensionId: string;
  extensionPath: string;
  activePage?: string; // URL of the currently active extension page
}

async function saveSession(outputDir: string, state: SessionState): Promise<void> {
  await writeFile(join(outputDir, 'session.json'), JSON.stringify(state, null, 2));
}

async function loadSession(outputDir: string): Promise<SessionState> {
  return JSON.parse(await readFile(join(outputDir, 'session.json'), 'utf-8'));
}

/**
 * Start a new interactive session — launch Chrome with the extension,
 * open its popup, and return the DOM snapshot.
 */
export async function interactStart(
  extensionPath: string,
  outputDir: string,
  opts: { chromePath?: string; headless?: boolean } = {},
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: opts.headless ?? true,
    ...(opts.chromePath ? { executablePath: opts.chromePath } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...STEALTH_ARGS,
    ],
    defaultViewport: { width: 1440, height: 900 }, // MacBook-like resolution
  });

  // Wait for background target (service_worker for MV3, background_page for MV2)
  await new Promise((r) => setTimeout(r, 2000));
  const bgFilter = (t: any) =>
    (t.type() === 'service_worker' || t.type() === 'background_page') &&
    t.url().startsWith('chrome-extension://');
  let swTarget = browser.targets().find(bgFilter);
  if (!swTarget) {
    swTarget = await browser.waitForTarget(bgFilter, { timeout: 30_000 });
  }
  const extensionId = new URL(swTarget!.url()).hostname;
  log.info({ extensionId, targetType: swTarget!.type() }, 'Extension loaded');

  // Apply stealth to all existing pages + auto-apply to new ones
  for (const p of await browser.pages()) {
    await applyPageStealth(p).catch(() => {});
  }
  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const p = await target.page().catch(() => null);
      if (p) await applyPageStealth(p).catch(() => {});
    }
  });

  // Keep SW alive
  const swCdp = await swTarget!.createCDPSession();
  await swCdp.send('Runtime.enable');
  await swCdp.send('Runtime.evaluate', {
    expression: 'setInterval(()=>{},20000)',
    awaitPromise: false,
  });

  // Save session
  const wsEndpoint = browser.wsEndpoint();
  await saveSession(outputDir, { wsEndpoint, extensionId, extensionPath });

  // Open popup via chrome.tabs.create
  await swCdp.send('Runtime.evaluate', {
    expression: `chrome.tabs.create({url: chrome.runtime.getURL('popup.html')})`,
    awaitPromise: true,
  });
  await new Promise((r) => setTimeout(r, 3000));

  // Find the popup page
  const pages = await browser.pages();
  const popupPage = pages.find((p) => p.url().includes('popup.html'));
  if (!popupPage) {
    // Fallback: try options.html
    await swCdp.send('Runtime.evaluate', {
      expression: `chrome.tabs.create({url: chrome.runtime.getURL('options.html')})`,
      awaitPromise: true,
    });
    await new Promise((r) => setTimeout(r, 3000));
  }

  const activePage = (await browser.pages()).find(
    (p) => p.url().includes(extensionId) && !p.url().includes('service_worker') && !p.url().includes('_generated_background_page'),
  );

  if (activePage) {
    await saveSession(outputDir, {
      wsEndpoint,
      extensionId,
      extensionPath,
      activePage: activePage.url(),
    });
  }

  // Return DOM snapshot
  return activePage ? await getSnapshot(activePage) : 'No extension page found.';
}

/**
 * Execute an action on the active extension page and return new DOM snapshot.
 */
export async function interactAction(
  outputDir: string,
  action: { action: string; selector?: string; text?: string; value?: string; url?: string; direction?: string; target?: string },
): Promise<string> {
  // Hard 15s timeout on the entire action — if anything hangs, bail
  const TIMEOUT = 15_000;
  return Promise.race([
    interactActionInner(outputDir, action),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('interact action timed out after 15s')), TIMEOUT),
    ),
  ]);
}

async function findPage(browser: Browser, session: SessionState, target?: string): Promise<Page | undefined> {
  const pages = await browser.pages();
  if (target === 'page') {
    // Find a regular (non-extension) web page
    const webPage = pages.find((p) =>
      !p.isClosed() &&
      !p.url().startsWith('chrome-extension://') &&
      !p.url().startsWith('chrome://') &&
      p.url() !== 'about:blank',
    );
    if (webPage) return webPage;
    // Create one if none exists
    return await browser.newPage();
  }
  // Default: find extension page
  return pages.find((p) => p.url().includes(session.extensionId)) ??
    pages.find((p) => p.url().includes('popup.html') || p.url().includes('options.html'));
}

async function interactActionInner(
  outputDir: string,
  action: { action: string; selector?: string; text?: string; value?: string; url?: string; direction?: string; target?: string },
): Promise<string> {
  const session = await loadSession(outputDir);
  const browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint });

  const page = await findPage(browser, session, action.target);

  if (!page) {
    browser.disconnect();
    return 'ERROR: No extension page found. Run `interact start` first.';
  }

  try {
    switch (action.action) {
      case 'click':
        if (!action.selector) { browser.disconnect(); return 'ERROR: click requires selector'; }
        await page.waitForSelector(action.selector, { timeout: 3000 });
        // Use evaluate click — Puppeteer's click can hang when the click
        // triggers navigation listeners or Vue/React re-renders.
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) (el as HTMLElement).click();
        }, action.selector);
        break;

      case 'type':
        if (!action.selector || !action.text) { browser.disconnect(); return 'ERROR: type requires selector and text'; }
        await page.waitForSelector(action.selector, { timeout: 3000 });
        await page.click(action.selector);
        await page.type(action.selector, action.text, { delay: 50 });
        break;

      case 'select':
        if (!action.selector || !action.value) { browser.disconnect(); return 'ERROR: select requires selector and value'; }
        await page.select(action.selector, action.value);
        break;

      case 'scroll':
        await page.evaluate((dir) => {
          window.scrollBy(0, dir === 'up' ? -300 : 300);
        }, action.direction ?? 'down');
        break;

      case 'navigate':
        if (!action.url) { browser.disconnect(); return 'ERROR: navigate requires url'; }
        await page.goto(action.url, { waitUntil: 'load', timeout: 10000 });
        break;

      default:
        browser.disconnect();
        return `ERROR: Unknown action "${action.action}"`;
    }
  } catch (err: any) {
    const snap = await getSnapshot(page);
    browser.disconnect();
    return `ACTION FAILED: ${err.message}\n\n${snap}`;
  }

  // Wait for re-render
  await new Promise((r) => setTimeout(r, 1500));

  const snap = await getSnapshot(page);
  browser.disconnect();
  return snap;
}

/**
 * Get a DOM snapshot of the active extension page.
 */
export async function interactSnapshot(outputDir: string, target?: string): Promise<string> {
  return Promise.race([
    interactSnapshotInner(outputDir, target),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('interact snapshot timed out after 10s')), 10_000),
    ),
  ]);
}

async function interactSnapshotInner(outputDir: string, target?: string): Promise<string> {
  const session = await loadSession(outputDir);
  const browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint });
  const page = await findPage(browser, session, target);

  if (!page) { browser.disconnect(); return 'ERROR: No page found.'; }
  const snap = await getSnapshot(page);
  browser.disconnect();
  return snap;
}

/**
 * Stop the interactive session — close the browser.
 */
export async function interactStop(outputDir: string): Promise<void> {
  try {
    const session = await loadSession(outputDir);
    const browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint });
    await browser.close();
  } catch {
    // Browser may already be closed
  }
}

/**
 * Simplified DOM snapshot for LLM consumption.
 */
async function getSnapshot(page: Page): Promise<string> {
  // Auto-dismiss product tours (DriverJS, Shepherd, Intro.js)
  await page.evaluate(() => {
    // DriverJS
    document.querySelectorAll('.driver-popover-close-btn, .driver-close-btn').forEach((el) => (el as HTMLElement).click());
    // Shepherd
    document.querySelectorAll('.shepherd-cancel-icon, .shepherd-button-secondary').forEach((el) => (el as HTMLElement).click());
    // Intro.js
    document.querySelectorAll('.introjs-skipbutton, .introjs-donebutton').forEach((el) => (el as HTMLElement).click());
    // Generic overlay dismiss
    document.querySelectorAll('[class*="tour"] [class*="close"], [class*="walkthrough"] [class*="dismiss"]').forEach((el) => (el as HTMLElement).click());
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));

  const url = page.url();
  const snapshot = await page.evaluate(() => {
    const lines: string[] = [];
    const seen = new Set<string>();

    function getSel(el: Element): string {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) return `${el.tagName.toLowerCase()}.${cls}`;
      }
      const parent = el.parentElement;
      if (parent) {
        const idx = Array.from(parent.children).indexOf(el) + 1;
        return `${getSel(parent)} > ${el.tagName.toLowerCase()}:nth-child(${idx})`;
      }
      return el.tagName.toLowerCase();
    }

    function getText(el: Element): string {
      return (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    }

    function isVis(el: Element): boolean {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    const title = document.title;
    if (title) lines.push(`Title: ${title}`);

    document.querySelectorAll('h1, h2, h3').forEach((h) => {
      const t = getText(h);
      if (t) lines.push(`[${h.tagName}] ${t}`);
    });

    document.querySelectorAll('p, [class*="privacy"], [class*="terms"], [class*="consent"], [class*="description"], [class*="subtitle"]').forEach((p) => {
      if (!isVis(p)) return;
      const t = getText(p);
      if (t && t.length > 10 && !seen.has(t.slice(0, 50))) {
        seen.add(t.slice(0, 50));
        lines.push(`[text] ${t}`);
      }
    });

    document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="checkbox"], [role="switch"], label[for], [class*="toggle"], [class*="btn"]').forEach((el) => {
      if (!isVis(el)) return;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') ?? '';
      const text = getText(el);
      const sel = getSel(el);
      const checked = (el as HTMLInputElement).checked;
      const disabled = (el as HTMLButtonElement).disabled;
      const ph = el.getAttribute('placeholder') ?? '';

      if (!text && !ph && tag !== 'input') return;

      let d = `[${tag}`;
      if (type) d += ` type="${type}"`;
      if (checked !== undefined && tag === 'input' && (type === 'checkbox' || type === 'radio')) d += checked ? ' CHECKED' : ' unchecked';
      if (disabled) d += ' DISABLED';
      d += `]`;
      if (text) d += ` "${text}"`;
      if (ph) d += ` placeholder="${ph}"`;
      d += `  →  ${sel}`;

      if (!seen.has(d.slice(0, 80))) {
        seen.add(d.slice(0, 80));
        lines.push(d);
      }
    });

    return lines.slice(0, 60).join('\n');
  });

  return `URL: ${url}\nElements: ${await page.evaluate(() => document.querySelectorAll('*').length)}\n\n${snapshot}`;
}
