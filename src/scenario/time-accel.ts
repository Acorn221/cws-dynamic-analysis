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

        globalThis.Date = function(...args) {
          if (args.length === 0) return new OrigDate(origNow() + offset);
          return new OrigDate(...args);
        };
        globalThis.Date.now = Date.now;
        globalThis.Date.parse = OrigDate.parse;
        globalThis.Date.UTC = OrigDate.UTC;
        globalThis.Date.prototype = OrigDate.prototype;
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
        chrome.alarms.create = function(name, info) {
          if (chrome.alarms.onAlarm) {
            setTimeout(() => {
              chrome.alarms.onAlarm.dispatch({ name, scheduledTime: Date.now() });
            }, 100);
          }
          return orig.call(this, name, { delayInMinutes: 0.01 });
        };
      })();
    `,
    awaitPromise: false,
    returnByValue: true,
  });

  log.info('Alarm acceleration injected');
}
