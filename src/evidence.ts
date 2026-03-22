/**
 * Evidence generator — produces undeniable proof artifacts from analysis results.
 *
 * Outputs:
 *   evidence.har   — Standard HTTP Archive, openable in Chrome DevTools
 *   evidence.json  — Structured claim→proof mapping with full request bodies
 */
import Database from 'better-sqlite3';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';

const log = logger.child({ component: 'evidence' });

interface EvidenceConfig {
  outputDir: string;
  claims?: string[];         // Static analysis claims to prove
  endpoints?: string[];      // Domains to focus on
  flags?: string[];          // Flag categories
  extensionName?: string;
  extensionId?: string;
}

// Column names match SQLite schema (snake_case)
interface EvidenceRequest {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  domain: string;
  source: string;
  phase: string;
  status: number;
  body_size: number;
  body: string;
  response_body: string;
  flagged: number;
  flag_reasons: string;
  canary_count: number;
  initiator_url: string;
  initiator_stack: string;
}

export async function generateEvidence(config: EvidenceConfig): Promise<{
  harPath: string;
  evidencePath: string;
  findings: number;
}> {
  const dbPath = join(config.outputDir, 'events.db');
  const db = new Database(dbPath, { readonly: true });

  // Load summary for context
  let summary: any = {};
  try {
    summary = JSON.parse(await readFile(join(config.outputDir, 'summary.json'), 'utf-8'));
  } catch {}

  // 1. Collect all extension-originated requests (the evidence)
  const extRequests = db.prepare(`
    SELECT * FROM requests
    WHERE source IN ('bgsw', 'cs', 'ext-page')
    ORDER BY timestamp
  `).all() as EvidenceRequest[];

  // 2. Collect flagged requests
  const flaggedRequests = db.prepare(`
    SELECT * FROM requests WHERE flagged = 1 ORDER BY timestamp
  `).all() as EvidenceRequest[];

  // 3. Collect canary detections
  const canaryHits = db.prepare(`SELECT * FROM canary`).all() as any[];

  // 4. Collect chrome API usage
  const apiUsage = db.prepare(`
    SELECT api, count(*) as count, min(timestamp) as first_seen, max(timestamp) as last_seen
    FROM hooks WHERE source = 'bgsw' OR caller = 'service_worker'
    GROUP BY api ORDER BY count DESC
  `).all() as any[];

  // 5. Collect extension console messages
  const extConsole = db.prepare(`
    SELECT * FROM console WHERE source = 'extension' ORDER BY timestamp
  `).all() as any[];

  // 6. Collect requests to specific endpoints (from static analysis)
  const endpointRequests: Record<string, EvidenceRequest[]> = {};
  for (const endpoint of config.endpoints ?? []) {
    const rows = db.prepare(`
      SELECT * FROM requests WHERE domain LIKE ? ORDER BY timestamp
    `).all(`%${endpoint}%`) as EvidenceRequest[];
    if (rows.length > 0) endpointRequests[endpoint] = rows;
  }

  // --- Generate HAR ---
  const har = buildHar(extRequests, flaggedRequests, summary);
  const harPath = join(config.outputDir, 'evidence.har');
  await writeFile(harPath, JSON.stringify(har, null, 2));

  // --- Generate evidence report ---
  const evidence = buildEvidenceReport(config, {
    extRequests,
    flaggedRequests,
    canaryHits,
    apiUsage,
    extConsole,
    endpointRequests,
    summary,
  });
  const evidencePath = join(config.outputDir, 'evidence.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));

  db.close();

  const findings = evidence.findings.length;
  log.info({ findings, har: harPath, evidence: evidencePath }, 'Evidence generated');
  return { harPath, evidencePath, findings };
}

function buildHar(
  extRequests: EvidenceRequest[],
  flaggedRequests: EvidenceRequest[],
  summary: any,
) {
  const allEvidence = [...extRequests, ...flaggedRequests];
  // Dedupe by ID
  const seen = new Set<string>();
  const unique = allEvidence.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'cws-dynamic-analysis',
        version: '0.1.0',
        comment: `Extension: ${summary.extensionId ?? 'unknown'}`,
      },
      entries: unique.map((r) => ({
        startedDateTime: r.timestamp,
        time: 0,
        request: {
          method: r.method,
          url: r.url,
          httpVersion: 'HTTP/1.1',
          headers: [],
          queryString: parseQueryString(r.url),
          postData: r.body
            ? {
                mimeType: 'application/octet-stream',
                text: r.body,
              }
            : undefined,
          headersSize: -1,
          bodySize: r.body_size ?? -1,
          comment: `[${r.source}] ${r.flag_reasons || ''}`.trim(),
        },
        response: {
          status: r.status ?? 0,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: [],
          content: {
            size: -1,
            mimeType: 'text/plain',
            text: r.response_body ?? '',
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        _source: r.source,
        _phase: r.phase,
        _flagged: r.flagged === 1,
        _flagReasons: r.flag_reasons,
        _canaryCount: r.canary_count,
        _initiator: r.initiator_url ?? r.initiator_stack ?? '',
      })),
    },
  };
}

