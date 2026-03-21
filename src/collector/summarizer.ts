import type { EventBuffer } from './buffer.js';
import type { RunConfig } from '../types/config.js';

/**
 * Compresses the full event buffer into a structured summary
 * suitable for LLM consumption (targeting <30K tokens).
 *
 * Strategy:
 * 1. Stats header (always included, ~500 tokens)
 * 2. Canary detections (always included, highest priority)
 * 3. Flagged network requests with body previews
 * 4. API hook calls (grouped by namespace, with counts)
 * 5. Top external domains by request count
 * 6. Console errors from extension context
 * 7. DOM mutations (if any)
 */
export function summarizeForLLM(
  buffer: EventBuffer,
  config: RunConfig,
): string {
  const sections: string[] = [];
  const stats = buffer.getStats();

  // --- Stats header ---
  sections.push(`## Run Summary
- Extension: ${config.extensionId}
- Duration: ${config.scenario.maxDuration}s
- Network requests: ${stats.totalNetworkRequests} (${stats.flaggedRequests} flagged)
- External domains: ${stats.externalDomains.length}
- Chrome API calls: ${stats.totalApiCalls}
- Canary detections: ${stats.canaryDetections}
- Console errors: ${stats.consoleErrors}
- DOM mutations: ${stats.domMutations}`);

  // --- Canary detections (CRITICAL — always include) ---
  if (buffer.canaryDetections.length > 0) {
    sections.push('## ⚠️ CANARY DATA DETECTED IN OUTBOUND TRAFFIC');
    for (const d of buffer.canaryDetections) {
      sections.push(
        `- **${d.canaryType}** → ${d.destination} (in ${d.matchLocation}, request ${d.foundInRequestId})`,
      );
    }
  }

  // --- Flagged network requests ---
  const flagged = buffer.getFlaggedRequests();
  if (flagged.length > 0) {
    sections.push(`## Flagged Network Requests (${flagged.length})`);
    for (const req of flagged.slice(0, 30)) {
      const flags = req.flagReasons.join(', ');
      sections.push(
        `- **${req.method} ${truncate(req.url, 120)}** [${req.status ?? '?'}] from=${req.targetType} flags=[${flags}]` +
          (req.bodyPreview
            ? `\n  Body preview: \`${truncate(req.bodyPreview, 200)}\``
            : ''),
      );
    }
    if (flagged.length > 30) {
      sections.push(`  ... and ${flagged.length - 30} more flagged requests`);
    }
  }

  // --- API hook calls ---
  if (buffer.apiCalls.length > 0) {
    sections.push(`## Chrome API Calls (${buffer.apiCalls.length} total)`);
    // Group by API, show count + sample args
    const grouped = new Map<string, typeof buffer.apiCalls>();
    for (const call of buffer.apiCalls) {
      const existing = grouped.get(call.api) ?? [];
      existing.push(call);
      grouped.set(call.api, existing);
    }
    for (const [api, calls] of grouped) {
      const sample = calls[0];
      sections.push(
        `- **${api}** — ${calls.length}x | sample args: \`${truncate(JSON.stringify(sample.args), 150)}\`` +
          (sample.returnValueSummary
            ? ` → \`${truncate(String(sample.returnValueSummary), 100)}\``
            : ''),
      );
    }
  }

  // --- External domains ---
  if (stats.externalDomains.length > 0) {
    sections.push(`## External Domains Contacted`);
    const domainCounts = new Map<string, number>();
    for (const req of buffer.getExternalRequests()) {
      try {
        const host = new URL(req.url).hostname;
        domainCounts.set(host, (domainCounts.get(host) ?? 0) + 1);
      } catch { /* skip */ }
    }
    const sorted = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted.slice(0, 20)) {
      sections.push(`- ${domain} — ${count} requests`);
    }
  }

  // --- Console errors ---
  const errors = buffer.consoleEntries.filter(
    (e) => e.level === 'error' && e.source === 'extension',
  );
  if (errors.length > 0) {
    sections.push(`## Extension Console Errors (${errors.length})`);
    for (const err of errors.slice(0, 10)) {
      sections.push(`- ${truncate(err.text, 200)}`);
    }
  }

  return sections.join('\n\n');
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + '…';
}
