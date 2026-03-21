/**
 * Extension source rewriter — modifies extension JS files to prepend
 * Proxy-based chrome.* API wrappers before loading.
 *
 * More reliable than runtime injection because:
 * - Survives service worker restarts
 * - Catches initialization-time API calls
 * - No race condition with waitForDebuggerOnStart
 */
import { readdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { logger } from '../logger.js';

const log = logger.child({ component: 'rewriter' });

/**
 * Copy the extension to a temp directory and prepend monitoring code
 * to all JS files. Returns the path to the modified copy.
 */
export async function rewriteExtension(
  extensionPath: string,
  outputPath: string,
): Promise<string> {
  // Copy extension to output
  await cp(extensionPath, outputPath, { recursive: true });

  // Find all JS files
  const jsFiles = await findJsFiles(outputPath);
  log.info({ count: jsFiles.length }, 'Found JS files to instrument');

  // Read the SW hook template
  const hookCode = await readFile(
    join(import.meta.dirname, '../../hooks/sw-hooks.js'),
    'utf-8',
  );

  // Prepend to the main background/service worker script
  // (identified from manifest.json)
  const manifest = JSON.parse(
    await readFile(join(outputPath, 'manifest.json'), 'utf-8'),
  );

  const bgScript = getBackgroundScript(manifest);
  if (bgScript) {
    const bgPath = join(outputPath, bgScript);
    const original = await readFile(bgPath, 'utf-8');
    await writeFile(bgPath, hookCode + '\n;\n' + original);
    log.info({ file: bgScript }, 'Injected hooks into background script');
  } else {
    log.warn('No background script found in manifest');
  }

  return outputPath;
}

function getBackgroundScript(manifest: any): string | null {
  // MV3: service_worker
  if (manifest.background?.service_worker) {
    return manifest.background.service_worker;
  }
  // MV2: scripts array
  if (manifest.background?.scripts?.length) {
    return manifest.background.scripts[0];
  }
  // MV2: page
  if (manifest.background?.page) {
    return manifest.background.page;
  }
  return null;
}

async function findJsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name) === '.js') {
      results.push(join(entry.parentPath ?? dir, entry.name));
    }
  }
  return results;
}
