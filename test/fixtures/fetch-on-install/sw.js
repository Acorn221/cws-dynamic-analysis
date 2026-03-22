// Simulates: Picture in Picture (hjbbfikgfdpfaabifikbadhgmofabpam)
// Pattern: SW makes a beacon POST to an external server immediately on startup.
// This is the hardest case to capture — fetch() runs before CDP can attach.

const BEACON_URL = 'https://httpbin.org/post';

// Immediate fetch on SW startup — this is the race condition we need to catch
fetch(BEACON_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'install_beacon',
    ts: Date.now(),
    extId: chrome.runtime.id,
  }),
}).then(r => r.json()).then(data => {
  console.log('[TEST] Install beacon sent successfully', JSON.stringify(data).slice(0, 100));
}).catch(err => {
  console.log('[TEST] Install beacon failed (expected in test)', err.message);
});

// Also store a marker so tests can verify the SW ran
chrome.storage.local.set({ swStarted: Date.now() });

// Keep-alive
setInterval(() => {}, 25000);
