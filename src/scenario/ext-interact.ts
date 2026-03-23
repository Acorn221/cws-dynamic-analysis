/**
 * Extension interaction phase — uses an LLM to navigate the extension's
 * popup, options page, and onboarding flow. This is critical for activating
 * extensions that gate behavior behind ToS acceptance or setup wizards.
 *
 * Flow:
 * 1. Open extension popup/options page
 * 2. Snapshot the DOM (simplified accessible tree)
 * 3. Send to LLM: "you're onboarding, accept everything, click through"
 * 4. Execute LLM's chosen actions (click, type, select)
 * 5. Repeat until LLM says "done" or max iterations reached
 */
import type { Page, Browser } from 'puppeteer';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';

const log = logger.child({ component: 'ext-interact' });

const MAX_TURNS = 15;

const SYSTEM_PROMPT = `You are interacting with a Chrome browser extension's UI to complete its onboarding/setup flow.

Your goal: Accept all terms, privacy policies, and agreements. Complete any setup wizard. Enable all features. Get the extension into its fully-activated state so we can observe its runtime behavior.

You will receive a DOM snapshot of the current page. Respond with ONE action in JSON format:

{"action": "click", "selector": "CSS selector of element to click"}
{"action": "type", "selector": "CSS selector", "text": "text to type"}
{"action": "select", "selector": "CSS selector", "value": "option value"}
{"action": "scroll", "direction": "down"}
{"action": "done", "reason": "why you think onboarding is complete"}
{"action": "navigate", "url": "URL to navigate to (for options pages etc)"}

Rules:
- Always accept ToS, privacy policies, data collection agreements — we WANT the extension fully activated
- If you see a "Skip" vs "Accept"/"Continue"/"Get Started" choice, choose the one that enables more features
- If asked for age/birth year, enter 1990
- If asked to sign in, click "Skip" or "Later" — we don't have credentials
- If the page looks like a normal fully-loaded extension popup with no onboarding dialogs, respond with done
- If you see the same state twice in a row, try scrolling or respond with done
- Return ONLY the JSON action, no other text`;

interface InteractConfig {
  extensionId: string;
  apiKey?: string;
  model?: string;
  maxTurns?: number;
}

/**
 * Run the LLM-driven extension interaction phase.
 * Opens popup and options pages, uses Claude to navigate onboarding.
 */
export async function interactWithExtension(
  browser: Browser,
  config: InteractConfig,
): Promise<{ turns: number; actions: string[] }> {
  const model = config.model ?? 'claude-haiku-4-5-20251001';
  const maxTurns = config.maxTurns ?? MAX_TURNS;
  const actions: string[] = [];

  // Validate API key early — skip LLM interaction entirely if unavailable
  let client: Anthropic | null = null;
  try {
    client = new Anthropic({ apiKey: config.apiKey });
    // Verify the client can resolve auth (constructor doesn't validate)
    if (!config.apiKey && !process.env.ANTHROPIC_API_KEY) {
      log.warn('No ANTHROPIC_API_KEY set — skipping LLM-driven interaction');
      client = null;
    }
  } catch {
    log.warn('Anthropic client init failed — skipping LLM-driven interaction');
  }

  // Open extension pages by using chrome.tabs.create via the SW,
  // because direct page.goto('chrome-extension://...') fails with
  // ERR_FILE_NOT_FOUND on CWS-downloaded extensions in headless mode.
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

      // Wait for JS frameworks to render
      await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));

      const elementCount = await page.evaluate(() => document.querySelectorAll('*').length).catch(() => 0);
      if (elementCount < 5) {
        log.debug({ url: page.url(), elementCount }, 'Page has too few elements, skipping');
        continue;
      }

      log.info({ url: page.url(), elementCount }, 'Extension page rendered, starting interaction');
      if (client) {
        await runInteractionLoop(page, client, model, maxTurns, actions);
      } else {
        log.info('No LLM client — waiting 3s for extension to self-activate');
        await new Promise((r) => setTimeout(r, 3000));
      }
      log.info({ url: page.url(), actions: actions.length }, 'Extension page interaction complete');
    } catch (err: any) {
      log.warn({ pagePath, err: err.message }, 'Extension page interaction failed');
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  return { turns: actions.length, actions };
}

