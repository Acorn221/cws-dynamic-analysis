/**
 * Query engine for reading analysis results from disk.
 * Used by the CLI `query` subcommands so an LLM agent can
 * investigate collected data without re-running the analysis.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Glob } from 'glob';

export interface QueryContext {
  outputDir: string;
  summary: any;
  stats: any;
}

/** Load run context from an output directory */
export async function loadContext(outputDir: string): Promise<QueryContext> {
  const summary = JSON.parse(await readFile(join(outputDir, 'summary.json'), 'utf-8'));
  const stats = JSON.parse(await readFile(join(outputDir, 'stats.json'), 'utf-8'));
  return { outputDir, summary, stats };
}

/** Find the JSONL file in the output dir */
async function findJsonl(outputDir: string): Promise<string> {
  const matches = await new Glob('*.jsonl', { cwd: outputDir }).walk();
  if (matches.length === 0) throw new Error(`No JSONL file found in ${outputDir}`);
  return join(outputDir, matches.sort((a, b) => b.length - a.length)[0]); // largest filename
}

/** Stream-read JSONL and filter by predicate */
async function* readJsonl(
  outputDir: string,
  filter?: (entry: any) => boolean,
): AsyncGenerator<any> {
  const path = await findJsonl(outputDir);
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!filter || filter(entry)) yield entry;
    } catch { /* skip malformed lines */ }
  }
}

/** Query network requests with optional filters */
export async function queryNetwork(
  outputDir: string,
  opts: {
    domain?: string;
    method?: string;
    flaggedOnly?: boolean;
    source?: string;
    phase?: string;
    limit?: number;
  } = {},
): Promise<any[]> {
  const results: any[] = [];
  const limit = opts.limit ?? 50;

  for await (const entry of readJsonl(outputDir, (e) => {
    if (e.type !== 'network') return false;
    if (opts.flaggedOnly && !e.flagged) return false;
    if (opts.domain && !e.url?.includes(opts.domain)) return false;
    if (opts.method && e.method !== opts.method.toUpperCase()) return false;
    if (opts.source && e.source !== opts.source) return false;
    if (opts.phase && e.phase !== opts.phase) return false;
    return true;
  })) {
    results.push({
      id: entry.id,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      targetType: entry.targetType,
      source: entry.source,
      phase: entry.phase,
      bodySize: entry.bodySize,
      flagged: entry.flagged,
      flagReasons: entry.flagReasons,
      canaryDetections: entry.canaryDetections?.length ?? 0,
      timestamp: entry.timestamp,
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** Get full details for a specific request by ID */
export async function queryRequestDetail(
  outputDir: string,
  requestId: string,
): Promise<any | null> {
  for await (const entry of readJsonl(outputDir, (e) => e.type === 'network' && e.id === requestId)) {
    return entry;
  }
  return null;
}

/** Query API hook calls with optional filters */
export async function queryHooks(
  outputDir: string,
  opts: {
    api?: string;
    source?: string;
    unique?: boolean;
    limit?: number;
  } = {},
): Promise<any[]> {
  const results: any[] = [];
  const limit = opts.limit ?? 100;

  if (opts.unique) {
    // Collect all matching entries, deduplicate by api name, show counts
    const apiCounts = new Map<string, { count: number; entry: any }>();

    for await (const entry of readJsonl(outputDir, (e) => {
      if (e.type !== 'api_call' && e.type !== 'page_hook') return false;
      if (opts.api && !e.api?.includes(opts.api)) return false;
      if (opts.source && e.callerContext !== opts.source) return false;
      return true;
    })) {
      const key = entry.api;
      const existing = apiCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        apiCounts.set(key, {
          count: 1,
          entry: {
            api: entry.api,
            callerContext: entry.callerContext,
            firstSeen: entry.timestamp,
            sampleArgs: entry.args,
            sampleReturnValue: entry.returnValueSummary,
          },
        });
      }
    }

    // Sort by count descending and apply limit
    const sorted = [...apiCounts.entries()]
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, limit);

    for (const [, { count, entry }] of sorted) {
      results.push({ ...entry, count });
    }

    return results;
  }

  for await (const entry of readJsonl(outputDir, (e) => {
    if (e.type !== 'api_call' && e.type !== 'page_hook') return false;
    if (opts.api && !e.api?.includes(opts.api)) return false;
    if (opts.source && e.callerContext !== opts.source) return false;
    return true;
  })) {
    results.push({
      id: entry.id,
      api: entry.api,
      args: entry.args,
      returnValueSummary: entry.returnValueSummary,
      callerContext: entry.callerContext,
      timestamp: entry.timestamp,
      relatedEvents: entry.relatedEvents,
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** Get all canary detections */
export async function queryCanary(outputDir: string): Promise<any[]> {
  const results: any[] = [];
  for await (const entry of readJsonl(outputDir, (e) =>
    e.type === 'network' && e.canaryDetections?.length > 0,
  )) {
    for (const det of entry.canaryDetections) {
      results.push({
        ...det,
        requestUrl: entry.url,
        requestMethod: entry.method,
        bodyPreview: entry.bodyPreview?.slice(0, 500),
      });
    }
  }
  return results;
}

/** Get unique external domains with request counts */
export async function queryDomains(outputDir: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for await (const entry of readJsonl(outputDir, (e) => {
    if (e.type !== 'network') return false;
    if (e.url?.startsWith('chrome-extension://')) return false;
    if (e.url?.includes('localhost') || e.url?.includes('127.0.0.1')) return false;
    return true;
  })) {
    try {
      const host = new URL(entry.url).hostname;
      if (!host) continue; // skip entries with empty hostname
      counts[host] = (counts[host] ?? 0) + 1;
    } catch { /* skip */ }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([, a], [, b]) => b - a),
  );
}

/** Query console entries from console.json */
export async function queryConsole(
  outputDir: string,
  opts: {
    level?: string;
    source?: string;
    limit?: number;
  } = {},
): Promise<any[]> {
  const filePath = join(outputDir, 'console.json');
  let entries: any[];
  try {
    entries = JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    throw new Error(
      `No console.json found in ${outputDir}. ` +
      'Console data is only available for runs completed with a version that writes console.json.',
    );
  }

  const limit = opts.limit ?? 100;
  const results: any[] = [];

  for (const entry of entries) {
    if (opts.level && opts.level !== 'all' && entry.level !== opts.level) continue;
    if (opts.source && entry.source !== opts.source) continue;
    results.push(entry);
    if (results.length >= limit) break;
  }

  return results;
}

/** Query manifest/extension metadata */
export async function queryManifest(outputDir: string): Promise<any> {
  const summary = JSON.parse(await readFile(join(outputDir, 'summary.json'), 'utf-8'));

  // Try to load the saved manifest.json
  let manifest: any = null;
  try {
    manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf-8'));
  } catch { /* manifest may not have been saved */ }

  return {
    extensionId: summary.extensionId,
    runId: summary.runId,
    status: summary.status,
    durationSeconds: summary.durationSeconds,
    canaryDetections: summary.canaryDetections,
    networkStats: summary.networkStats,
    apiHookStats: summary.apiHookStats,
    // Manifest data
    name: manifest?.name,
    version: manifest?.version,
    manifestVersion: manifest?.manifest_version,
    permissions: manifest?.permissions ?? [],
    hostPermissions: manifest?.host_permissions ?? [],
    contentSecurityPolicy: manifest?.content_security_policy,
    background: manifest?.background,
    contentScripts: manifest?.content_scripts?.map((cs: any) => ({
      matches: cs.matches,
      js: cs.js,
    })),
    externallyConnectable: manifest?.externally_connectable,
  };
}
