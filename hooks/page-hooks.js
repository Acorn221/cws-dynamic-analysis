/**
 * Page-side hooks — injected via Page.addScriptToEvaluateOnNewDocument.
 * Runs in an isolated world BEFORE any page or content script code.
 * Reports to Node via __cwsHook__ binding.
 */
(function () {
  'use strict';

  function report(type, data) {
    try {
      __cwsHook__(JSON.stringify({ type, data, ts: Date.now() }));
    } catch {
      // Binding may not be ready yet — swallow
    }
  }

  // --- document.cookie ---
  const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (cookieDesc) {
    Object.defineProperty(Document.prototype, 'cookie', {
      get() {
        const val = cookieDesc.get.call(this);
        report('cookie.get', { length: val.length, preview: val.slice(0, 200) });
        return val;
      },
      set(v) {
        report('cookie.set', { preview: String(v).slice(0, 200) });
        return cookieDesc.set.call(this, v);
      },
      configurable: true,
    });
  }

  // --- fetch ---
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (resource, init) {
    const url = typeof resource === 'string' ? resource : resource?.url ?? '';
    report('fetch', {
      url,
      method: init?.method || 'GET',
      bodyLen: init?.body ? init.body.length || 0 : 0,
      bodyPreview: typeof init?.body === 'string' ? init.body.slice(0, 500) : undefined,
    });
    return origFetch.apply(this, arguments);
  };

  // --- XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cwsMeta = { method, url: String(url) };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    report('xhr.send', {
      method: this.__cwsMeta?.method,
      url: this.__cwsMeta?.url,
      bodyLen: body ? (typeof body === 'string' ? body.length : body.byteLength || 0) : 0,
      bodyPreview: typeof body === 'string' ? body.slice(0, 500) : undefined,
    });
    return origSend.apply(this, arguments);
  };

  // --- navigator.clipboard ---
  if (navigator.clipboard) {
    const origReadText = navigator.clipboard.readText;
    if (origReadText) {
      navigator.clipboard.readText = async function () {
        const val = await origReadText.call(this);
        report('clipboard.readText', { length: val.length, preview: val.slice(0, 200) });
        return val;
      };
    }
    const origWriteText = navigator.clipboard.writeText;
    if (origWriteText) {
      navigator.clipboard.writeText = async function (text) {
        report('clipboard.writeText', { length: text.length });
        return origWriteText.call(this, text);
      };
    }
  }

  // --- Form submission ---
  const origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    const data = {};
    try {
      const fd = new FormData(this);
      fd.forEach((v, k) => { data[k] = String(v).slice(0, 100); });
    } catch { /* ignore */ }
    report('form.submit', { action: this.action, method: this.method, fields: data });
    return origSubmit.call(this);
  };

  // --- navigator.sendBeacon ---
  const origBeacon = navigator.sendBeacon;
  if (origBeacon) {
    navigator.sendBeacon = function (url, data) {
      report('sendBeacon', {
        url: String(url),
        bodyLen: data ? (typeof data === 'string' ? data.length : data.byteLength || 0) : 0,
        bodyPreview: typeof data === 'string' ? data.slice(0, 500) : undefined,
      });
      return origBeacon.apply(this, arguments);
    };
  }

  // --- WebSocket ---
  const OrigWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = function (url, protocols) {
    report('websocket.create', { url: String(url) });
    const ws = new OrigWebSocket(url, protocols);
    const origSendWS = ws.send;
    ws.send = function (data) {
      report('websocket.send', {
        url: String(url),
        dataLen: typeof data === 'string' ? data.length : data.byteLength || 0,
      });
      return origSendWS.apply(this, arguments);
    };
    return ws;
  };
  globalThis.WebSocket.prototype = OrigWebSocket.prototype;
  globalThis.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  globalThis.WebSocket.OPEN = OrigWebSocket.OPEN;
  globalThis.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  globalThis.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  // --- Input field observation (detect keyloggers reading values) ---
  const origValueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (origValueDesc) {
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      get() {
        const val = origValueDesc.get.call(this);
        // Only report if this is a sensitive field type
        const type = (this.type || '').toLowerCase();
        if (['password', 'email', 'tel', 'number'].includes(type) ||
            /card|cc|cvv|ssn|account/i.test(this.name || this.id || '')) {
          report('input.read', {
            type,
            name: this.name,
            id: this.id,
            valueLen: val ? val.length : 0,
            value: val || '',
          });
        }
        return val;
      },
      set(v) {
        return origValueDesc.set.call(this, v);
      },
      configurable: true,
    });
  }
})();
