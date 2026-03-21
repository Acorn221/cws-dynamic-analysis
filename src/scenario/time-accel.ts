/**
 * Time acceleration — fast-forward JavaScript timers and chrome.alarms
 * to trigger time-bomb / sleeper behavior without waiting days.
 *
 * Two strategies:
 * 1. Override Date.now() to simulate future timestamps
 * 2. Hook chrome.alarms to fire immediately instead of waiting
 */
import type { CDPSession } from 'puppeteer';
import { logger } from '../logger.js';

const log = logger.child({ component: 'time-accel' });

/**
 * Inject Date.now() override into a page or service worker context.
 * Advances the perceived time by `offsetSeconds` into the future.
 */
export async function injectTimeOverride(
  session: CDPSession,
  offsetSeconds: number,
): Promise<void> {
  const offsetMs = offsetSeconds * 1000;

  await session.send('Runtime.evaluate', {
    expression: `
      (function() {
        const __origDateNow = Date.now;
        const __origDate = Date;
        const __timeOffset = ${offsetMs};

        Date.now = function() {
          return __origDateNow.call(Date) + __timeOffset;
        };

        // Override Date constructor for new Date()
        const __OrigDate = Date;
        globalThis.Date = function(...args) {
          if (args.length === 0) {
            return new __OrigDate(__OrigDate.now() + __timeOffset);
          }
          return new __OrigDate(...args);
        };
        globalThis.Date.now = Date.now;
        globalThis.Date.parse = __OrigDate.parse;
        globalThis.Date.UTC = __OrigDate.UTC;
        globalThis.Date.prototype = __OrigDate.prototype;
      })();
    `,
    awaitPromise: false,
    returnByValue: true,
  });

  log.info({ offsetSeconds }, 'Time override injected');
}

/**
 * Hook chrome.alarms to fire immediately.
 * Must be injected into service worker context.
 */
export async function accelerateAlarms(session: CDPSession): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `
      (function() {
        if (typeof chrome === 'undefined' || !chrome.alarms) return;

        const __origCreate = chrome.alarms.create;
        chrome.alarms.create = function(name, alarmInfo) {
          console.log('[CWS_TIME_ACCEL] Alarm created:', name, JSON.stringify(alarmInfo));
          // Fire the alarm callback immediately instead of waiting
          if (chrome.alarms.onAlarm) {
            setTimeout(() => {
              chrome.alarms.onAlarm.dispatch({ name, scheduledTime: Date.now() });
            }, 100);
          }
          // Still create the real alarm (but with short delay for realism)
          return __origCreate.call(this, name, { delayInMinutes: 0.01 });
        };
      })();
    `,
    awaitPromise: false,
    returnByValue: true,
  });

  log.info('Alarm acceleration injected');
}
