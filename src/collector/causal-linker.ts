import type { EventBuffer } from './buffer.js';

/**
 * Pre-annotates causal relationships between events.
 * This is critical for LLM analysis — without explicit links,
 * the LLM won't connect an alarm set at T+0 to behavior at T+60min.
 *
 * Strategies:
 * 1. API call → network request (e.g., cookies.getAll → POST with cookies)
 * 2. Alarm creation → alarm fire → triggered behavior
 * 3. Message passing → content script → network request
 * 4. Storage write → storage read → network request (staged exfil)
 */
export function linkCausalChains(buffer: EventBuffer): void {
  linkApiToNetwork(buffer);
  linkStorageChains(buffer);
  linkMessagePassing(buffer);
}

/**
 * Link chrome.* API calls to subsequent network requests.
 * e.g., chrome.cookies.getAll() at T=5s → POST with cookie data at T=6s
 */
function linkApiToNetwork(buffer: EventBuffer): void {
  const sensitiveApis = [
    'chrome.cookies.getAll',
    'chrome.cookies.get',
    'chrome.tabs.query',
    'chrome.history.search',
    'chrome.bookmarks.getTree',
  ];

  for (const call of buffer.apiCalls) {
    if (!sensitiveApis.includes(call.api)) continue;

    const callTime = new Date(call.timestamp).getTime();

    // Find network requests within 10s after the API call
    for (const req of buffer.networkRequests) {
      const reqTime = new Date(req.timestamp).getTime();
      const delta = reqTime - callTime;

      if (delta > 0 && delta < 10_000 && (req.method === 'POST' || req.method === 'PUT')) {
        call.relatedEvents.push(req.id);
        req.relatedEvents.push(call.id);
      }
    }
  }
}

/**
 * Link chrome.storage writes to later reads to later network sends.
 * Catches staged exfiltration: collect data → store → batch send.
 */
function linkStorageChains(buffer: EventBuffer): void {
  const writes = buffer.apiCalls.filter((c) => c.api.includes('storage') && c.api.includes('set'));
  const reads = buffer.apiCalls.filter((c) => c.api.includes('storage') && c.api.includes('get'));

  for (const write of writes) {
    const writeTime = new Date(write.timestamp).getTime();

    // Find reads after writes
    for (const read of reads) {
      const readTime = new Date(read.timestamp).getTime();
      if (readTime > writeTime) {
        write.relatedEvents.push(read.id);
        read.relatedEvents.push(write.id);

        // Find network requests after the read
        for (const req of buffer.networkRequests) {
          const reqTime = new Date(req.timestamp).getTime();
          if (
            reqTime > readTime &&
            reqTime - readTime < 5_000 &&
            (req.method === 'POST' || req.method === 'PUT')
          ) {
            read.relatedEvents.push(req.id);
            req.relatedEvents.push(read.id);
          }
        }
        break; // Link to first read after write
      }
    }
  }
}

/**
 * Link runtime.sendMessage to subsequent network requests.
 * Catches content-script-to-background exfiltration relay.
 */
function linkMessagePassing(buffer: EventBuffer): void {
  const messages = buffer.apiCalls.filter(
    (c) =>
      c.api === 'chrome.runtime.sendMessage' ||
      c.api === 'chrome.tabs.sendMessage' ||
      c.api === 'chrome.runtime.onMessage.fired',
  );

  for (const msg of messages) {
    const msgTime = new Date(msg.timestamp).getTime();

    for (const req of buffer.networkRequests) {
      const reqTime = new Date(req.timestamp).getTime();
      const delta = reqTime - msgTime;

      if (delta > 0 && delta < 5_000 && req.targetType === 'service_worker') {
        msg.relatedEvents.push(req.id);
        req.relatedEvents.push(msg.id);
      }
    }
  }
}
