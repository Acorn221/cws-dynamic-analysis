const puppeteer = require('puppeteer-core');

const WS = process.argv[2];
const capturedRequests = [];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: WS,
    defaultViewport: null
  });

  // Listen for ALL new targets
  browser.on('targetcreated', async (target) => {
    const type = target.type();
    const url = target.url();
    console.log('NEW TARGET:', type, url);
    
    if (type === 'service_worker' && url.startsWith('chrome-extension://')) {
      console.log('!! FOUND EXTENSION SW:', url);
      try {
        const worker = await target.worker();
        if (worker) {
          console.log('Got worker handle, enabling network...');
          const client = await worker.client();
          await client.send('Network.enable');
          client.on('Network.requestWillBeSent', (params) => {
            const req = { type: 'request', url: params.request.url, method: params.request.method, headers: params.request.headers, timestamp: Date.now() };
            capturedRequests.push(req);
            console.log('SW REQUEST:', params.request.method, params.request.url);
            if (params.request.postData) {
              console.log('  BODY:', params.request.postData.slice(0, 500));
            }
          });
          client.on('Network.responseReceived', (params) => {
            console.log('SW RESPONSE:', params.response.status, params.response.url.slice(0, 100));
          });
        }
      } catch(e) {
        console.error('Failed to attach to SW:', e.message);
      }
    }
  });

  // Check existing targets
  const targets = browser.targets();
  console.log('Current targets:');
  for (const t of targets) {
    console.log(' ', t.type(), t.url());
    if (t.type() === 'service_worker' && t.url().startsWith('chrome-extension://')) {
      console.log('!! FOUND EXISTING EXTENSION SW:', t.url());
    }
  }

  // Use CDP to force-enable all targets (including lazy SWs)
  const cdp = await browser.target().createCDPSession();
  cdp.on('Target.attachedToTarget', async (event) => {
    const { sessionId, targetInfo } = event;
    console.log('CDP ATTACHED:', targetInfo.type, targetInfo.url);
    if (targetInfo.type === 'service_worker' && targetInfo.url.startsWith('chrome-extension://')) {
      console.log('!! CDP SAW EXTENSION SW:', targetInfo.url, 'sessionId:', sessionId);
      try {
        const target = await cdp.send('Network.enable', {}, sessionId);
        console.log('Network enabled on SW session');
      } catch(e) {
        console.error('Error enabling network:', e.message);
      }
    }
  });
  
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true
  });
  
  console.log('Auto-attach enabled, waiting 60 seconds for requests...');
  await sleep(60000);
  
  require('fs').writeFileSync('/tmp/klok-sw-capture.json', JSON.stringify(capturedRequests, null, 2));
  console.log('Captured', capturedRequests.length, 'requests');
  
  await browser.disconnect();
})().catch(e => console.error('FATAL:', e.message, e.stack));
