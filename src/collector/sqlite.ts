/**
 * SQLite event store — writes all collected events into a queryable
 * events.db alongside the JSONL. Agents can use `da sql` to run
 * arbitrary queries against it.
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { NetworkRequest, ApiCall, ConsoleEntry } from '../types/events.js';

export class SqliteStore {
  private db: Database.Database;

  constructor(outputDir: string) {
    this.db = new Database(join(outputDir, 'events.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = OFF'); // Speed — we're write-heavy, crash-safe not needed
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        timestamp TEXT,
        method TEXT,
        url TEXT,
        domain TEXT,
        status INTEGER,
        source TEXT,
        phase TEXT,
        body_size INTEGER,
        body_preview TEXT,
        response_preview TEXT,
        flagged INTEGER DEFAULT 0,
        flag_reasons TEXT,
        canary_count INTEGER DEFAULT 0,
        initiator_url TEXT,
        initiator_stack TEXT
      );

      CREATE TABLE IF NOT EXISTS hooks (
        id TEXT PRIMARY KEY,
        timestamp TEXT,
        api TEXT,
        args TEXT,
        return_value TEXT,
        caller TEXT,
        source TEXT,
        phase TEXT
      );

      CREATE TABLE IF NOT EXISTS console (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        level TEXT,
        source TEXT,
        text TEXT,
        url TEXT,
        phase TEXT
      );

      CREATE TABLE IF NOT EXISTS canary (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        canary_type TEXT,
        canary_value TEXT,
        request_id TEXT,
        destination TEXT,
        match_location TEXT,
        timestamp TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_req_source ON requests(source);
      CREATE INDEX IF NOT EXISTS idx_req_domain ON requests(domain);
      CREATE INDEX IF NOT EXISTS idx_req_flagged ON requests(flagged);
      CREATE INDEX IF NOT EXISTS idx_req_phase ON requests(phase);
      CREATE INDEX IF NOT EXISTS idx_hooks_api ON hooks(api);
      CREATE INDEX IF NOT EXISTS idx_hooks_source ON hooks(source);
      CREATE INDEX IF NOT EXISTS idx_console_level ON console(level);
      CREATE INDEX IF NOT EXISTS idx_console_source ON console(source);
    `);

    this.insertReq = this.db.prepare(`
      INSERT OR REPLACE INTO requests (id, timestamp, method, url, domain, status, source, phase,
        body_size, body_preview, response_preview, flagged, flag_reasons, canary_count,
        initiator_url, initiator_stack)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertHook = this.db.prepare(`
      INSERT OR REPLACE INTO hooks (id, timestamp, api, args, return_value, caller, source, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertConsole = this.db.prepare(`
      INSERT INTO console (timestamp, level, source, text, url, phase)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.insertCanary = this.db.prepare(`
      INSERT INTO canary (canary_type, canary_value, request_id, destination, match_location, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  private insertReq!: Database.Statement;
  private insertHook!: Database.Statement;
  private insertConsole!: Database.Statement;
  private insertCanary!: Database.Statement;

  addRequest(req: NetworkRequest): void {
    let domain = '';
    try { domain = new URL(req.url).hostname; } catch {}
    this.insertReq.run(
      req.id, req.timestamp, req.method, req.url, domain,
      req.status ?? null, req.source, req.phase ?? null,
      req.bodySize ?? null, req.bodyPreview ?? null,
      req.responseBodyPreview ?? null,
      req.flagged ? 1 : 0,
      req.flagReasons?.join(',') || null,
      req.canaryDetections?.length ?? 0,
      req.initiator?.url ?? null,
      req.initiator?.stackTrace ?? null,
    );

    for (const cd of req.canaryDetections ?? []) {
      this.insertCanary.run(
        cd.canaryType, cd.canaryValue, cd.foundInRequestId,
        cd.destination, cd.matchLocation, cd.timestamp,
      );
    }
  }

  addHook(call: ApiCall): void {
    this.insertHook.run(
      call.id, call.timestamp, call.api,
      JSON.stringify(call.args).slice(0, 2000),
      call.returnValueSummary ?? null,
      call.callerContext, call.source ?? null, call.phase ?? null,
    );
  }

  addConsoleEntry(entry: ConsoleEntry): void {
    this.insertConsole.run(
      entry.timestamp, entry.level, entry.source,
      entry.text, entry.url ?? null, entry.phase ?? null,
    );
  }

  close(): void {
    this.db.close();
  }
}
