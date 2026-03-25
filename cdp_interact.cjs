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

  // Use first non-extensions page
  const usablePage = pages.find(function(p) { return !p.url.startsWith('chrome://'); });
  console.log('Using target:', usablePage.targetId, usablePage.url.substring(0,60));

  const attachR = await send('Target.attachToTarget', {targetId: usablePage.targetId, flatten: true});
  const sessionId = attachR.result.sessionId;
  console.log('Session:', sessionId);

  await send('Page.enable', {}, sessionId);

  // === Facebook login ===
  console.log('\n=== Navigating to Facebook login ===');
  await send('Page.navigate', {url: 'https://www.facebook.com/login'}, sessionId);
  await sleep(6000);

  const fbUrl = await evalExpr(sessionId, 'document.location.href');
  console.log('FB URL:', fbUrl);

  const emailExists = await evalExpr(sessionId, 'document.getElementById("email") !== null');
  console.log('Email input exists:', emailExists);

  if (emailExists) {
    await evalExpr(sessionId, 'document.getElementById("email").click(); document.getElementById("email").focus();');
    await sleep(300);

    const emailStr = 'victim.research2026@yahoo.com';
    await typeText(sessionId, emailStr);
    console.log('Typed email:', emailStr);

    await sleep(500);

    await evalExpr(sessionId, 'document.getElementById("pass").focus();');
    await sleep(300);

    const passStr = 'P@ssw0rd.Test.2026';
    await typeText(sessionId, passStr);
    console.log('Typed password:', passStr);
    await sleep(3000);
  } else {
    console.log('No email input on FB - checking inputs...');
    const allInputs = await evalExpr(sessionId, 'JSON.stringify(Array.from(document.querySelectorAll("input")).map(function(i) { return {type: i.type, id: i.id, name: i.name}; }))');
    console.log('All inputs:', allInputs);
  }

  // === Microsoft login ===
  console.log('\n=== Navigating to Microsoft login ===');
  await send('Page.navigate', {url: 'https://login.live.com/login.srf'}, sessionId);
  await sleep(7000);

  const msUrl = await evalExpr(sessionId, 'document.location.href');
  console.log('MS URL:', msUrl);

  const msEmailInput = await evalExpr(sessionId, 'document.querySelector("input[type=email], input[name=loginfmt]") !== null');
  console.log('MS email input:', msEmailInput);

  if (msEmailInput) {
    await evalExpr(sessionId, '(document.querySelector("input[type=email]") || document.querySelector("input[name=loginfmt]")).focus();');
    await sleep(300);
    const msEmail = 'testaccount.research@outlook.com';
    await typeText(sessionId, msEmail);
    console.log('Typed MS email:', msEmail);
    await sleep(2000);

    // Click Next
    await evalExpr(sessionId, 'var btn = document.querySelector("input[type=submit], button[type=submit]"); if(btn) btn.click();');
    await sleep(4000);

    // Type password if prompted
    const msPass = await evalExpr(sessionId, 'document.querySelector("input[type=password]") !== null');
    if (msPass) {
      await evalExpr(sessionId, 'document.querySelector("input[type=password]").focus();');
      await sleep(300);
      const msPassword = 'M$P@ssw0rd.2026';
      await typeText(sessionId, msPassword);
      console.log('Typed MS password:', msPassword);
      await sleep(2000);
    }
  }

  // === Github login ===
  console.log('\n=== Navigating to Github login ===');
  await send('Page.navigate', {url: 'https://github.com/login'}, sessionId);
  await sleep(5000);

  const ghUrl = await evalExpr(sessionId, 'document.location.href');
  console.log('GH URL:', ghUrl);

  const ghLogin = await evalExpr(sessionId, 'document.getElementById("login_field") !== null');
  console.log('GH login input:', ghLogin);

  if (ghLogin) {
    await evalExpr(sessionId, 'document.getElementById("login_field").focus();');
    await sleep(300);
    const ghUser = 'testresearcher2026';
    await typeText(sessionId, ghUser);
    console.log('Typed GH username:', ghUser);

    await sleep(300);
    await evalExpr(sessionId, 'document.getElementById("password").focus();');
    await sleep(300);
    const ghPass = 'Gh!P@ss.Research.2026';
    await typeText(sessionId, ghPass);
    console.log('Typed GH password:', ghPass);
    await sleep(3000);
  }

  console.log('\nAll interactions done, waiting 5 seconds...');
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
setTimeout(function() { ws.close(); process.exit(1); }, 120000);
