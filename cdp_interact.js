const WebSocket = require('ws');
const ws = new WebSocket(process.argv[2]);
let msgId = 1;
const pending = {};

function send(method, params, sessionId) {
  params = params || {};
  const id = msgId++;
  return new Promise((resolve) => {
    const t = setTimeout(() => { delete pending[id]; resolve({result: null}); }, 12000);
    pending[id] = {resolve, t};
    const msg = {id, method, params};
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function evalExpr(sessionId, expr) {
  const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true}, sessionId);
  return r && r.result && r.result.result ? r.result.result.value : null;
}

async function typeText(sessionId, text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    await send('Input.dispatchKeyEvent', {type: 'char', text: char}, sessionId);
    await sleep(40);
  }
}

ws.on('open', async function() {
  console.log('Connected');
  
  const t = await send('Target.getTargets');
  const pages = t.result.targetInfos.filter(function(x) { return x.type === 'page'; });
  console.log('Pages:', pages.map(function(p) { return p.url.substring(0,60); }));
  
  // Get Facebook page
  const fbTarget = pages.find(function(p) { return p.url.indexOf('facebook') >= 0; });
  console.log('FB target:', fbTarget ? fbTarget.targetId : 'none');
  
  const attachR = await send('Target.attachToTarget', {targetId: fbTarget.targetId, flatten: true});
  const sessionId = attachR.result.sessionId;
  console.log('Session:', sessionId);
  
  await send('Page.enable', {}, sessionId);
  
  // Navigate to FB login
  await send('Page.navigate', {url: 'https://www.facebook.com/login'}, sessionId);
  console.log('Navigating to FB login...');
  await sleep(5000);
  
  const fbUrl = await evalExpr(sessionId, 'document.location.href');
  console.log('FB URL:', fbUrl);
  
  const fbEmail = await evalExpr(sessionId, 'document.getElementById("email") !== null');
  console.log('Email input exists:', fbEmail);
  
  if (fbEmail) {
    // Click email field
    await evalExpr(sessionId, 'document.getElementById("email").click(); document.getElementById("email").focus();');
    await sleep(300);
    
    const emailStr = 'victim.research2026@yahoo.com';
    await typeText(sessionId, emailStr);
    console.log('Typed email:', emailStr);
    
    await sleep(300);
    
    // Tab to password
    await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Tab', code: 'Tab'}, sessionId);
    await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Tab', code: 'Tab'}, sessionId);
    await sleep(500);
    
    const passStr = 'P@ssw0rd.Test.2026';
    await typeText(sessionId, passStr);
    console.log('Typed password:', passStr);
    await sleep(3000);
  }
  
  // Now navigate to a generic login form
  await send('Page.navigate', {url: 'https://login.live.com/login.srf'}, sessionId);
  console.log('Navigating to Microsoft login...');
  await sleep(6000);
  
  const msUrl = await evalExpr(sessionId, 'document.location.href');
  console.log('MS URL:', msUrl);
  
  const msInput = await evalExpr(sessionId, 'document.querySelector("input[type=email]") !== null');
  console.log('MS email input:', msInput);
  
  if (msInput) {
    await evalExpr(sessionId, 'document.querySelector("input[type=email]").focus();');
    await sleep(300);
    const msEmail = 'testaccount.research@outlook.com';
    await typeText(sessionId, msEmail);
    console.log('Typed MS email:', msEmail);
    await sleep(2000);
  }
  
  console.log('Done with all interactions, waiting 5s...');
  await sleep(5000);
  
  ws.close();
  process.exit(0);
});

ws.on('message', function(data) {
  const msg = JSON.parse(data);
  if (msg.id && pending[msg.id]) {
    clearTimeout(pending[msg.id].t);
    pending[msg.id].resolve(msg);
    delete pending[msg.id];
  }
});

ws.on('error', function(e) { console.error('WS error:', e.message); });
setTimeout(function() { ws.close(); process.exit(1); }, 90000);
