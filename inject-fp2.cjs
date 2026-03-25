const puppeteer = require('puppeteer-core');
const WS = process.argv[2];
const EXT_ID = process.argv[3];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: WS,
    defaultViewport: null
  });
  
  const targets = browser.targets();
  let swTarget = targets.find(t => t.type() === 'service_worker' && t.url().includes(EXT_ID));
  
  if (!swTarget) {
    console.log('SW not visible yet, waiting for it...');
    swTarget = await browser.waitForTarget(
      t => t.type() === 'service_worker' && t.url().includes(EXT_ID),
      { timeout: 15000 }
    ).catch(e => null);
  }
  
  if (!swTarget) {
    console.log('SW still not found after wait. Current targets:');
    const ts = browser.targets();
    for (const t of ts) console.log(' ', t.type(), t.url());
    await browser.disconnect();
    return;
  }
  
  console.log('Found SW:', swTarget.url());
  const worker = await swTarget.worker();
  
  // Inject fake device ID
  const result = await worker.evaluate(async () => {
    await chrome.storage.local.set({'fp': 'da-test-device-id-inject-xyz789'});
    const data = await chrome.storage.local.get(['fp', 'nn', 'ln', 'll']);
    return data;
  });
  console.log('After inject:', JSON.stringify(result));
  
  // Now wait a few seconds and check if sign beacon fired
  await sleep(5000);
  
  await browser.disconnect();
})().catch(e => console.error('FATAL:', e.message, e.stack));
