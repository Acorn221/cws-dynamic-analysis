/**
 * Service worker hooks — prepended to background.js via source rewriting,
 * or injected via Runtime.evaluate while SW is paused.
 * Wraps chrome.* APIs with Proxy-based logging.
 * Reports to Node via console.log with [CWS_HOOK] prefix, which is picked
 * up by Runtime.consoleAPICalled listener on the CDP session.
 */
(function () {
  'use strict';

  function report(api, args, result) {
    console.log('[CWS_HOOK]', JSON.stringify({
      api,
      args: summarize(args),
      result: summarize(result),
      ts: Date.now(),
    }));
  }

  /** Safely summarize a value for logging (avoid circular refs, huge objects) */
  function summarize(val) {
    if (val === undefined || val === null) return val;
    try {
      const str = JSON.stringify(val, (key, v) => {
        if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…';
        if (Array.isArray(v) && v.length > 20) return v.slice(0, 20).concat([`…(${v.length} total)`]);
        return v;
      });
      if (str && str.length > 2000) return str.slice(0, 2000) + '…';
      return JSON.parse(str);
    } catch {
      return String(val).slice(0, 200);
    }
  }

  /**
   * Wrap a chrome.* API method to log calls and results.
   * Handles both callback-style and promise-style APIs.
   */
  function wrapMethod(obj, namespace, methodName) {
    const orig = obj[methodName];
    if (typeof orig !== 'function') return;

    obj[methodName] = function (...args) {
      const apiName = `${namespace}.${methodName}`;

      // Detect if last arg is a callback
      const lastArg = args[args.length - 1];
      const hasCallback = typeof lastArg === 'function';

      if (hasCallback) {
        const origCallback = args.pop();
        args.push(function (...cbArgs) {
          report(apiName, args, cbArgs.length === 1 ? cbArgs[0] : cbArgs);
          return origCallback.apply(this, cbArgs);
        });
        return orig.apply(this, args);
      }

      // Promise-style
      const result = orig.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then((res) => {
          report(apiName, args, res);
          return res;
        });
      }

      report(apiName, args, result);
      return result;
    };
  }

  /**
   * Wrap a chrome.* event's addListener to log when handlers are registered
   * and when events fire.
   */
  function wrapEvent(eventObj, eventName) {
    if (!eventObj || typeof eventObj.addListener !== 'function') return;

    const origAddListener = eventObj.addListener;
    eventObj.addListener = function (listener, ...rest) {
      report(`${eventName}.addListener`, rest, undefined);
      const wrappedListener = function (...args) {
        report(`${eventName}.fired`, args, undefined);
        return listener.apply(this, args);
      };
      return origAddListener.call(this, wrappedListener, ...rest);
    };
  }

  // --- chrome.cookies ---
  if (typeof chrome !== 'undefined' && chrome.cookies) {
    wrapMethod(chrome.cookies, 'chrome.cookies', 'getAll');
    wrapMethod(chrome.cookies, 'chrome.cookies', 'get');
    wrapMethod(chrome.cookies, 'chrome.cookies', 'set');
    wrapMethod(chrome.cookies, 'chrome.cookies', 'remove');
  }

  // --- chrome.tabs ---
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    wrapMethod(chrome.tabs, 'chrome.tabs', 'query');
    wrapMethod(chrome.tabs, 'chrome.tabs', 'get');
    wrapMethod(chrome.tabs, 'chrome.tabs', 'sendMessage');
    wrapMethod(chrome.tabs, 'chrome.tabs', 'executeScript');
    if (chrome.tabs.onUpdated) {
      wrapEvent(chrome.tabs.onUpdated, 'chrome.tabs.onUpdated');
    }
  }

  // --- chrome.history ---
  if (typeof chrome !== 'undefined' && chrome.history) {
    wrapMethod(chrome.history, 'chrome.history', 'search');
    wrapMethod(chrome.history, 'chrome.history', 'getVisits');
  }

  // --- chrome.bookmarks ---
  if (typeof chrome !== 'undefined' && chrome.bookmarks) {
    wrapMethod(chrome.bookmarks, 'chrome.bookmarks', 'getTree');
    wrapMethod(chrome.bookmarks, 'chrome.bookmarks', 'search');
  }

  // --- chrome.storage ---
  if (typeof chrome !== 'undefined' && chrome.storage) {
    for (const area of ['local', 'sync', 'session']) {
      if (chrome.storage[area]) {
        wrapMethod(chrome.storage[area], `chrome.storage.${area}`, 'get');
        wrapMethod(chrome.storage[area], `chrome.storage.${area}`, 'set');
        wrapMethod(chrome.storage[area], `chrome.storage.${area}`, 'remove');
        wrapMethod(chrome.storage[area], `chrome.storage.${area}`, 'clear');
      }
    }
  }

  // --- chrome.runtime messaging ---
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    wrapMethod(chrome.runtime, 'chrome.runtime', 'sendMessage');
    if (chrome.runtime.onMessage) {
      wrapEvent(chrome.runtime.onMessage, 'chrome.runtime.onMessage');
    }
    if (chrome.runtime.onInstalled) {
      wrapEvent(chrome.runtime.onInstalled, 'chrome.runtime.onInstalled');
    }
  }

  // --- chrome.alarms ---
  if (typeof chrome !== 'undefined' && chrome.alarms) {
    wrapMethod(chrome.alarms, 'chrome.alarms', 'create');
    wrapMethod(chrome.alarms, 'chrome.alarms', 'getAll');
    if (chrome.alarms.onAlarm) {
      wrapEvent(chrome.alarms.onAlarm, 'chrome.alarms.onAlarm');
    }
  }

  // --- chrome.scripting ---
  if (typeof chrome !== 'undefined' && chrome.scripting) {
    wrapMethod(chrome.scripting, 'chrome.scripting', 'executeScript');
    wrapMethod(chrome.scripting, 'chrome.scripting', 'insertCSS');
    wrapMethod(chrome.scripting, 'chrome.scripting', 'registerContentScripts');
  }

  // --- chrome.declarativeNetRequest ---
  if (typeof chrome !== 'undefined' && chrome.declarativeNetRequest) {
    wrapMethod(chrome.declarativeNetRequest, 'chrome.declarativeNetRequest', 'updateDynamicRules');
    wrapMethod(chrome.declarativeNetRequest, 'chrome.declarativeNetRequest', 'getDynamicRules');
    wrapMethod(chrome.declarativeNetRequest, 'chrome.declarativeNetRequest', 'updateSessionRules');
  }

  // --- chrome.webRequest ---
  if (typeof chrome !== 'undefined' && chrome.webRequest) {
    if (chrome.webRequest.onBeforeRequest) {
      wrapEvent(chrome.webRequest.onBeforeRequest, 'chrome.webRequest.onBeforeRequest');
    }
    if (chrome.webRequest.onCompleted) {
      wrapEvent(chrome.webRequest.onCompleted, 'chrome.webRequest.onCompleted');
    }
  }

  // --- chrome.webNavigation ---
  if (typeof chrome !== 'undefined' && chrome.webNavigation) {
    if (chrome.webNavigation.onBeforeNavigate) {
      wrapEvent(chrome.webNavigation.onBeforeNavigate, 'chrome.webNavigation.onBeforeNavigate');
    }
    if (chrome.webNavigation.onCompleted) {
      wrapEvent(chrome.webNavigation.onCompleted, 'chrome.webNavigation.onCompleted');
    }
  }

  // --- chrome.notifications ---
  if (typeof chrome !== 'undefined' && chrome.notifications) {
    wrapMethod(chrome.notifications, 'chrome.notifications', 'create');
  }

  // Diagnostic: confirm hooks loaded (this fires once at load time,
  // but will only be captured if CDP Runtime.enable is active)
  console.log('[CWS_HOOK]', JSON.stringify({
    api: '_hooks.loaded',
    args: { timestamp: Date.now() },
    result: null,
    ts: Date.now(),
  }));
})();
