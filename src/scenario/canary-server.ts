/**
 * Local HTTP server that serves canary pages (login, banking, checkout).
 * These are realistic-looking pages with form fields that get filled
 * with canary data during the scenario to detect credential theft.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { logger } from '../logger.js';

const log = logger.child({ component: 'canary-server' });

function findPagesDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(thisDir, '../canary-pages'),
    resolve(thisDir, '../../canary-pages'),
    resolve(process.cwd(), 'canary-pages'),
  ]) {
    try { statSync(join(candidate, 'login.html')); return candidate; } catch {}
  }
  return resolve(process.cwd(), 'canary-pages');
}
const PAGES_DIR = findPagesDir();

let server: Server | null = null;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function startCanaryServer(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      const actualPort = (server?.address() as any)?.port ?? port;
      const url = new URL(req.url ?? '/', `http://localhost:${actualPort}`);
      let filePath: string;

      // Map routes to files
      switch (url.pathname) {
        case '/':
        case '/login':
        case '/login.html':
          filePath = join(PAGES_DIR, 'login.html');
          break;
        case '/banking':
        case '/banking.html':
          filePath = join(PAGES_DIR, 'banking.html');
          break;
        case '/checkout':
        case '/checkout.html':
          filePath = join(PAGES_DIR, 'checkout.html');
          break;
        default:
          // Try serving directly from pages dir
          filePath = join(PAGES_DIR, url.pathname);
      }

      try {
        const content = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] ?? 'text/html; charset=utf-8',
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const actualPort = (server!.address() as any).port as number;
      log.info({ port: actualPort }, 'Canary page server listening');
      resolve(actualPort);
    });

    server.on('error', reject);
  });
}

export async function stopCanaryServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      log.info('Canary server stopped');
      server = null;
      resolve();
    });
  });
}
