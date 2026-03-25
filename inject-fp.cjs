const puppeteer = require('puppeteer-core');
const WS = process.argv[2];
const EXT_ID = process.argv[3];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: WS,
    defaultViewport: null
  });
  
  // Wait for SW to wake
  await sleep(3000);
  
  const targets = browser.targets();
  console.log('Targets after wait:');
  for (const t of targets) {
    console.log(' ', t.type(), t.url());
  }
  
  const swTarget = targets.find(t => t.type() === 'service_worker');
  if (!swTarget) {
    console.log('No SW target found');
    // Try using CDP directly to inject into any page
    const pages = await browser.pages();
    const page = pages[0];
    
    // Use background page approach - create a tab that accesses the extension storage
    console.log('Using page to inject into extension storage via chrome.storage...');
    // Navigate to extension bg URL
    const bgUrl = `chrome-extension://${EXT_ID}/background.js`;
    console.log('Extension URL:', bgUrl);
    
    // Inject via extension options page
    await page.goto(`chrome-extension://${EXT_ID}/popup.html`, {timeout: 10000}).catch(e => console.log('popup nav error:', e.message));
    await sleep(2000);
    
    const result = await page.evaluate(async () => {
      return new Promise(resolve => {
        chrome.storage.local.set({'fp': 'da-test-device-id-inject-12345'}, () => {
          chrome.storage.local.get(['fp'], (data) => {
            resolve(data);
          });
        });
      });
    }).catch(e => 'error: ' + e.message);
    
    console.log('Inject via popup result:', result);
  }
  
  await browser.disconnect();
})().catch(e => console.error('FATAL:', e.message));
