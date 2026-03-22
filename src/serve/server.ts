/**
 * Dashboard HTTP + WebSocket server.
 * Serves the monitoring dashboard and bridges CDP screencast.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RunRegistry } from './run-registry.js';
import { ScreencastBridge } from './screencast.js';
import { getDashboardHtml } from './dashboard.js';
import { logger } from '../logger.js';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const log = logger.child({ component: 'serve' });

export interface ServeOptions {
  port: number;
  host: string;
  outputDir: string;
}

export async function startDashboardServer(opts: ServeOptions): Promise<void> {
  const registry = new RunRegistry(opts.outputDir);
  const bridges = new Map<string, ScreencastBridge>();

  // Periodic registry refresh
  await registry.refresh();
  setInterval(() => registry.refresh(), 3000);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Dashboard HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHtml());
      return;
    }

    // API: list runs
    if (url.pathname === '/api/runs') {
      await registry.refresh();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(registry.getRuns()));
      return;
    }

    // API: run pages
    const pagesMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/pages$/);
    if (pagesMatch) {
      const runId = pagesMatch[1];
      const run = registry.getRun(runId);
      if (!run?.wsEndpoint) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Run not found or no browser' }));
        return;
      }

      try {
        let bridge = bridges.get(runId);
        if (!bridge) {
          bridge = new ScreencastBridge();
          await bridge.connect(run.wsEndpoint);
          bridges.set(runId, bridge);
        }
        const pages = await bridge.listPages();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pages));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: run logs (from events.db console table)
    const logsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/logs$/);
    if (logsMatch) {
      const runId = logsMatch[1];
      const run = registry.getRun(runId);
      if (!run?.outputDir) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }

      const dbPath = join(run.outputDir, 'events.db');
      if (!existsSync(dbPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }

      try {
        const db = new Database(dbPath, { readonly: true });
        const logs = db.prepare(
          "SELECT level, text, source, phase FROM console ORDER BY rowid DESC LIMIT 100",
        ).all();
        db.close();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs.reverse()));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // WebSocket server for screencast
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/ws\/screencast\/(.+)$/);
    if (!match) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const runId = match[1];
      handleScreencastConnection(ws, runId, registry, bridges);
    });
  });

  server.listen(opts.port, opts.host, () => {
    log.info({ port: opts.port, host: opts.host }, 'Dashboard server started');
    console.log(`\n  Dashboard: http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}\n`);
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    for (const bridge of bridges.values()) bridge.disconnect();
    server.close();
    process.exit(0);
  });
}

async function handleScreencastConnection(
  ws: WebSocket,
  runId: string,
  registry: RunRegistry,
  bridges: Map<string, ScreencastBridge>,
): void {
  const run = registry.getRun(runId);
  if (!run?.wsEndpoint) {
    ws.send(JSON.stringify({ type: 'error', message: 'Run not found or no browser available' }));
    ws.close();
    return;
  }

  log.info({ runId: runId.slice(0, 8) }, 'Screencast client connected');

  let bridge = bridges.get(runId);
  if (!bridge) {
    bridge = new ScreencastBridge();
    try {
      await bridge.connect(run.wsEndpoint);
      bridges.set(runId, bridge);
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', message: `Failed to connect to browser: ${err.message}` }));
      ws.close();
      return;
    }
  }

  // Send initial page list
  const pages = await bridge.listPages();
  ws.send(JSON.stringify({ type: 'pages', pages }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'screencast:start':
          await bridge!.start(ws, {
            quality: msg.quality,
            maxWidth: msg.maxWidth,
            maxHeight: msg.maxHeight,
          });
          break;

        case 'screencast:stop':
          await bridge!.stop();
          break;

        case 'mouse':
          await bridge!.dispatchMouse({
            type: msg.action,
            x: msg.x,
            y: msg.y,
            button: msg.button,
            clickCount: msg.clickCount,
            modifiers: msg.modifiers,
          });
          break;

        case 'scroll':
          await bridge!.dispatchMouse({
            type: 'scroll',
            x: msg.x,
            y: msg.y,
            deltaX: msg.deltaX,
            deltaY: msg.deltaY,
          });
          break;

        case 'key':
          await bridge!.dispatchKey({
            type: msg.action,
            key: msg.key,
            code: msg.code,
            text: msg.text,
            modifiers: msg.modifiers,
          });
          break;

        case 'page:select':
          const ok = await bridge!.selectPage(msg.url);
          if (ok) {
            await bridge!.start(ws, { quality: 70, maxWidth: 1280, maxHeight: 800 });
          }
          break;

        case 'page:list':
          const pageList = await bridge!.listPages();
          ws.send(JSON.stringify({ type: 'pages', pages: pageList }));
          break;
      }
    } catch (err: any) {
      log.warn({ err: err.message }, 'Screencast message error');
    }
  });

  ws.on('close', () => {
    log.info({ runId: runId.slice(0, 8) }, 'Screencast client disconnected');
    bridge?.stop().catch(() => {});
  });
}
