import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserSrc = readFileSync(resolve(__dirname, '../../src/cdp/browser.ts'), 'utf-8');

describe('browser launch args', () => {
  it('should NOT include --disable-background-networking', () => {
    // This flag intermittently prevents SW registration in headless Chrome.
    expect(browserSrc).not.toContain('disable-background-networking');
  });

  it('should include STEALTH_ARGS (which contains --no-sandbox)', () => {
    // STEALTH_ARGS is imported from stealth.ts and includes --no-sandbox
    expect(browserSrc).toContain('...STEALTH_ARGS');
  });

  it('should wait at least 3 seconds for SW detection', () => {
    const waitMatch = browserSrc.match(/setTimeout\(r,\s*(\d+)\)/);
    expect(waitMatch).toBeTruthy();
    expect(Number(waitMatch![1])).toBeGreaterThanOrEqual(3000);
  });

  it('should detect both service_worker and background_page targets', () => {
    expect(browserSrc).toContain("'service_worker'");
    expect(browserSrc).toContain("'background_page'");
  });
});
