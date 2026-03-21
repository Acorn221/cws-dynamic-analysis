import type { EventBuffer } from './buffer.js';
import type { RunConfig } from '../types/config.js';

/**
 * Compresses the full event buffer into a structured summary
 * suitable for LLM consumption (targeting <30K tokens).
 */
export function summarizeForLLM(
  buffer: EventBuffer,
  config: RunConfig,
): string {
  const sections: string[] = [];
  const stats = buffer.getStats();

  // --- Quick verdict for LLM triage ---
  const verdict = computeVerdict(buffer, stats);
  sections.push(`## VERDICT: ${verdict.level}\n${verdict.reason}`);

  // --- Stats header ---
  sections.push(`## Run Summary
- Extension: ${config.extensionId}
- Duration: ${config.scenario.maxDuration}s (wall-clock cap)
- Network requests: ${stats.totalNetworkRequests} (${stats.flaggedRequests} flagged)
- Extension-originated requests: ${stats.extensionRequests}
- External domains: ${stats.externalDomains.length}
- Chrome API calls (extension): ${stats.extensionApiCalls}
- Page API hooks: ${stats.pageApiCalls}
- Canary detections: ${stats.canaryDetections}
- Console errors: ${stats.consoleErrors}
- DOM mutations: ${stats.domMutations}`);

  // --- Canary detections (CRITICAL — always include) ---
  if (buffer.canaryDetections.length > 0) {
    sections.push('## CANARY DATA DETECTED IN OUTBOUND TRAFFIC');
    for (const d of buffer.canaryDetections) {
      sections.push(
        `- **${d.canaryType}** → ${d.destination} (in ${d.matchLocation}, request ${d.foundInRequestId})`,
      );
    }
  }

  // --- Extension-originated network requests (most important) ---
  const extRequests = buffer.networkRequests.filter((r) => r.source === 'extension');
  if (extRequests.length > 0) {
    sections.push(`## Extension Network Requests (${extRequests.length})`);
    for (const req of extRequests.slice(0, 30)) {
      const flags = req.flagReasons.length ? ` flags=[${req.flagReasons.join(', ')}]` : '';
      sections.push(
        `- **${req.method} ${truncate(req.url, 120)}** [${req.status ?? '?'}] phase=${req.phase ?? '?'}${flags}` +
          (req.bodyPreview
            ? `\n  Body: \`${truncate(req.bodyPreview, 200)}\``
            : ''),
      );
    }
  }

  // --- Flagged page requests (secondary) ---
  const flaggedPage = buffer.getFlaggedRequests().filter((r) => r.source !== 'extension');
  if (flaggedPage.length > 0) {
    sections.push(`## Flagged Page Requests (${flaggedPage.length})`);
    for (const req of flaggedPage.slice(0, 15)) {
      const flags = req.flagReasons.join(', ');
      sections.push(
        `- **${req.method} ${truncate(req.url, 120)}** [${req.status ?? '?'}] flags=[${flags}]`,
      );
    }
  }

  // --- Chrome.* API hook calls (extension context) ---
  const extApiCalls = buffer.apiCalls.filter(
    (c) => c.callerContext === 'service_worker' || c.api.startsWith('chrome.'),
  );
  if (extApiCalls.length > 0) {
    sections.push(`## Extension chrome.* API Calls (${extApiCalls.length})`);
    const grouped = new Map<string, typeof extApiCalls>();
    for (const call of extApiCalls) {
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

  // --- Page API hooks (summarized, less important) ---
  const pageApiCalls = buffer.apiCalls.filter(
    (c) => c.callerContext !== 'service_worker' && !c.api.startsWith('chrome.'),
  );
  if (pageApiCalls.length > 0) {
    sections.push(`## Page API Activity (${pageApiCalls.length} calls)`);
    const grouped = new Map<string, number>();
    for (const call of pageApiCalls) {
      grouped.set(call.api, (grouped.get(call.api) ?? 0) + 1);
    }
    const sorted = [...grouped.entries()].sort(([, a], [, b]) => b - a);
    for (const [api, count] of sorted.slice(0, 10)) {
      sections.push(`- ${api} — ${count}x`);
    }
  }

  // --- External domains ---
  if (stats.externalDomains.length > 0) {
    sections.push(`## External Domains Contacted`);
    const domainCounts = new Map<string, number>();
    for (const req of buffer.getExternalRequests()) {
      try {
        const host = new URL(req.url).hostname;
        if (!host) continue;
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
    (e) => e.level === 'error',
  );
  if (errors.length > 0) {
    const extErrors = errors.filter((e) => e.source === 'extension');
    const pageErrors = errors.filter((e) => e.source === 'page');
    sections.push(`## Console Errors (${extErrors.length} extension, ${pageErrors.length} page)`);
    for (const err of extErrors.slice(0, 10)) {
      sections.push(`- [EXT] ${truncate(err.text, 200)}`);
    }
    for (const err of pageErrors.slice(0, 5)) {
      sections.push(`- [PAGE] ${truncate(err.text, 150)}`);
    }
  }

  return sections.join('\n\n');
}

function computeVerdict(
  buffer: EventBuffer,
  stats: ReturnType<EventBuffer['getStats']>,
): { level: string; reason: string } {
  if (stats.canaryDetections > 0) {
    return {
      level: 'CRITICAL — CONFIRMED EXFILTRATION',
      reason: `Canary data detected in ${stats.canaryDetections} outbound request(s). This is confirmed data theft.`,
    };
  }

  const extRequests = buffer.networkRequests.filter((r) => r.source === 'extension');
  const extFlagged = extRequests.filter((r) => r.flagged);

  if (extFlagged.length > 0) {
    return {
      level: 'HIGH — SUSPICIOUS EXTENSION TRAFFIC',
      reason: `${extFlagged.length} flagged request(s) originated from the extension itself. Investigate with: query network <dir> --source extension --flagged`,
    };
  }

  const sensitiveApis = buffer.apiCalls.filter(
    (c) =>
      c.api.startsWith('chrome.cookies') ||
      c.api.startsWith('chrome.history') ||
      c.api.startsWith('chrome.bookmarks'),
  );

  if (sensitiveApis.length > 0 && extRequests.length > 0) {
    return {
      level: 'MEDIUM — SENSITIVE API USE + NETWORK',
      reason: `Extension accessed sensitive APIs (${sensitiveApis.map((a) => a.api).join(', ')}) and made ${extRequests.length} network request(s).`,
    };
  }

  if (extRequests.length > 0) {
    return {
      level: 'LOW — EXTENSION HAS NETWORK ACTIVITY',
      reason: `Extension made ${extRequests.length} network request(s) but no sensitive API use or data exfiltration detected.`,
    };
  }

  return {
    level: 'CLEAN — NO SUSPICIOUS BEHAVIOR',
    reason: 'No canary exfiltration, no extension-originated network requests flagged, no sensitive API abuse detected.',
  };
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + '…';
}
