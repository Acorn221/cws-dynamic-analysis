import type { CDPSession, Page } from 'puppeteer';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const log = logger.child({ component: 'hooks' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = resolve(__dirname, '../../hooks');

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
 * Inject service worker hooks via Runtime.evaluate.
 * Must be called while the SW is paused (waitForDebuggerOnStart).
 * Hooks: chrome.cookies, chrome.tabs, chrome.history, chrome.storage,
 *        chrome.runtime.sendMessage, chrome.runtime.onMessage.
 */
export async function injectServiceWorkerHooks(
  session: CDPSession,
): Promise<void> {
  const hookCode = await readFile(resolve(HOOKS_DIR, 'sw-hooks.js'), 'utf-8');

  await session.send('Runtime.enable');

  // Add binding for hook callbacks
  await session.send('Runtime.addBinding', { name: '__cwsSWHook__' });

  // Inject the hooks
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
    log.debug('Service worker hooks injected');
  }

  // Resume the service worker
  await session.send('Runtime.runIfWaitingForDebugger');
}

/**
 * Listen for hook callbacks from a service worker session.
 * SW hooks report via Runtime.bindingCalled events.
 */
export function onServiceWorkerHookCallback(
  session: CDPSession,
  handler: (data: any) => void,
): void {
  session.on('Runtime.bindingCalled' as any, (event: any) => {
    if (event.name === '__cwsSWHook__') {
      try {
        handler(JSON.parse(event.payload));
      } catch {
        log.warn({ payload: event.payload }, 'Failed to parse SW hook payload');
      }
    }
  });
}
