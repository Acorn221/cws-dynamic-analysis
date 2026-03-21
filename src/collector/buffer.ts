import type { NetworkRequest, ApiCall, ConsoleEntry, DOMMutation, CanaryDetection } from '../types/events.js';

/**
 * In-memory event buffer that accumulates all observations during an analysis run.
 * Provides typed access for each event category and supports querying/filtering.
 */
export class EventBuffer {
  readonly networkRequests: NetworkRequest[] = [];
  readonly apiCalls: ApiCall[] = [];
  readonly consoleEntries: ConsoleEntry[] = [];
  readonly domMutations: DOMMutation[] = [];
  readonly canaryDetections: CanaryDetection[] = [];

  private eventCounter = 0;

  nextId(): string {
    return `evt_${++this.eventCounter}`;
  }

  addNetworkRequest(req: NetworkRequest): void {
    this.networkRequests.push(req);
  }

  addApiCall(call: ApiCall): void {
    this.apiCalls.push(call);
  }

  addConsoleEntry(entry: ConsoleEntry): void {
    this.consoleEntries.push(entry);
  }

  addDOMMutation(mutation: DOMMutation): void {
    this.domMutations.push(mutation);
  }

  addCanaryDetection(detection: CanaryDetection): void {
    this.canaryDetections.push(detection);
  }

  /** Get network requests to external (non-extension, non-localhost) domains */
  getExternalRequests(): NetworkRequest[] {
    return this.networkRequests.filter(
      (r) =>
        !r.url.startsWith('chrome-extension://') &&
        !r.url.includes('localhost') &&
        !r.url.includes('127.0.0.1') &&
        !r.url.startsWith('data:'),
    );
  }

  /** Get unique external domains contacted */
  getExternalDomains(): string[] {
    const domains = new Set<string>();
    for (const req of this.getExternalRequests()) {
      try {
        domains.add(new URL(req.url).hostname);
      } catch { /* invalid URL */ }
    }
    return [...domains].sort();
  }

  /** Get all flagged events (network + API calls) */
  getFlaggedRequests(): NetworkRequest[] {
    return this.networkRequests.filter((r) => r.flagged);
  }

  /** Get API calls for a specific namespace (e.g., "chrome.cookies") */
  getApiCallsByNamespace(ns: string): ApiCall[] {
    return this.apiCalls.filter((c) => c.api.startsWith(ns));
  }

  /** Summary stats for the LLM summarizer */
  getStats() {
    return {
      totalNetworkRequests: this.networkRequests.length,
      externalDomains: this.getExternalDomains(),
      flaggedRequests: this.getFlaggedRequests().length,
      totalApiCalls: this.apiCalls.length,
      apiCallsByNamespace: this.apiCalls.reduce(
        (acc, c) => {
          const ns = c.api.split('.').slice(0, 2).join('.');
          acc[ns] = (acc[ns] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
      canaryDetections: this.canaryDetections.length,
      consoleErrors: this.consoleEntries.filter((e) => e.level === 'error').length,
      domMutations: this.domMutations.length,
    };
  }
}
