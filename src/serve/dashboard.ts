/** Returns the complete dashboard HTML as a string — no external files needed. */
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DA Monitor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; background: #0d1117; color: #c9d1d9; display: flex; height: 100vh; overflow: hidden; }

  /* Left panel — run list */
  #sidebar { width: 320px; border-right: 1px solid #21262d; display: flex; flex-direction: column; overflow-y: auto; }
  #sidebar h2 { padding: 16px; font-size: 14px; color: #58a6ff; border-bottom: 1px solid #21262d; }
  .run-card { padding: 12px 16px; border-bottom: 1px solid #21262d; cursor: pointer; transition: background 0.15s; }
  .run-card:hover, .run-card.active { background: #161b22; }
  .run-card .ext-id { font-size: 11px; color: #8b949e; word-break: break-all; }
  .run-card .phase { font-size: 12px; margin-top: 4px; }
  .run-card .stats { font-size: 11px; color: #8b949e; margin-top: 4px; display: flex; gap: 12px; }
  .run-card .status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .status-running { background: #3fb950; animation: pulse 1.5s infinite; }
  .status-completed { background: #58a6ff; }
  .status-failed { background: #f85149; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Right panel — viewer + logs */
  #main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

  /* Toolbar */
  #toolbar { padding: 8px 16px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 12px; font-size: 12px; }
  #toolbar button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: inherit; }
  #toolbar button:hover { background: #30363d; }
  #toolbar button.active { background: #1f6feb; border-color: #1f6feb; }
  #toolbar select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-family: inherit; }
  #toolbar .spacer { flex: 1; }

  /* Screencast canvas */
  #viewer { flex: 1; display: flex; align-items: center; justify-content: center; background: #010409; position: relative; min-height: 0; }
  #viewer canvas { max-width: 100%; max-height: 100%; cursor: crosshair; }
  #viewer .placeholder { color: #484f58; font-size: 14px; text-align: center; }
  #fps-counter { position: absolute; top: 8px; right: 8px; font-size: 11px; color: #484f58; }

  /* Log stream */
  #logs { height: 200px; border-top: 1px solid #21262d; overflow-y: auto; font-size: 11px; padding: 8px; }
  #logs .log-line { padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
  .log-error { color: #f85149; }
  .log-warn { color: #d29922; }
  .log-info { color: #8b949e; }
  .log-canary { color: #f0883e; font-weight: bold; }

  /* Resize handle */
  #log-resize { height: 4px; background: #21262d; cursor: ns-resize; }

  /* Empty state */
  .empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #484f58; font-size: 14px; }
</style>
</head>
<body>
  <div id="sidebar">
    <h2>DA Monitor</h2>
    <div id="run-list"><div class="empty">No active runs</div></div>
  </div>
  <div id="main">
    <div id="toolbar">
      <button id="btn-screencast" title="Toggle live view">Live View</button>
      <select id="page-select"><option value="">Select page...</option></select>
      <div class="spacer"></div>
      <span id="connection-status">Disconnected</span>
    </div>
    <div id="viewer">
      <div class="placeholder">Select a run to start monitoring</div>
      <canvas id="screen" style="display:none" tabindex="0"></canvas>
      <div id="fps-counter"></div>
    </div>
    <div id="log-resize"></div>
    <div id="logs"><div class="empty">Logs will appear here</div></div>
  </div>

<script>
const $ = (s) => document.querySelector(s);
const canvas = $('#screen');
const ctx = canvas.getContext('2d');
let ws = null;
let activeRunId = null;
let screencasting = false;
let frameCount = 0;
let lastFpsTime = Date.now();
let deviceMeta = null;

// --- Run list polling ---
async function refreshRuns() {
  try {
    const res = await fetch('/api/runs');
    const runs = await res.json();
    const list = $('#run-list');
    if (!runs.length) { list.innerHTML = '<div class="empty">No active runs</div>'; return; }
    list.innerHTML = runs.map(r => \`
      <div class="run-card \${r.runId === activeRunId ? 'active' : ''}" data-run-id="\${r.runId}" data-ws="\${r.wsEndpoint || ''}">
        <div><span class="status status-\${r.status}"></span><strong>\${r.extensionId?.slice(0,16) || 'unknown'}...</strong></div>
        <div class="phase">\${r.phase || '?'} · \${r.status}</div>
        <div class="stats">
          <span>req: \${r.stats?.totalRequests ?? '?'}</span>
          <span>ext: \${r.stats?.extensionRequests ?? '?'}</span>
          <span>flag: \${r.stats?.flaggedRequests ?? '?'}</span>
          <span>canary: \${r.stats?.canaryDetections ?? '?'}</span>
        </div>
        <div class="ext-id">\${r.runId?.slice(0,8) || ''}</div>
      </div>
    \`).join('');
    list.querySelectorAll('.run-card').forEach(card => {
      card.addEventListener('click', () => selectRun(card.dataset.runId, card.dataset.ws));
    });
  } catch {}
}
setInterval(refreshRuns, 3000);
refreshRuns();

// --- Run selection ---
async function selectRun(runId, wsEndpoint) {
  activeRunId = runId;
  document.querySelectorAll('.run-card').forEach(c => c.classList.toggle('active', c.dataset.runId === runId));

  // Load pages list
  try {
    const res = await fetch(\`/api/runs/\${runId}/pages\`);
    const pages = await res.json();
    const sel = $('#page-select');
    sel.innerHTML = pages.map((p, i) => \`<option value="\${p.url}">\${p.title || p.url.slice(0,50)}</option>\`).join('');
  } catch {}

  // Connect screencast WebSocket
  connectScreencast(runId);
  refreshLogs(runId);
}

// --- Screencast WebSocket ---
function connectScreencast(runId) {
  if (ws) { ws.close(); ws = null; }
  screencasting = false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(\`\${proto}://\${location.host}/ws/screencast/\${runId}\`);

  ws.onopen = () => {
    $('#connection-status').textContent = 'Connected';
    // Auto-start screencast
    ws.send(JSON.stringify({ type: 'screencast:start', quality: 70, maxWidth: 1280, maxHeight: 800 }));
    screencasting = true;
    $('#btn-screencast').classList.add('active');
    canvas.style.display = 'block';
    $('.placeholder').style.display = 'none';
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'frame') {
      deviceMeta = msg.metadata;
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        frameCount++;
      };
      img.src = 'data:image/jpeg;base64,' + msg.data;

      // FPS counter
      const now = Date.now();
      if (now - lastFpsTime > 1000) {
        $('#fps-counter').textContent = frameCount + ' fps';
        frameCount = 0;
        lastFpsTime = now;
      }
    } else if (msg.type === 'pages') {
      const sel = $('#page-select');
      sel.innerHTML = msg.pages.map(p => \`<option value="\${p.url}">\${p.title || p.url.slice(0,50)}</option>\`).join('');
    } else if (msg.type === 'error') {
      addLog('error', msg.message);
    }
  };

  ws.onclose = () => {
    $('#connection-status').textContent = 'Disconnected';
    screencasting = false;
    $('#btn-screencast').classList.remove('active');
  };
}

// --- Input forwarding ---
canvas.addEventListener('mousedown', (e) => sendMouse('mousePressed', e));
canvas.addEventListener('mouseup', (e) => sendMouse('mouseReleased', e));
canvas.addEventListener('mousemove', (e) => { if (e.buttons) sendMouse('mouseMoved', e); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!ws || !deviceMeta) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * (deviceMeta.deviceWidth || canvas.width);
  const y = (e.clientY - rect.top) / rect.height * (deviceMeta.deviceHeight || canvas.height);
  ws.send(JSON.stringify({ type: 'scroll', x, y, deltaX: e.deltaX, deltaY: e.deltaY }));
}, { passive: false });

canvas.addEventListener('keydown', (e) => { e.preventDefault(); sendKey('keyDown', e); if (e.key.length === 1) sendKey('char', e); });
canvas.addEventListener('keyup', (e) => { e.preventDefault(); sendKey('keyUp', e); });

function sendMouse(type, e) {
  if (!ws || !deviceMeta) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * (deviceMeta.deviceWidth || canvas.width);
  const y = (e.clientY - rect.top) / rect.height * (deviceMeta.deviceHeight || canvas.height);
  const button = ['left', 'middle', 'right'][e.button] || 'left';
  ws.send(JSON.stringify({ type: 'mouse', action: type, x: Math.round(x), y: Math.round(y), button, clickCount: 1 }));
}

function sendKey(type, e) {
  if (!ws) return;
  let modifiers = 0;
  if (e.altKey) modifiers |= 1;
  if (e.ctrlKey) modifiers |= 2;
  if (e.metaKey) modifiers |= 4;
  if (e.shiftKey) modifiers |= 8;
  ws.send(JSON.stringify({ type: 'key', action: type, key: e.key, code: e.code, text: type === 'char' ? e.key : undefined, modifiers }));
}

// --- Toolbar ---
$('#btn-screencast').addEventListener('click', () => {
  if (!ws) return;
  if (screencasting) {
    ws.send(JSON.stringify({ type: 'screencast:stop' }));
    screencasting = false;
    $('#btn-screencast').classList.remove('active');
  } else {
    ws.send(JSON.stringify({ type: 'screencast:start', quality: 70, maxWidth: 1280, maxHeight: 800 }));
    screencasting = true;
    $('#btn-screencast').classList.add('active');
  }
});

$('#page-select').addEventListener('change', (e) => {
  if (!ws || !e.target.value) return;
  ws.send(JSON.stringify({ type: 'page:select', url: e.target.value }));
});

// --- Log stream ---
let logInterval = null;
function refreshLogs(runId) {
  if (logInterval) clearInterval(logInterval);
  const logsDiv = $('#logs');
  logsDiv.innerHTML = '';

  logInterval = setInterval(async () => {
    try {
      const res = await fetch(\`/api/runs/\${runId}/logs\`);
      const logs = await res.json();
      logsDiv.innerHTML = logs.map(l => {
        const cls = l.level === 'error' ? 'log-error' : l.level === 'warn' ? 'log-warn' : 'log-info';
        return \`<div class="log-line \${cls}">\${l.text?.slice(0, 200) || ''}</div>\`;
      }).join('');
      logsDiv.scrollTop = logsDiv.scrollHeight;
    } catch {}
  }, 2000);
}

function addLog(level, text) {
  const logsDiv = $('#logs');
  const cls = level === 'error' ? 'log-error' : level === 'warn' ? 'log-warn' : 'log-info';
  logsDiv.innerHTML += \`<div class="log-line \${cls}">\${text}</div>\`;
  logsDiv.scrollTop = logsDiv.scrollHeight;
}

// Focus canvas for keyboard input
canvas.addEventListener('click', () => canvas.focus());
</script>
</body>
</html>`;
}
