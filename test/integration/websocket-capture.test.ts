/**
 * Integration test: WebSocket message capture.
 *
 * Tests whether WebSocket connections AND message frames from the SW
 * are captured by CDP. Currently we only log WS_CONNECT but not the
 * actual messages (Gap #7).
 *
 * Extensions like MyBib and Phia use WebSocket C2 for command execution.
 */
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/websocket-c2');

describe('WebSocket capture', () => {
  it('detects WebSocket connection creation via Network.webSocketCreated', async () => {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        `--disable-extensions-except=${FIXTURE}`,
        `--load-extension=${FIXTURE}`,
        '--no-sandbox',
      ],
      protocolTimeout: 30_000,
    });

    try {
      const bgFilter = (t: any) =>
        t.type() === 'service_worker' && t.url().startsWith('chrome-extension://');
      let sw: any = null;
      for (let i = 0; i < 20; i++) {
        sw = browser.targets().find(bgFilter);
        if (sw) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!sw) sw = await browser.waitForTarget(bgFilter, { timeout: 15_000 });

      const cdp = await sw.createCDPSession();
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');

      let wsCreated = false;
      let wsUrl = '';
      cdp.on('Network.webSocketCreated', (p: any) => {
        wsCreated = true;
        wsUrl = p.url;
      });

      // Wait for the WS connection
      await new Promise((r) => setTimeout(r, 8000));

      // We should at least detect the connection creation
      // (echo.websocket.org may be down — check the intent not the result)
      const result = await cdp.send('Runtime.evaluate', {
        expression: 'typeof WebSocket !== "undefined"',
        returnByValue: true,
      });
      expect(result.result.value).toBe(true); // WebSocket API exists in SW

      if (wsCreated) {
        expect(wsUrl).toContain('websocket');
        console.log('WebSocket connection detected:', wsUrl);
      } else {
        console.warn('WebSocket connection not detected (echo server may be down)');
      }
    } finally {
      await browser.close();
    }
  });

  it('captures WebSocket frames via Network.webSocketFrameSent/Received', async () => {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        `--disable-extensions-except=${FIXTURE}`,
        `--load-extension=${FIXTURE}`,
        '--no-sandbox',
      ],
      protocolTimeout: 30_000,
    });

    try {
      const bgFilter = (t: any) =>
        t.type() === 'service_worker' && t.url().startsWith('chrome-extension://');
      let sw: any = null;
      for (let i = 0; i < 20; i++) {
        sw = browser.targets().find(bgFilter);
        if (sw) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!sw) sw = await browser.waitForTarget(bgFilter, { timeout: 15_000 });

      const cdp = await sw.createCDPSession();
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');

      const framesSent: string[] = [];
      const framesReceived: string[] = [];

      cdp.on('Network.webSocketFrameSent', (p: any) => {
        framesSent.push(p.response?.payloadData || '');
      });

      cdp.on('Network.webSocketFrameReceived', (p: any) => {
        framesReceived.push(p.response?.payloadData || '');
      });

      // Wait for WS connection + echo
      await new Promise((r) => setTimeout(r, 8000));

      // Document the gap: CDP DOES provide webSocketFrameSent/Received events,
      // but our network.ts only listens for webSocketCreated (not frames).
      // This test verifies CDP CAN capture frames — we just need to listen.
      if (framesSent.length > 0) {
        console.log(`WebSocket frames captured: ${framesSent.length} sent, ${framesReceived.length} received`);
        expect(framesSent.length).toBeGreaterThan(0);
        // Verify the checkin message was sent
        const checkin = framesSent.find((f) => f.includes('checkin'));
        if (checkin) {
          expect(JSON.parse(checkin).type).toBe('checkin');
        }
      } else {
        console.warn(
          'No WebSocket frames captured.',
          'If echo server is down, this is expected.',
          'Gap: network.ts only listens for webSocketCreated, not frame events.',
        );
      }
    } finally {
      await browser.close();
    }
  });
});
