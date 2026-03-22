// Simulates: MyBib (WebSocket C2 at ws.mybib.com), Phia (WebSocket task execution)
// Pattern: SW connects to WebSocket server and receives commands.
// Tests whether WS connection AND message frames are captured.

// Use a public echo server for testing
const WS_URL = 'wss://echo.websocket.org';

function connectC2() {
  try {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[TEST] WebSocket connected');
      // Send a command to the C2
      ws.send(JSON.stringify({
        type: 'checkin',
        extId: chrome.runtime.id,
        ts: Date.now(),
      }));
    };

    ws.onmessage = (event) => {
      console.log('[TEST] WebSocket message received:', event.data?.slice?.(0, 100));
      // Echo server returns our message — in real C2 this would be a command
    };

    ws.onerror = (err) => {
      console.log('[TEST] WebSocket error (expected if echo server is down)');
    };

    ws.onclose = () => {
      console.log('[TEST] WebSocket closed, reconnecting in 5s');
      setTimeout(connectC2, 5000);
    };
  } catch (e) {
    console.log('[TEST] WebSocket failed:', e.message);
  }
}

connectC2();
setInterval(() => {}, 25000);
console.log('[TEST] WebSocket C2 SW started');
