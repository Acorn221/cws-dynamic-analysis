/**
 * Core analysis pipeline — orchestrates the full e2e flow:
 * Launch browser → instrument → run scenarios → collect → detect → summarize → output
 */
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Browser, Page, CDPSession, Target } from 'puppeteer';
import { rewriteExtension } from './instrument/rewriter.js';
import { launchBrowser, closeBrowser } from './cdp/browser.js';
import { enableNetworkMonitoring } from './cdp/network.js';
import {
  injectPageHooks,
  injectServiceWorkerHooks,
  onServiceWorkerHookCallback,
} from './cdp/hooks.js';
import { injectTimeOverride, accelerateAlarms } from './scenario/time-accel.js';
import { createPhaseTracker, type PhaseTracker } from './scenario/phase-tracker.js';
import { EventBuffer } from './collector/buffer.js';
import { JsonlWriter } from './collector/jsonl-writer.js';
import { SqliteStore } from './collector/sqlite.js';
import { Detector } from './collector/detector.js';
import { summarizeForLLM } from './collector/summarizer.js';
import { linkCausalChains } from './collector/causal-linker.js';
import { startCanaryServer, stopCanaryServer } from './scenario/canary-server.js';
import { runScenario } from './scenario/engine.js';
import type { RunConfig } from './types/config.js';
import type { ApiCall, NetworkRequest, ConsoleEntry } from './types/events.js';
import type { RunSummary } from './types/findings.js';
import { writeRunState } from './serve/run-state.js';
import { logger } from './logger.js';

const log = logger.child({ component: 'analyzer' });

export interface AnalysisResult {
  summary: RunSummary;
  llmSummary: string;
  outputDir: string;
}

