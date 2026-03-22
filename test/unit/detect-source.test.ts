import { describe, it, expect } from 'vitest';
import { detectSource } from '../../src/cdp/network.js';

describe('detectSource', () => {
  // --- Gap #6: Content script attribution ---
  // CS fetch() calls running in page context may show as 'page' if there's
  // no chrome-extension:// in the initiator or stack trace.

  it('service_worker → bgsw', () => {
    expect(detectSource('service_worker')).toBe('bgsw');
  });

  it('background_page → bgsw', () => {
    expect(detectSource('background_page')).toBe('bgsw');
  });

  it('page target with no extension signals → page', () => {
    expect(detectSource('page')).toBe('page');
  });

  it('page target with chrome-extension:// initiator → cs', () => {
    expect(detectSource('page', 'chrome-extension://abc123/content.js')).toBe('cs');
  });

  it('page target with chrome-extension:// in stack trace → cs', () => {
    expect(detectSource('page', undefined, 'fetch@chrome-extension://abc123/content.js:10')).toBe('cs');
  });

  it('page target with extension page URL → ext-page', () => {
    expect(detectSource('page', undefined, undefined, 'chrome-extension://abc123/popup.html')).toBe('ext-page');
  });

  it('page target with sandbox URL → sandbox', () => {
    expect(detectSource('page', undefined, undefined, 'chrome-extension://abc123/sandbox.html')).toBe('sandbox');
  });

  it('popup target type → ext-page', () => {
    expect(detectSource('popup')).toBe('ext-page');
  });

  it('content_script target type → cs', () => {
    expect(detectSource('content_script')).toBe('cs');
  });

  it('unknown target type → unknown', () => {
    expect(detectSource('worker' as any)).toBe('unknown');
  });

  // BUG: Content script fetch() with no extension URL in initiator/stack
  // This is Gap #6 — CS fetches in page network stack show as 'page'
  it('page target with no extension signals but actually from CS → misclassified as page', () => {
    // When a content script does fetch('https://evil.com'), the initiator URL
    // is the page URL (not the extension), and there's no stack trace with
    // chrome-extension:// because the fetch runs in the page's network stack.
    const result = detectSource('page', 'https://www.google.com', 'fetch@https://www.google.com:1');
    // This SHOULD be 'cs' but currently returns 'page' — documenting the gap
    expect(result).toBe('page'); // known limitation
  });
});
