import type { CDPSession, Page } from 'puppeteer';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const log = logger.child({ component: 'hooks' });

// Find hooks dir: try relative to the compiled output, then fall back to cwd
import { statSync } from 'node:fs';
function findHooksDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(thisDir, '../hooks'),
    resolve(thisDir, '../../hooks'),
    resolve(process.cwd(), 'hooks'),
  ]) {
    try { statSync(resolve(candidate, 'sw-hooks.js')); return candidate; } catch {}
  }
  return resolve(process.cwd(), 'hooks');
}
const HOOKS_DIR = findHooksDir();

/**
 * Inject page-side hooks via Page.addScriptToEvaluateOnNewDocument.
 * These run in an isolated world before any page/content script code.
 * Hooks: document.cookie, fetch, XHR, clipboard, form submit, sendBeacon, WebSocket.
 */
export async function injectPageHooks(page: Page): Promise<void> {
  const hookCode = await readFile(resolve(HOOKS_DIR, 'page-hooks.js'), 'utf-8');

  // Expose a binding so hook callbacks reach Node
  await page.exposeFunction('__cwsHook__', (payload: string) => {
    // This is handled by the collector — page.on('console') won't catch bindings
    // Instead we emit a custom event that the collector listens for
    page.emit('cws:hook', JSON.parse(payload));
  });

  await page.evaluateOnNewDocument(hookCode);
  log.debug('Page hooks injected');
}

/**
 * Inject service worker hooks via Runtime.evaluate (or skip if source-rewritten).
 * Must be called while the SW is paused (waitForDebuggerOnStart).
 * Hooks: chrome.cookies, chrome.tabs, chrome.history, chrome.storage,
 *        chrome.runtime.sendMessage, chrome.runtime.onMessage.
 *
 * @param skipEval - If true, hooks were already prepended to the SW source
 *                   via source rewriting, so skip Runtime.evaluate injection.
 */
export async function injectServiceWorkerHooks(
  session: CDPSession,
  skipEval = false,
): Promise<void> {
  await session.send('Runtime.enable');

  if (!skipEval) {
    const hookCode = await readFile(resolve(HOOKS_DIR, 'sw-hooks.js'), 'utf-8');

    // Inject the hooks via evaluate
    const result = await session.send('Runtime.evaluate', {
      expression: hookCode,
      awaitPromise: false,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      log.error(
        { error: result.exceptionDetails.text },
        'Failed to inject SW hooks',
      );
    } else {
      log.debug('Service worker hooks injected via Runtime.evaluate');
    }
  } else {
    log.debug('Service worker hooks already source-rewritten, skipping eval');
  }

  // Resume the service worker
  await session.send('Runtime.runIfWaitingForDebugger');
}

/**
 * Listen for hook callbacks from a service worker session.
 * SW hooks report via console.log('[CWS_HOOK]', jsonPayload) which
 * surfaces as Runtime.consoleAPICalled events on the CDP session.
 */
export function onServiceWorkerHookCallback(
  session: CDPSession,
  handler: (data: any) => void,
): void {
  // @ts-ignore — CDPSession event type
  session.on('Runtime.consoleAPICalled', (event: any) => {
    if (event.type !== 'log' || !event.args || event.args.length < 2) return;

    // First arg should be the string '[CWS_HOOK]'
    const prefixArg = event.args[0];
    if (prefixArg?.type !== 'string' || prefixArg?.value !== '[CWS_HOOK]') return;

    // Second arg is the JSON payload string
    const payloadArg = event.args[1];
    if (payloadArg?.type !== 'string') return;

    try {
      handler(JSON.parse(payloadArg.value));
    } catch {
      log.warn({ payload: payloadArg.value }, 'Failed to parse SW hook payload');
    }
  });
}