export async function analyze(config: RunConfig): Promise<AnalysisResult> {
  const startedAt = new Date().toISOString();
  const buffer = new EventBuffer();
  const detector = new Detector(config.canary);
  const phaseTracker = createPhaseTracker();

  // Unified sink — writes to buffer + jsonl + sqlite in one call
  const sink = {
    request(req: NetworkRequest) {
      detector.scan(req);
      for (const cd of req.canaryDetections) buffer.addCanaryDetection(cd);
      buffer.addNetworkRequest(req);
      jsonl?.write({ type: 'network', ...req });
      sqlite?.addRequest(req);
    },
    hook(call: ApiCall) {
      buffer.addApiCall(call);
      jsonl?.write({ type: 'api_call', ...call });
      sqlite?.addHook(call);
    },
    console(entry: ConsoleEntry) {
      buffer.addConsoleEntry(entry);
      sqlite?.addConsoleEntry(entry);
    },
  };

  await mkdir(config.outputDir, { recursive: true });

  // Start canary page server
  const canaryPort = await startCanaryServer(0);
  log.info({ port: canaryPort }, 'Canary server started');

  let browser: Browser | null = null;
  let jsonl: JsonlWriter | null = null;
  let sqlite: SqliteStore | null = null;
  let jsonlPath = '';
  let rewrittenPath: string | null = null;
  const sourceRewritten = config.instrument !== false;

  try {
    // 0. Connect to existing interact session OR launch new browser
    if (config.sessionDir) {
      // Reuse browser from an interact session (extension already onboarded)
      const sessionData = JSON.parse(
        await readFile(join(config.sessionDir, 'session.json'), 'utf-8'),
      );
      log.info({ sessionDir: config.sessionDir }, 'Connecting to existing browser session');
      const puppeteer = (await import('puppeteer')).default;
      browser = await puppeteer.connect({ browserWSEndpoint: sessionData.wsEndpoint });
      config.extensionId = sessionData.extensionId;
      log.info({ extensionId: config.extensionId }, 'Connected to session');
    } else {
      // Fresh browser launch
      let extensionLoadPath = config.extensionPath;
      if (sourceRewritten) {
        rewrittenPath = join(tmpdir(), `cws-da-${config.runId}`);
        log.info('Rewriting extension source to inject hooks...');
        extensionLoadPath = await rewriteExtension(config.extensionPath, rewrittenPath);
      }

      log.info('Launching browser...');
      const { browser: b, extensionId } = await launchBrowser(extensionLoadPath, config.browser);
      browser = b;

      if (config.extensionId === 'unknown') {
        config.extensionId = extensionId;
      }
      log.info({ extensionId: config.extensionId }, 'Browser launched, extension loaded');
    }

    // Write run state for the dashboard to discover
    await writeRunState(config.outputDir, {
      runId: config.runId,
      extensionId: config.extensionId,
      wsEndpoint: browser.wsEndpoint(),
      outputDir: config.outputDir,
      phase: 'init',
      status: 'running',
      startedAt,
      pid: process.pid,
    }).catch(() => {});

    // Deterministic JSONL filename: events.jsonl (no UUID)
    jsonlPath = join(config.outputDir, 'events.jsonl');
    jsonl = new JsonlWriter(jsonlPath);
    await jsonl.open();
    sqlite = new SqliteStore(config.outputDir);

    // Save manifest for query manifest command
    try {
      const manifest = await readFile(join(config.extensionPath, 'manifest.json'), 'utf-8');
      await writeFile(join(config.outputDir, 'manifest.json'), manifest);
    } catch { /* manifest may not be readable */ }

    // 2. Instrument the background target (service_worker for MV3, background_page for MV2).
    //
    // For fresh launches: launchBrowser() sets up Target.setAutoAttach with
    // waitForDebuggerOnStart=true, so the SW is PAUSED before any code runs.
    // We instrument it here and then resume.
    //
    // For --session mode: the SW is already running. We terminate it, set up
    // auto-attach, and trigger a restart to catch it paused.

    const bgFilter = (t: Target) =>
      (t.type() === 'service_worker' || t.type() === 'background_page') &&
      t.url().startsWith('chrome-extension://');

    let existingSW = browser.targets().find((t) => bgFilter(t as Target)) as Target | undefined;
    const isMV2Background = existingSW?.type() === 'background_page';

    let swCdp: CDPSession | null = null;
    let targetType: 'service_worker' | 'background_page' = 'service_worker';

    // The try block below handles SW detection + instrumentation.
    // If the SW fails to register (crashes on startup, etc), we catch the error
    // and proceed with page-only analysis. swCdp stays null in that case.
    try {
    if (isMV2Background) {
      // MV2 background pages persist — direct attach
      targetType = 'background_page';
      log.info('MV2 background page — using direct attach');
      swCdp = await existingSW!.createCDPSession();
      await swCdp.send('Runtime.enable');
    } else if (config.sessionDir) {
      // --session mode: SW already running, set up auto-attach + restart
      targetType = 'service_worker';
      const browserCdp = await (browser as any).target().createCDPSession();

      const swAttached = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SW auto-attach timeout (30s)')), 30_000);
        let terminated = false;

        (browserCdp as any).on('Target.attachedToTarget', (event: any) => {
          const { sessionId, targetInfo } = event;
          const isOurSW = targetInfo.type === 'service_worker' &&
            targetInfo.url.includes(config.extensionId);

          if (isOurSW && terminated) {
            clearTimeout(timeout);
            log.info({ url: targetInfo.url }, 'Session SW restarted and paused');
            resolve();
            return;
          }
          // Resume non-target or pre-termination targets
          (browserCdp as any).send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        });

        // Enable auto-attach, terminate, trigger restart
        browserCdp.send('Target.setAutoAttach' as any, {
          autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
          filter: [{ type: 'service_worker', exclude: false }, { type: 'page', exclude: false }],
        }).then(async () => {
          if (existingSW) {
            const tmp = await existingSW!.createCDPSession().catch(() => null);
            if (tmp) {
              await tmp.send('Runtime.terminateExecution').catch(() => {});
              await tmp.detach().catch(() => {});
            }
          }
          terminated = true;
          await new Promise((r) => setTimeout(r, 1500));
          const pages = await browser!.pages();
          const p = pages[0] ?? await browser!.newPage();
          await p.goto('https://www.example.com', { waitUntil: 'load', timeout: 10000 }).catch(() => {});
        });
      });

      await swAttached;

      // Find the restarted SW target
      let swTarget = browser.targets().find((t) => bgFilter(t as Target)) as Target | undefined;
      if (!swTarget) {
        await new Promise((r) => setTimeout(r, 500));
        swTarget = browser.targets().find((t) => bgFilter(t as Target)) as Target | undefined;
      }
      swCdp = swTarget ? await swTarget.createCDPSession() : browserCdp;
      await swCdp!.send('Runtime.enable');

      await browserCdp.send('Target.setAutoAttach' as any, {
        autoAttach: false, waitForDebuggerOnStart: false, flatten: true,
      }).catch(() => {});
    } else {
      // Fresh launch: create a fresh CDP session to the SW target.
      targetType = 'service_worker';
      let swTarget = browser.targets().find((t) => bgFilter(t as Target)) as Target | undefined;
      if (!swTarget) {
        swTarget = await browser.waitForTarget(bgFilter, { timeout: 30_000 }) as Target;
      }
      swCdp = await swTarget.createCDPSession();
      await swCdp.send('Runtime.enable');
    }

    // At this point swCdp is definitely assigned (all branches above set it)
    const sw = swCdp!;
    log.info({ targetType }, 'Background target found (paused)');

    // Inject keep-alive to prevent SW from terminating during analysis.
    // (Injected while still paused — runs when we resume)
    await sw.send('Runtime.evaluate', {
      expression: 'setInterval(()=>{},20000)',
      awaitPromise: false,
    });

    // Enable overrides on SW (mock/block specific URLs)
    if (config.overrides?.length) {
      const { enableOverrides } = await import('./cdp/overrides.js');
      await enableOverrides(sw, config.overrides);
    }

    // Enable network monitoring on SW target
    await enableNetworkMonitoring(sw, targetType, (req: NetworkRequest) => {
      req.phase = phaseTracker.current;
      sink.request(req);
    }, phaseTracker);

    // Capture SW console messages (separate from page console)
    (sw as any).on('Runtime.consoleAPICalled', (event: any) => {
      // Skip our own hook messages (handled by onServiceWorkerHookCallback)
      const firstArg = event.args?.[0];
      if (firstArg?.value === '[CWS_HOOK]') return;

      const text = (event.args ?? [])
        .map((a: any) => a.value ?? a.description ?? '')
        .join(' ');
      sink.console({
        timestamp: new Date().toISOString(),
        level: event.type === 'error' ? 'error' : event.type === 'warning' ? 'warn' : 'log',
        source: 'extension',
        text,
        phase: phaseTracker.current,
      });
    });

    // Inject chrome.* API hooks into service worker via Runtime.evaluate.
    // This also calls Runtime.runIfWaitingForDebugger to resume the SW.
    await injectServiceWorkerHooks(sw, false);

    onServiceWorkerHookCallback(sw, (data: any) => {
      const call: ApiCall = {
        id: buffer.nextId(),
        timestamp: new Date(data.ts).toISOString(),
        api: data.api,
        args: data.args ?? [],
        returnValueSummary: data.result != null ? JSON.stringify(data.result).slice(0, 200) : undefined,
        callerContext: isMV2Background ? 'background_page' : 'service_worker',
        source: 'bgsw',
        relatedEvents: [],
        phase: phaseTracker.current,
      };
      sink.hook(call);
    });

    // For MV2 background pages, we need to resume manually (no auto-attach pause)
    if (isMV2Background) {
      await sw.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    }

    // Inject time acceleration if enabled (skip for --session runs — we want
    // to observe natural behavior after onboarding, not break Date.now)
    if (config.scenario.timeAcceleration && !config.sessionDir) {
      try {
        await accelerateAlarms(sw);
        for (const jump of config.scenario.timeJumps) {
          await injectTimeOverride(sw, jump);
        }
        log.info({ timeJumps: config.scenario.timeJumps }, 'Time acceleration injected');
      } catch (err) {
        log.warn({ err }, 'Time acceleration injection failed (non-fatal)');
      }
    }

    log.info({ targetType }, 'Background target instrumented (resumed)');
    } catch (err: any) {
      // SW failed to register/attach — proceed with page-only analysis
      log.warn({ err: err.message }, 'Background target not found — running page-only analysis (no SW hooks/monitoring)');
      swCdp = null;
    }

    // Periodic state updates for the dashboard (every 5s)
    const stateInterval = setInterval(() => {
      const stats = buffer.getStats();
      writeRunState(config.outputDir, {
        phase: phaseTracker.current,
        stats: {
          totalRequests: stats.totalNetworkRequests,
          extensionRequests: stats.extensionRequests,
          flaggedRequests: stats.flaggedRequests,
          canaryDetections: stats.canaryDetections,
        },
      }).catch(() => {});
    }, 5000);

    // 3. Get main page and instrument it
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();

    await instrumentPage(page, buffer, sink, phaseTracker, config.overrides);

    // Instrument any new pages that open during the scenario
    browser.on('targetcreated', async (target: Target) => {
      if (target.type() === 'page') {
        try {
          const newPage = await target.page();
          if (newPage) {
            await instrumentPage(newPage, buffer, sink, phaseTracker, config.overrides);
          }
        } catch (err) {
          log.debug({ err }, 'Failed to instrument new page target');
        }
      }
    });

    // 4. Extension interaction phase — LLM navigates popup/options/onboarding
    if (config.scenario.phases.includes('ext-interact')) {
      phaseTracker.current = 'ext-interact';
      log.info('Opening extension pages for activation...');
      try {
        const { interactWithExtension } = await import('./scenario/ext-interact.js');
        const interactResult = await interactWithExtension(browser, {
          extensionId: config.extensionId,
        });
        log.info({
          turns: interactResult.turns,
          actions: interactResult.actions.length,
        }, 'Extension interaction complete');
      } catch (err: any) {
        log.warn({ err: err.message }, 'Extension interaction failed (non-fatal)');
      }
    }

    // 5. Run the browsing scenario (engine updates phaseTracker.current)
    //
    // After ext-interact, the original page may be dead (extension closed/navigated it,
    // or page.close() in ext-interact hit the wrong page). Get a fresh page if needed.
    let scenarioPage: Page;
    try {
      // Check if original page is still alive
      await page.evaluate(() => true);
      scenarioPage = page;
    } catch {
      log.warn('Original page died during ext-interact, creating new page');
      const freshPages = await browser.pages();
      const livePage = freshPages.find((p) => !p.isClosed());
      scenarioPage = livePage ?? await browser.newPage();
      await instrumentPage(scenarioPage, buffer, sink, phaseTracker, config.overrides);
    }

    const browsingPhases = config.scenario.phases.filter(p => p !== 'ext-interact');
    log.info('Starting browsing scenario...');
    await runScenario(scenarioPage, { ...config.scenario, phases: browsingPhases }, config.canary, canaryPort, phaseTracker, browser);
    phaseTracker.current = 'post';
    log.info('Scenario complete');

    // 5. Post-processing
    log.info('Running post-processing...');
    linkCausalChains(buffer);

    const llmSummary = summarizeForLLM(buffer, config);
    const stats = buffer.getStats();

    const finishedAt = new Date().toISOString();
    const durationSeconds = Math.round(
      (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000,
    );

    const summary: RunSummary = {
      runId: config.runId,
      extensionId: config.extensionId,
      startedAt,
      finishedAt,
      durationSeconds,
      status: 'completed',
      scenarioConfig: {
        phasesRun: config.scenario.phases,
        totalDurationSeconds: durationSeconds,
        sitesVisited: config.scenario.browsingSites,
        formsInteracted: 3,
        timeAccelerated: config.scenario.timeAcceleration,
      },
      networkStats: {
        totalRequests: stats.totalNetworkRequests,
        externalDomains: stats.externalDomains,
        flaggedRequests: stats.flaggedRequests,
        blockedRequests: 0,
        totalBytesOut: 0,
        totalBytesIn: 0,
      },
      apiHookStats: {
        totalCalls: stats.totalApiCalls,
        byApi: stats.apiCallsByNamespace,
        sensitiveApis: Object.keys(stats.apiCallsByNamespace).filter((k) =>
          ['chrome.cookies', 'chrome.history', 'chrome.tabs', 'chrome.bookmarks'].includes(k),
        ),
      },
      canaryDetections: stats.canaryDetections,
      rawLogPath: jsonlPath,
    };

    clearInterval(stateInterval);

    // 6. Write results
    await writeRunState(config.outputDir, { phase: 'done', status: 'completed' }).catch(() => {});
    await writeFile(join(config.outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(join(config.outputDir, 'llm_summary.md'), llmSummary);
    await writeFile(join(config.outputDir, 'stats.json'), JSON.stringify(stats, null, 2));
    await writeFile(join(config.outputDir, 'console.json'), JSON.stringify(buffer.consoleEntries, null, 2));

    await jsonl?.close();
    // sqlite closed in finally block to avoid race with late-arriving events

    log.info('=== ANALYSIS COMPLETE ===');
    log.info({
      extensionId: config.extensionId,
      duration: `${durationSeconds}s`,
      networkRequests: stats.totalNetworkRequests,
      extensionRequests: stats.extensionRequests,
      externalDomains: stats.externalDomains.length,
      flaggedRequests: stats.flaggedRequests,
      extensionApiCalls: stats.extensionApiCalls,
      pageApiCalls: stats.pageApiCalls,
      canaryDetections: stats.canaryDetections,
    }, 'Results');

    if (stats.canaryDetections > 0) {
      log.warn({ detections: buffer.canaryDetections }, 'CANARY DATA EXFILTRATION DETECTED');
    }

    return { summary, llmSummary, outputDir: config.outputDir };
  } catch (err) {
    log.error({ err }, 'Analysis failed');
    await writeRunState(config.outputDir, { status: 'failed', phase: 'error' }).catch(() => {});
    await jsonl?.close();

    const finishedAt = new Date().toISOString();
    const summary: RunSummary = {
      runId: config.runId,
      extensionId: config.extensionId,
      startedAt,
      finishedAt,
      durationSeconds: Math.round(
        (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000,
      ),
      status: 'failed',
      scenarioConfig: { phasesRun: [], totalDurationSeconds: 0, sitesVisited: [], formsInteracted: 0, timeAccelerated: false },
      networkStats: { totalRequests: 0, externalDomains: [], flaggedRequests: 0, blockedRequests: 0, totalBytesOut: 0, totalBytesIn: 0 },
      apiHookStats: { totalCalls: 0, byApi: {}, sensitiveApis: [] },
      canaryDetections: 0,
      rawLogPath: jsonlPath,
    };

    await writeFile(join(config.outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
    throw err;
  } finally {
    // Close sqlite first (late events may still arrive before browser closes)
    try { sqlite?.close(); } catch { /* may already be closed */ }
    // Only close browser if we launched it (not if we connected to a session)
    if (browser && !config.sessionDir) await closeBrowser(browser);
    await stopCanaryServer();
    if (rewrittenPath) {
      await rm(rewrittenPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Instrument a page with network monitoring + page hooks */
async function instrumentPage(
  page: Page,
  buffer: EventBuffer,
  sinkObj: { request: (r: NetworkRequest) => void; hook: (c: ApiCall) => void; console: (e: ConsoleEntry) => void },
  phaseTracker: PhaseTracker,
  overrides?: RunConfig['overrides'],
): Promise<void> {
  try {
    const cdp = await page.createCDPSession();

    if (overrides?.length) {
      const { enableOverrides } = await import('./cdp/overrides.js');
      await enableOverrides(cdp, overrides);
    }

    const currentPageUrl = page.url();
    await enableNetworkMonitoring(cdp, 'page', (req: NetworkRequest) => {
      req.phase = phaseTracker.current;
      sinkObj.request(req);
    }, phaseTracker, currentPageUrl);

    await injectPageHooks(page);
    page.on('cws:hook' as any, (data: any) => {
      sinkObj.hook({
        id: buffer.nextId(),
        timestamp: new Date(data.ts).toISOString(),
        api: `page.${data.type}`,
        args: [data.data],
        callerContext: 'page',
        source: 'page',
        relatedEvents: [],
        phase: phaseTracker.current,
      });
    });

    page.on('console', (msg) => {
      if (msg.text().startsWith('[CWS_HOOK]')) return;
      sinkObj.console({
        timestamp: new Date().toISOString(),
        level: msg.type() === 'error' ? 'error' : (msg.type() as string) === 'warning' ? 'warn' : 'log',
        source: msg.location()?.url?.includes('chrome-extension://') ? 'extension' : 'page',
        text: msg.text(),
        url: msg.location()?.url,
        lineNumber: msg.location()?.lineNumber,
        phase: phaseTracker.current,
      });
    });

    log.debug({ url: page.url() }, 'Page instrumented');
  } catch (err) {
    log.debug({ err }, 'Failed to instrument page (may be internal)');
  }
}
