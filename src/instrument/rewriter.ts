/**
 * Extension source rewriter — copies the extension and prepends
 * chrome.* API wrappers into the background/service worker script.
 *
 * More reliable than runtime injection because:
 * - Survives service worker restarts
 * - Catches initialization-time API calls
 * - No race condition with waitForDebuggerOnStart
 */
import { readFile, writeFile, cp, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { logger } from '../logger.js';

const log = logger.child({ component: 'rewriter' });

function findHooksDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(thisDir, '../hooks'),
    resolve(thisDir, '../../hooks'),
    resolve(process.cwd(), 'hooks'),
  ]) {
    try { statSync(join(candidate, 'sw-hooks.js')); return candidate; } catch {}
  }
  return resolve(process.cwd(), 'hooks');
}

/**
 * Copy the extension to outputPath and prepend monitoring hooks
 * to the background/service worker script. Returns the path to
 * the modified copy (which should be loaded instead of the original).
 */
export async function rewriteExtension(
  extensionPath: string,
  outputPath: string,
): Promise<string> {
  await cp(extensionPath, outputPath, { recursive: true });

  const manifest = JSON.parse(
    await readFile(join(outputPath, 'manifest.json'), 'utf-8'),
  );

  // Note: We do NOT rewrite the background/service worker script.
  // SW hooks use console.log('[CWS_HOOK]', ...) which requires CDP
  // Runtime.enable to be active. Since CDP attaches AFTER the SW starts,
  // source-rewritten hooks would fire before CDP is listening.
  // Instead, SW hooks are injected via Runtime.evaluate at CDP attach time.

  const hooksDir = findHooksDir();

  // Also inject page hooks into content scripts if they exist
  const contentScripts = manifest.content_scripts ?? [];
  for (const cs of contentScripts) {
    for (const jsFile of cs.js ?? []) {
      const csPath = join(outputPath, jsFile);
      try {
        const pageHookCode = await readFile(join(hooksDir, 'page-hooks.js'), 'utf-8');
        const csOriginal = await readFile(csPath, 'utf-8');
        await writeFile(csPath, pageHookCode + '\n;\n' + csOriginal);
        log.info({ file: jsFile }, 'Injected page hooks into content script');
      } catch {
        log.debug({ file: jsFile }, 'Could not inject into content script');
      }
    }
  }

  return outputPath;
}

function getBackgroundScript(manifest: any): string | null {
  if (manifest.background?.service_worker) return manifest.background.service_worker;
  if (manifest.background?.scripts?.length) return manifest.background.scripts[0];
  if (manifest.background?.page) return manifest.background.page;
  return null;
}
