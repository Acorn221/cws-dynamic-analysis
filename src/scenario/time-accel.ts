/**
 * Time acceleration — fast-forward JavaScript timers and chrome.alarms
 * to trigger time-bomb / sleeper behavior without waiting days.
 */
import type { CDPSession } from 'puppeteer';
import { logger } from '../logger.js';

const log = logger.child({ component: 'time-accel' });

/**
 * Inject Date.now() override that adds an offset.
 * Idempotent — saves the original Date once and never re-wraps.
 */
export async function injectTimeOverride(
  session: CDPSession,
  offsetSeconds: number,
): Promise<void> {
  const offsetMs = offsetSeconds * 1000;

  await session.send('Runtime.evaluate', {
    expression: `
      (function() {
        // Save original Date exactly once
        if (!globalThis.__cwsOrigDate) {
          globalThis.__cwsOrigDate = Date;
          globalThis.__cwsOrigDateNow = Date.now.bind(Date);
        }
        const OrigDate = globalThis.__cwsOrigDate;
        const origNow = globalThis.__cwsOrigDateNow;
        const offset = ${offsetMs};

        Date.now = function() { return origNow() + offset; };

        // Only override Date.now, not the Date constructor.
        // Replacing globalThis.Date breaks internal Chrome APIs and crashes SWs.
        // Date.now offset is sufficient for triggering time-bomb behavior.
      })();
    `,
    awaitPromise: false,
    returnByValue: true,
  });

  log.info({ offsetSeconds }, 'Time override injected');
}

/**
 * Hook chrome.alarms to fire immediately.
 */
export async function accelerateAlarms(session: CDPSession): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `
      (function() {
        if (typeof chrome === 'undefined' || !chrome.alarms) return;
        const orig = chrome.alarms.create;
        if (!orig) return;
        chrome.alarms.create = function(name, info) {
          // Just set a very short delay — don't try to dispatch manually
          // (chrome.alarms.onAlarm.dispatch doesn't exist and crashes the SW)
          try {
            return orig.call(this, name, { delayInMinutes: 0.01 });
          } catch(e) {
            return orig.call(this, name, info);
          }
        };
      })();
    `,
    awaitPromise: false,
    returnByValue: true,
  });

  log.info('Alarm acceleration injected');
}
