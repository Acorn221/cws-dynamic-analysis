/**
 * Extension source rewriter — copies the extension directory for isolated loading.
 *
 * NOTE: We do NOT modify any JS files in the copy. CWS-downloaded extensions
 * have _metadata/verified_contents.json which makes Chrome verify file hashes.
 * Modified files get ERR_FILE_NOT_FOUND. All instrumentation (hooks, keep-alive)
 * is done via CDP Runtime.evaluate after the SW loads.
 *
 * The copy is still useful for isolation — we load from a temp dir so we don't
 * pollute the original extension directory with Chrome profile artifacts.
 */
import { cp } from 'node:fs/promises';
import { logger } from '../logger.js';

const log = logger.child({ component: 'rewriter' });

/**
 * Copy the extension to outputPath for isolated loading.
 * Returns the path to the copy.
 */
export async function rewriteExtension(
  extensionPath: string,
  outputPath: string,
): Promise<string> {
  await cp(extensionPath, outputPath, { recursive: true });
  log.info('Extension copied for isolated loading');
  return outputPath;
}
