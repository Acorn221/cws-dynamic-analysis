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
    return true;
  })) {
    results.push({
      id: entry.id,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      targetType: entry.targetType,
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
    limit?: number;
  } = {},
): Promise<any[]> {
  const results: any[] = [];
  const limit = opts.limit ?? 100;

  for await (const entry of readJsonl(outputDir, (e) => {
    if (e.type !== 'api_call' && e.type !== 'page_hook') return false;
    if (opts.api && !e.api?.includes(opts.api)) return false;
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
      counts[host] = (counts[host] ?? 0) + 1;
    } catch { /* skip */ }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([, a], [, b]) => b - a),
  );
}