async function runInteractionLoop(
  page: Page,
  client: Anthropic,
  model: string,
  maxTurns: number,
  actions: string[],
): Promise<number> {
  let lastSnapshot = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    // 1. Take DOM snapshot
    const snapshot = await getSimplifiedDOM(page);

    // Skip if page is empty or same as last turn
    if (!snapshot.trim() || snapshot === lastSnapshot) {
      log.debug('Page unchanged or empty, finishing');
      break;
    }
    lastSnapshot = snapshot;

    const pageUrl = page.url();
    const userMessage = `Current page: ${pageUrl}\n\nDOM snapshot:\n${snapshot}`;

    // 2. Ask LLM what to do
    let response: string;
    try {
      const result = await client.messages.create({
        model,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });
      response = (result.content[0] as any).text?.trim() ?? '';
    } catch (err: any) {
      log.error({ err: err.message }, 'LLM call failed');
      break;
    }

    // 3. Parse and execute action
    let action: any;
    try {
      // Extract JSON from response (LLM might wrap in markdown)
      const jsonMatch = response.match(/\{[^}]+\}/);
      if (!jsonMatch) {
        log.warn({ response }, 'LLM response not valid JSON');
        break;
      }
      action = JSON.parse(jsonMatch[0]);
    } catch {
      log.warn({ response }, 'Failed to parse LLM action');
      break;
    }

    log.info({ turn, action: action.action, selector: action.selector, reason: action.reason }, 'LLM action');
    actions.push(JSON.stringify(action));

    if (action.action === 'done') {
      break;
    }

    try {
      await executeAction(page, action);
      // Wait for any navigation/rendering
      await page.evaluate(() => new Promise(r => setTimeout(r, 1000)));
    } catch (err: any) {
      log.warn({ action, err: err.message }, 'Action execution failed');
      // Continue trying — the element might have been removed
    }
  }

  return actions.length;
}

async function executeAction(page: Page, action: any): Promise<void> {
  switch (action.action) {
    case 'click':
      await page.waitForSelector(action.selector, { timeout: 3000 });
      await page.click(action.selector);
      break;

    case 'type':
      await page.waitForSelector(action.selector, { timeout: 3000 });
      await page.click(action.selector);
      await page.type(action.selector, action.text, { delay: 50 });
      break;

    case 'select':
      await page.select(action.selector, action.value);
      break;

    case 'scroll':
      await page.evaluate((dir) => {
        window.scrollBy(0, dir === 'up' ? -300 : 300);
      }, action.direction ?? 'down');
      break;

    case 'navigate':
      await page.goto(action.url, { waitUntil: 'networkidle2', timeout: 10000 });
      break;
  }
}

/**
 * Extract a simplified DOM representation suitable for LLM consumption.
 * Returns interactive elements with their text, type, and CSS selectors.
 * Targets ~2K tokens to keep LLM costs low.
 */
async function getSimplifiedDOM(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines: string[] = [];
    const seen = new Set<string>();

    function getSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) return `${el.tagName.toLowerCase()}.${cls}`;
      }
      // nth-child fallback
      const parent = el.parentElement;
      if (parent) {
        const idx = Array.from(parent.children).indexOf(el) + 1;
        return `${getSelector(parent)} > ${el.tagName.toLowerCase()}:nth-child(${idx})`;
      }
      return el.tagName.toLowerCase();
    }

    function getText(el: Element): string {
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
      return text.slice(0, 80);
    }

    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    // Get page title/headings for context
    const title = document.title;
    if (title) lines.push(`Page title: ${title}`);

    const headings = document.querySelectorAll('h1, h2, h3');
    headings.forEach(h => {
      const text = getText(h);
      if (text) lines.push(`[${h.tagName}] ${text}`);
    });

    // Get all visible text paragraphs (for ToS/privacy content)
    const paragraphs = document.querySelectorAll('p, .description, .subtitle, .info, [class*="privacy"], [class*="terms"], [class*="consent"]');
    paragraphs.forEach(p => {
      if (!isVisible(p)) return;
      const text = getText(p);
      if (text && text.length > 10) {
        const key = text.slice(0, 50);
        if (!seen.has(key)) {
          seen.add(key);
          lines.push(`[text] ${text}`);
        }
      }
    });

    // Get all interactive elements
    const interactives = document.querySelectorAll(
      'button, a[href], input, select, textarea, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="link"], label, [class*="toggle"], [class*="btn"], [class*="button"]'
    );
    interactives.forEach(el => {
      if (!isVisible(el)) return;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') ?? '';
      const role = el.getAttribute('role') ?? '';
      const text = getText(el);
      const selector = getSelector(el);
      const checked = (el as HTMLInputElement).checked;
      const disabled = (el as HTMLButtonElement).disabled;
      const placeholder = el.getAttribute('placeholder') ?? '';

      if (!text && !placeholder && tag !== 'input') return;

      let desc = `[${tag}`;
      if (type) desc += ` type="${type}"`;
      if (role) desc += ` role="${role}"`;
      if (checked !== undefined && tag === 'input') desc += checked ? ' checked' : ' unchecked';
      if (disabled) desc += ' disabled';
      desc += `]`;
      if (text) desc += ` "${text}"`;
      if (placeholder) desc += ` placeholder="${placeholder}"`;
      desc += ` → ${selector}`;

      const key = desc.slice(0, 80);
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(desc);
      }
    });

    return lines.slice(0, 60).join('\n');
  });
}
