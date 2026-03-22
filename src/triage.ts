/**
 * Triage — single command that runs all critical queries and returns
 * a compact digest. Replaces 10+ individual query commands.
 */
import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestRow, ApiCountRow, CanaryRow } from './types/cdp.js';

export async function triage(outputDir: string): Promise<string> {
  const lines: string[] = [];

  // Summary
  try {
    const summary = JSON.parse(await readFile(join(outputDir, 'summary.json'), 'utf-8'));
    lines.push(`STATUS: ${summary.status} | ${summary.durationSeconds}s | ${summary.extensionId}`);
  } catch { lines.push('STATUS: no summary.json'); }

  // Verdict
  try {
    const md = await readFile(join(outputDir, 'llm_summary.md'), 'utf-8');
    const verdict = md.match(/^## VERDICT: (.+)$/m);
    if (verdict) lines.push(`VERDICT: ${verdict[1]}`);
  } catch {}

  // SQLite queries
  const dbPath = join(outputDir, 'events.db');
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    lines.push('DB: events.db not found');
    return lines.join('\n');
  }

  // Request breakdown by source
  const sources = db.prepare(
    'SELECT source, count(*) n FROM requests GROUP BY source ORDER BY n DESC',
  ).all() as Array<{ source: string; n: number }>;
  lines.push(`\nREQUESTS: ${sources.map((s) => `${s.source}=${s.n}`).join(' ')}`);

  // Extension domains
  const extDomains = db.prepare(
    "SELECT domain, count(*) n FROM requests WHERE source IN ('bgsw','cs','ext-page') GROUP BY domain ORDER BY n DESC LIMIT 10",
  ).all() as Array<{ domain: string; n: number }>;
  if (extDomains.length) {
    lines.push(`\nEXT DOMAINS:`);
    for (const d of extDomains) lines.push(`  ${d.n}x ${d.domain}`);
  }

  // Flagged
  const flagged = db.prepare(
    'SELECT id, source, method, url, flag_reasons FROM requests WHERE flagged=1 LIMIT 10',
  ).all() as Array<{ id: string; source: string; method: string; url: string; flag_reasons: string }>;
  if (flagged.length) {
    lines.push(`\nFLAGGED (${flagged.length}):`);
    for (const f of flagged) lines.push(`  ${f.id} ${f.source} ${f.method} ${f.url.slice(0, 80)} [${f.flag_reasons}]`);
  }

  // Canary
  const canary = db.prepare('SELECT * FROM canary').all() as CanaryRow[];
  if (canary.length) {
    lines.push(`\nCANARY EXFIL (${canary.length}):`);
    for (const c of canary) lines.push(`  ${c.canary_type} → ${c.destination} (${c.match_location})`);
  } else {
    lines.push(`\nCANARY: none`);
  }

  // Chrome APIs
  const apis = db.prepare(
    "SELECT api, count(*) n FROM hooks WHERE source='bgsw' OR caller='service_worker' GROUP BY api ORDER BY n DESC LIMIT 10",
  ).all() as ApiCountRow[];
  if (apis.length) {
    lines.push(`\nCHROME APIS:`);
    for (const a of apis) lines.push(`  ${a.count}x ${a.api}`);
  }

  // Extension console errors
  const errors = db.prepare(
    "SELECT count(*) n FROM console WHERE source='extension' AND level='error'",
  ).get() as { n: number };
  if (errors.n > 0) lines.push(`\nEXT ERRORS: ${errors.n}`);

  // Extension requests with bodies (for evidence)
  // Handle both old (body_preview) and new (body) column names
  const bodyCol = (() => {
    try { db.prepare('SELECT body FROM requests LIMIT 0').run(); return 'body'; } catch { return 'body_preview'; }
  })();
  const withBodies = db.prepare(
    `SELECT id, method, url, length(${bodyCol}) bodylen FROM requests WHERE source IN ('bgsw','cs') AND ${bodyCol} IS NOT NULL AND ${bodyCol} != '' ORDER BY bodylen DESC LIMIT 5`,
  ).all() as Array<{ id: string; method: string; url: string; bodylen: number }>;
  if (withBodies.length) {
    lines.push(`\nEXT REQUESTS WITH BODIES:`);
    for (const r of withBodies) lines.push(`  ${r.id} ${r.method} ${r.url.slice(0, 60)} (${r.bodylen} bytes)`);
  }

  db.close();

  lines.push(`\nNEXT: da sql ${outputDir} "SELECT ..." for deeper investigation`);

  return lines.join('\n');
}
