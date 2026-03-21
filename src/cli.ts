#!/usr/bin/env node
/**
 * cws-dynamic-analyze — Automated dynamic analysis of Chrome extensions via CDP.
 *
 * USAGE FOR LLM AGENTS:
 *   1. Run analysis:    node dist/cli.js run <extension-dir> --headless -o ./output/ext-id
 *   2. Read summary:    cat ./output/ext-id/llm_summary.md
 *   3. Query details:   node dist/cli.js query network ./output/ext-id --flagged
 *   4. Get request:     node dist/cli.js query request ./output/ext-id <request-id>
 *   5. Check canary:    node dist/cli.js query canary ./output/ext-id
 *   6. List hooks:      node dist/cli.js query hooks ./output/ext-id --api chrome.cookies
 *   7. List domains:    node dist/cli.js query domains ./output/ext-id
 *   8. Console logs:    node dist/cli.js query console ./output/ext-id --level error
 *   9. Manifest info:   node dist/cli.js query manifest ./output/ext-id
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { defaultConfig, type PhaseId } from './types/config.js';
import { analyze } from './analyzer.js';
import {
  queryNetwork,
  queryRequestDetail,
  queryHooks,
  queryCanary,
  queryDomains,
  queryConsole,
  queryManifest,
  loadContext,
} from './query.js';

const program = new Command();

program
  .name('cws-dynamic-analyze')
  .description(
    'Automated dynamic analysis of Chrome extensions via CDP.\n\n' +
    'Launches Chrome with an extension, runs browsing scenarios with canary data,\n' +
    'monitors network requests and chrome.* API calls, detects data exfiltration.\n\n' +
    'LLM AGENT WORKFLOW:\n' +
    '  1. run  — Analyze extension, produces summary + JSONL event log\n' +
    '  2. Read llm_summary.md for overview\n' +
    '  3. query — Drill into specific events, requests, or API calls',
  )
  .version('0.1.0');

// ============================================================
// RUN command
// ============================================================
program
  .command('run')
  .description(
    'Analyze a single extension. Launches Chrome, loads the extension,\n' +
    'runs browsing scenarios (login/banking/checkout with canary data),\n' +
    'and captures all network + API activity.\n\n' +
    'Output files:\n' +
    '  summary.json    — Run metadata, stats, timing\n' +
    '  stats.json      — Event counts by category\n' +
    '  llm_summary.md  — Formatted summary for LLM consumption\n' +
    '  console.json    — Console log entries from extension and page\n' +
    '  *.jsonl         — Raw event stream (network requests, API hooks)',
  )
  .argument('<extension-path>', 'Path to unpacked extension directory (must contain manifest.json)')
  .option('-i, --extension-id <id>', 'Extension ID (auto-detected from Chrome if omitted)')
  .option('-o, --output <dir>', 'Output directory for results', './output')
  .option('--headless', 'Run headless (no display needed)', false)
  .option('--no-stealth', 'Disable puppeteer-extra-plugin-stealth')
  .option('--no-instrument', 'Skip source rewriting (use runtime injection only)')
  .option('--session <dir>', 'Reuse browser from an interact session (same profile/state)')
  .option('--quick', 'Quick mode: 30s, browse+login only, for testing tool changes', false)
  .option('--duration <seconds>', 'Max scenario duration in seconds', '120')
  .option('--chrome-path <path>', 'Chrome binary path (auto-detected if omitted)')
  .option('--interact-model <model>', 'Model for extension UI interaction', 'claude-haiku-4-5-20251001')
  .option(
    '--phases <phases>',
    'Comma-separated phases: install,ext-interact,browse,login,banking,shopping,idle,tabs',
    'install,ext-interact,browse,login,banking,shopping,idle,tabs',
  )
  .action(async (extensionPath: string, opts: any) => {
    const absPath = resolve(extensionPath);

    try {
      const s = await stat(absPath);
      if (!s.isDirectory()) {
        console.error('ERROR: Extension path must be a directory');
        process.exit(1);
      }
      await stat(resolve(absPath, 'manifest.json'));
    } catch {
      console.error(`ERROR: No manifest.json found at ${absPath}`);
      process.exit(1);
    }

    const config = defaultConfig(opts.extensionId ?? 'unknown', absPath);
    config.outputDir = resolve(opts.output);
    config.browser.headless = opts.headless;
    config.browser.stealth = opts.stealth !== false;
    config.instrument = opts.instrument !== false;
    config.sessionDir = opts.session ? resolve(opts.session) : undefined;
    config.browser.executablePath = opts.chromePath;
    if (opts.quick) {
      config.scenario.maxDuration = 30;
      config.scenario.phases = ['browse', 'login'] as PhaseId[];
    } else {
      config.scenario.maxDuration = parseInt(opts.duration, 10);
      config.scenario.phases = opts.phases.split(',').map((s: string) => s.trim()) as PhaseId[];
    }
    if (opts.interactModel) config.analysis.triageModel = opts.interactModel;

    logger.info({
      extensionPath: absPath,
      duration: config.scenario.maxDuration,
      phases: config.scenario.phases,
    }, 'Starting analysis');

    try {
      const result = await analyze(config);

      // Compact output — agent reads details via query commands
      const s = result.summary;
      console.log(`DONE status=${s.status} requests=${s.networkStats.totalRequests} flagged=${s.networkStats.flaggedRequests} canary=${s.canaryDetections} dir=${result.outputDir}`);
    } catch (err: any) {
      console.error(`Analysis failed: ${err.message}`);
      process.exit(1);
    }
  });

// ============================================================
// QUERY command group
// ============================================================
const query = program
  .command('query')
  .alias('q')
  .description(
    'Query collected data from a previous analysis run.\n' +
    'All subcommands output JSON to stdout for easy parsing.',
  );

// --- query network ---
query
  .command('network').alias('net')
  .description(
    'List network requests from the analysis run.\n' +
    'Shows: id, method, url, status, source, phase, flags, canary detections.\n\n' +
    'Examples:\n' +
    '  query network ./output/ext-id                          # all requests (limit 50)\n' +
    '  query network ./output/ext-id --flagged                 # suspicious only\n' +
    '  query network ./output/ext-id --domain evil.com          # filter by domain\n' +
    '  query network ./output/ext-id --method POST              # POST requests only\n' +
    '  query network ./output/ext-id --source extension         # extension-originated only\n' +
    '  query network ./output/ext-id --phase login              # requests during login phase',
  )
  .argument('<output-dir>', 'Path to analysis output directory')
  .option('--domain <domain>', 'Filter by domain substring')
  .option('--method <method>', 'Filter by HTTP method (GET, POST, etc.)')
  .option('--flagged', 'Only show flagged/suspicious requests', false)
  .option('--source <source>', 'Filter by source (extension, page, unknown)')
  .option('--phase <phase>', 'Filter by scenario phase (install, browse, login, banking, etc.)')
  .option('--limit <n>', 'Max results', '50')
  .option('--json', 'Full JSON output (default: compact one-line-per-request)')
  .action(async (outputDir: string, opts: any) => {
    const results = await queryNetwork(resolve(outputDir), {
      domain: opts.domain,
      method: opts.method,
      flaggedOnly: opts.flagged,
      source: opts.source,
      phase: opts.phase,
      limit: parseInt(opts.limit, 10),
    });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      // Compact: one line per request, token-efficient
      for (const r of results) {
        const flags = r.flagReasons?.length ? ` [${r.flagReasons.join(',')}]` : '';
        const canary = r.canaryDetections > 0 ? ` CANARY=${r.canaryDetections}` : '';
        console.log(`${r.id} ${r.source} ${r.method} ${r.status ?? '?'} ${r.url.slice(0, 100)}${flags}${canary}`);
      }
      console.error(`${results.length} requests`);
    }
  });

// --- query request ---
query
  .command('request').alias('req')
  .description(
    'Get full details for a specific network request by ID.\n' +
    'Includes headers, body preview, response body, canary matches.\n' +
    'Use after "query network" to drill into suspicious requests.',
  )
  .argument('<output-dir>', 'Path to analysis output directory')
  .argument('<request-id>', 'Request ID from "query network" output')
  .action(async (outputDir: string, requestId: string) => {
    const result = await queryRequestDetail(resolve(outputDir), requestId);
    if (!result) {
      console.error(`Request ${requestId} not found`);
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  });

// --- query hooks ---
query
  .command('hooks').alias('h')
  .description(
    'List chrome.* API calls and page hook callbacks.\n' +
    'Shows: api name, arguments, return value, caller context.\n\n' +
    'Examples:\n' +
    '  query hooks ./output/ext-id                            # all hooks\n' +
    '  query hooks ./output/ext-id --api chrome.cookies        # cookie API only\n' +
    '  query hooks ./output/ext-id --api chrome.tabs           # tab enumeration\n' +
    '  query hooks ./output/ext-id --source service_worker     # SW calls only\n' +
    '  query hooks ./output/ext-id --unique                    # deduplicated by API name',
  )
  .argument('<output-dir>', 'Path to analysis output directory')
  .option('--api <name>', 'Filter by API namespace (e.g., chrome.cookies, page.fetch)')
  .option('--source <source>', 'Filter by caller context (service_worker, page, etc.)')
  .option('--unique', 'Deduplicate by API name, show call count per API', false)
  .option('--limit <n>', 'Max results', '100')
  .option('--json', 'Full JSON output')
  .action(async (outputDir: string, opts: any) => {
    const results = await queryHooks(resolve(outputDir), {
      api: opts.api,
      source: opts.source,
      unique: opts.unique,
      limit: parseInt(opts.limit, 10),
    });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else if (opts.unique) {
      for (const r of results) {
        console.log(`${r.count}x ${r.api} (${r.callerContext})`);
      }
    } else {
      for (const r of results) {
        const args = JSON.stringify(r.args).slice(0, 80);
        console.log(`${r.id} ${r.api} ${args}`);
      }
    }
    console.error(`${results.length} results`);
  });

// --- query canary ---
query
  .command('canary').alias('c')
  .description(
    'Show all canary data detections — the strongest exfiltration evidence.\n' +
    'If canary data (planted credentials, CC numbers, etc.) appeared in any\n' +
    'outbound request, that is CONFIRMED data theft with zero false positives.',
  )
  .argument('<output-dir>', 'Path to analysis output directory')
  .action(async (outputDir: string) => {
    const results = await queryCanary(resolve(outputDir));
    if (results.length === 0) {
      console.log('[]');
      console.error('No canary detections — extension did not exfiltrate planted data.');
    } else {
      console.log(JSON.stringify(results, null, 2));
      console.error(`⚠️  ${results.length} canary detection(s) found!`);
    }
  });

// --- query domains ---
query
  .command('domains').alias('dom')
  .description(
    'List all external domains contacted, sorted by request count.\n' +
    'Excludes chrome-extension:// and localhost requests.',
  )
  .argument('<output-dir>', 'Path to analysis output directory')
  .option('--json', 'Full JSON output')
  .action(async (outputDir: string, opts: any) => {
    const results = await queryDomains(resolve(outputDir));
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const [domain, count] of Object.entries(results)) {
        console.log(`${count} ${domain}`);
      }
    }
  });

// --- query console ---
query
  .command('console').alias('log')
  .description(
    'List console log entries from the analysis run.\n' +
    'Reads from console.json written at the end of analysis.\n\n' +
    'Examples:\n' +
    '  query console ./output/ext-id                          # all entries (limit 100)\n' +
    '  query console ./output/ext-id --level error             # errors only\n' +
    '  query console ./output/ext-id --source extension        # extension logs only\n' +
    '  query console ./output/ext-id --level warn --limit 20   # first 20 warnings',
  )
  .argument('<output-dir>', 'Path to analysis output directory')
  .option('--level <level>', 'Filter by level (error, warn, log, debug, info, all)', 'all')
  .option('--source <source>', 'Filter by source (extension, page, hook)')
  .option('--limit <n>', 'Max results', '100')
  .action(async (outputDir: string, opts: any) => {
    const results = await queryConsole(resolve(outputDir), {
      level: opts.level,
      source: opts.source,
      limit: parseInt(opts.limit, 10),
    });
    console.log(JSON.stringify(results, null, 2));
    if (results.length === 0) {
      console.error('No console entries matching filters.');
    } else {
      console.error(`${results.length} console entries returned.`);
    }
  });

// --- query manifest ---
query
  .command('manifest').alias('man')
  .description(
    'Show extension metadata and run configuration from summary.json.\n' +
    'Includes: extension ID, run timing, scenario config, network/API stats.',
  )
  .argument('<output-dir>', 'Path to analysis output directory')
  .action(async (outputDir: string) => {
    const result = await queryManifest(resolve(outputDir));
    console.log(JSON.stringify(result, null, 2));
  });

// --- query summary ---
query
  .command('summary').alias('sum')
  .description('Print the LLM-formatted summary from a previous run.')
  .argument('<output-dir>', 'Path to analysis output directory')
  .action(async (outputDir: string) => {
    const summary = await readFile(resolve(outputDir, 'llm_summary.md'), 'utf-8');
    console.log(summary);
  });

// --- query stats ---
query
  .command('stats').alias('st')
  .description('Print run statistics (event counts, domains, API usage).')
  .argument('<output-dir>', 'Path to analysis output directory')
  .action(async (outputDir: string) => {
    const stats = await readFile(resolve(outputDir, 'stats.json'), 'utf-8');
    console.log(stats);
  });

// ============================================================
// INTERACT command group — agent-driven extension UI interaction
// ============================================================
import {
  interactStart,
  interactAction,
  interactSnapshot,
  interactStop,
} from './interact.js';

const interact = program
  .command('interact').alias('i')
  .description(
    'Drive extension popup/options UI via CLI commands.\n' +
    'A Claude Code agent uses these to navigate onboarding flows.\n\n' +
    'Workflow:\n' +
    '  1. interact start <ext-path> -o ./session    → launches browser, opens popup, prints DOM\n' +
    '  2. interact action ./session \'{"action":"click","selector":"#accept"}\'  → clicks, prints new DOM\n' +
    '  3. interact snapshot ./session                → re-print current DOM\n' +
    '  4. interact stop ./session                    → close browser\n' +
    '  5. run <ext-path> -o ./results --no-instrument --phases browse,login,...  → run scenario',
  );

interact
  .command('start').alias('s')
  .description('Launch Chrome with extension, open popup, print DOM snapshot.')
  .argument('<extension-path>', 'Path to unpacked extension directory')
  .option('-o, --output <dir>', 'Session directory', './interact-session')
  .option('--chrome-path <path>', 'Chrome binary path')
  .option('--headless', 'Run headless', false)
  .action(async (extensionPath: string, opts: any) => {
    const snapshot = await interactStart(resolve(extensionPath), resolve(opts.output), {
      chromePath: opts.chromePath,
      headless: opts.headless,
    });
    console.log(snapshot);
  });

interact
  .command('action').alias('a')
  .description(
    'Execute an action on the extension page and print new DOM.\n\n' +
    'Action JSON format:\n' +
    '  {"action":"click","selector":"#btn"}\n' +
    '  {"action":"type","selector":"input","text":"hello"}\n' +
    '  {"action":"scroll","direction":"down"}\n' +
    '  {"action":"select","selector":"select","value":"opt1"}\n' +
    '  {"action":"navigate","url":"chrome-extension://id/options.html"}',
  )
  .argument('<session-dir>', 'Session directory from interact start')
  .argument('<action-json>', 'Action as JSON string')
  .action(async (sessionDir: string, actionJson: string) => {
    const action = JSON.parse(actionJson);
    const snapshot = await interactAction(resolve(sessionDir), action);
    console.log(snapshot);
  });

interact
  .command('snapshot').alias('snap')
  .description('Re-print the current DOM snapshot of the extension page.')
  .argument('<session-dir>', 'Session directory from interact start')
  .action(async (sessionDir: string) => {
    const snapshot = await interactSnapshot(resolve(sessionDir));
    console.log(snapshot);
  });

interact
  .command('stop').alias('x')
  .description('Close the browser and end the interactive session.')
  .argument('<session-dir>', 'Session directory from interact start')
  .action(async (sessionDir: string) => {
    await interactStop(resolve(sessionDir));
    console.log('Session stopped.');
  });

// ============================================================
// BATCH command
// ============================================================
program
  .command('batch')
  .description(
    'Analyze multiple extensions in parallel.\n' +
    'Takes a file with one extension directory path per line.\n\n' +
    'Example:\n' +
    '  echo "/path/to/ext1\\n/path/to/ext2" > batch.txt\n' +
    '  cws-dynamic-analyze batch batch.txt -o ./output --workers 8',
  )
  .argument('<list-file>', 'File with one extension path per line')
  .option('-o, --output <dir>', 'Base output directory (subdirs created per extension)', './output')
  .option('-w, --workers <n>', 'Parallel workers', '8')
  .option('--headless', 'Run headless', false)
  .option('--duration <seconds>', 'Max duration per extension', '120')
  .option('--chrome-path <path>', 'Chrome binary path')
  .option('--phases <phases>', 'Phases to run', 'install,browse,login,banking,shopping,idle,tabs')
  .action(async (listFile: string, opts: any) => {
    const lines = (await readFile(resolve(listFile), 'utf-8'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const workers = parseInt(opts.workers, 10);
    const total = lines.length;
    let completed = 0;
    let failed = 0;

    logger.info({ total, workers }, 'Starting batch analysis');

    // Simple worker pool
    const queue = [...lines];
    const results: Array<{ path: string; status: string; extensionId?: string; canary?: number }> = [];

    async function runWorker() {
      while (queue.length > 0) {
        const extPath = queue.shift()!;
        const extId = extPath.split('/').pop() ?? 'unknown';
        const outDir = resolve(opts.output, extId);

        try {
          const config = defaultConfig(extId, resolve(extPath));
          config.outputDir = outDir;
          config.browser.headless = opts.headless || true; // batch always headless
          config.browser.executablePath = opts.chromePath;
          config.scenario.maxDuration = parseInt(opts.duration, 10);
          config.scenario.phases = opts.phases.split(',').map((s: string) => s.trim()) as PhaseId[];

          const result = await analyze(config);
          completed++;
          results.push({
            path: extPath,
            status: 'completed',
            extensionId: result.summary.extensionId,
            canary: result.summary.canaryDetections,
          });
          logger.info({ completed, total, extId, canary: result.summary.canaryDetections }, 'Extension done');
        } catch (err: any) {
          failed++;
          completed++;
          results.push({ path: extPath, status: `failed: ${err.message}` });
          logger.error({ extId, err: err.message }, 'Extension failed');
        }
      }
    }

    // Launch worker pool
    await Promise.all(Array.from({ length: workers }, () => runWorker()));

    // Print summary table
    console.log(JSON.stringify(results, null, 2));
    logger.info({ completed, failed, total }, 'Batch complete');
  });

// ============================================================
// TOP-LEVEL SHORTCUTS — skip 'query' prefix for common commands
// Single intuitive words, one token each
// ============================================================
function addShortcut(name: string, target: string, ...extraArgs: string[]) {
  program
    .command(name, { hidden: true })
    .allowUnknownOption()
    .argument('[args...]')
    .action(async (args: string[]) => {
      // Re-invoke as: query <target> <args...>
      const argv = ['node', 'da', 'query', target, ...extraArgs, ...args];
      await program.parseAsync(argv);
    });
}

addShortcut('net', 'network');        // da net /tmp/r --source bgsw
addShortcut('req', 'request');        // da req /tmp/r REQUEST_ID
addShortcut('hooks', 'hooks');        // da hooks /tmp/r --api chrome
addShortcut('canary', 'canary');      // da canary /tmp/r
addShortcut('domains', 'domains');    // da domains /tmp/r
addShortcut('log', 'console');        // da log /tmp/r --source extension
addShortcut('manifest', 'manifest');  // da manifest /tmp/r
addShortcut('summary', 'summary');    // da summary /tmp/r
addShortcut('stats', 'stats');        // da stats /tmp/r

// --- da sql <output-dir> <query> — run raw SQL against events.db ---
program
  .command('sql')
  .description(
    'Run a SQL query against events.db.\n\n' +
    'Tables: requests, hooks, console, canary\n' +
    'Examples:\n' +
    '  da sql /tmp/r "SELECT source, count(*) n FROM requests GROUP BY source"\n' +
    '  da sql /tmp/r "SELECT * FROM requests WHERE domain LIKE \'%stayfree%\'"\n' +
    '  da sql /tmp/r "SELECT api, count(*) n FROM hooks GROUP BY api ORDER BY n DESC LIMIT 10"\n' +
    '  da sql /tmp/r "SELECT * FROM canary"\n' +
    '  da sql /tmp/r ".schema"',
  )
  .argument('<output-dir>', 'Analysis output directory containing events.db')
  .argument('<query>', 'SQL query or .schema/.tables')
  .action(async (outputDir: string, queryStr: string) => {
    const Database = (await import('better-sqlite3')).default;
    const { join } = await import('node:path');
    const dbPath = join(resolve(outputDir), 'events.db');
    try {
      const db = new Database(dbPath, { readonly: true });
      if (queryStr === '.schema') {
        const tables = db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
        for (const t of tables as any[]) console.log(t.sql + ';\n');
      } else if (queryStr === '.tables') {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        console.log((tables as any[]).map((t) => t.name).join('\n'));
      } else {
        const stmt = db.prepare(queryStr);
        if (stmt.reader) {
          const rows = stmt.all();
          // Compact output: one line per row
          if (rows.length === 0) {
            console.log('(no rows)');
          } else {
            const cols = Object.keys(rows[0] as any);
            console.log(cols.join('\t'));
            for (const row of rows as any[]) {
              console.log(cols.map((c) => {
                const v = row[c];
                return v === null ? '' : String(v).slice(0, 200);
              }).join('\t'));
            }
          }
          console.error(`${rows.length} rows`);
        } else {
          const result = stmt.run();
          console.log(`OK: ${result.changes} rows affected`);
        }
      }
      db.close();
    } catch (err: any) {
      console.error(`SQL error: ${err.message}`);
      process.exit(1);
    }
  });

// interact shortcuts
function addInteractShortcut(name: string, target: string) {
  program
    .command(name, { hidden: true })
    .allowUnknownOption()
    .argument('[args...]')
    .action(async (args: string[]) => {
      const argv = ['node', 'da', 'interact', target, ...args];
      await program.parseAsync(argv);
    });
}

addInteractShortcut('open', 'start');     // da open /path/ext -o /tmp/s --headless
addInteractShortcut('click', 'action');   // da click /tmp/s '{"action":"click",...}'
addInteractShortcut('snap', 'snapshot');  // da snap /tmp/s
addInteractShortcut('close', 'stop');     // da close /tmp/s

program.parse();