function buildEvidenceReport(
  config: EvidenceConfig,
  data: {
    extRequests: EvidenceRequest[];
    flaggedRequests: EvidenceRequest[];
    canaryHits: any[];
    apiUsage: any[];
    extConsole: any[];
    endpointRequests: Record<string, EvidenceRequest[]>;
    summary: any;
  },
) {
  const findings: any[] = [];

  // Finding: extension network activity
  if (data.extRequests.length > 0) {
    const byDomain: Record<string, number> = {};
    for (const r of data.extRequests) {
      byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;
    }
    findings.push({
      type: 'extension_network_activity',
      severity: 'high',
      title: `Extension made ${data.extRequests.length} network request(s) to ${Object.keys(byDomain).length} domain(s)`,
      domains: byDomain,
      requests: data.extRequests.map(summarizeRequest),
    });
  }

  // Finding: canary data exfiltration
  if (data.canaryHits.length > 0) {
    findings.push({
      type: 'canary_exfiltration',
      severity: 'critical',
      title: `Planted canary data found in ${data.canaryHits.length} outbound request(s)`,
      detail: 'Canary data (fake credentials, CC numbers) was detected leaving the browser. This is confirmed data theft with zero false positive rate.',
      detections: data.canaryHits,
    });
  }

  // Finding: endpoint matches (from static analysis)
  for (const [endpoint, requests] of Object.entries(data.endpointRequests)) {
    findings.push({
      type: 'endpoint_confirmed',
      severity: 'high',
      title: `Traffic to ${endpoint} confirmed (${requests.length} request(s))`,
      detail: `Static analysis identified ${endpoint} as a data destination. Dynamic analysis confirms the extension contacts this endpoint.`,
      requests: requests.map(summarizeRequest),
    });
  }

  // Finding: chrome API abuse
  const sensitiveApis = data.apiUsage.filter((a) =>
    /cookies|history|bookmarks|tabs\.query/.test(a.api),
  );
  if (sensitiveApis.length > 0) {
    findings.push({
      type: 'sensitive_api_usage',
      severity: 'medium',
      title: `Extension used ${sensitiveApis.length} sensitive Chrome API(s)`,
      apis: sensitiveApis,
    });
  }

  // Finding: all chrome API usage (for completeness)
  if (data.apiUsage.length > 0) {
    findings.push({
      type: 'chrome_api_usage',
      severity: 'info',
      title: `${data.apiUsage.reduce((s, a) => s + a.count, 0)} Chrome API calls across ${data.apiUsage.length} API(s)`,
      apis: data.apiUsage,
    });
  }

  return {
    generated: new Date().toISOString(),
    tool: 'cws-dynamic-analysis v0.1.0',
    extension: {
      id: config.extensionId ?? data.summary.extensionId,
      name: config.extensionName,
    },
    run: {
      id: data.summary.runId,
      startedAt: data.summary.startedAt,
      finishedAt: data.summary.finishedAt,
      duration: data.summary.durationSeconds,
      status: data.summary.status,
    },
    stats: {
      totalRequests: data.summary.networkStats?.totalRequests ?? 0,
      extensionRequests: data.extRequests.length,
      flaggedRequests: data.flaggedRequests.length,
      canaryDetections: data.canaryHits.length,
      chromeApiCalls: data.apiUsage.reduce((s: number, a: any) => s + a.count, 0),
      extensionConsoleMessages: data.extConsole.length,
    },
    findings,
    rawEvidence: {
      extensionRequests: data.extRequests.map(summarizeRequest),
      flaggedRequests: data.flaggedRequests.map(summarizeRequest),
      canary: data.canaryHits,
      chromeApis: data.apiUsage,
      extensionConsole: data.extConsole.slice(0, 50),
    },
  };
}

function summarizeRequest(r: EvidenceRequest) {
  return {
    id: r.id,
    timestamp: r.timestamp,
    source: r.source,
    phase: r.phase,
    method: r.method,
    url: r.url,
    domain: r.domain,
    status: r.status,
    bodySize: r.body_size,
    body: r.body ?? null,
    response: r.response_body ?? null,
    flagged: r.flagged === 1,
    flagReasons: r.flag_reasons || null,
    canaryCount: r.canary_count,
    initiator: r.initiator_url || r.initiator_stack || null,
  };
}

function parseQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}
