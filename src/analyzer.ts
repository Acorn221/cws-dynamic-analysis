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
import { Detector } from './collector/detector.js';
import { summarizeForLLM } from './collector/summarizer.js';
import { linkCausalChains } from './collector/causal-linker.js';
import { startCanaryServer, stopCanaryServer } from './scenario/canary-server.js';
import { runScenario } from './scenario/engine.js';
import type { RunConfig } from './types/config.js';
import type { ApiCall, NetworkRequest } from './types/events.js';
import type { RunSummary } from './types/findings.js';
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

  await mkdir(config.outputDir, { recursive: true });

  // Start canary page server
  const canaryPort = 3200;
  await startCanaryServer(canaryPort);
  log.info({ port: canaryPort }, 'Canary server started');

  let browser: Browser | null = null;
  let jsonl: JsonlWriter | null = null;
  let jsonlPath = '';
  let rewrittenPath: string | null = null;
  const sourceRewritten = config.instrument !== false;

  try {
    // 0. Optionally rewrite extension source to inject hooks
    let extensionLoadPath = config.extensionPath;
    if (sourceRewritten) {
      rewrittenPath = join(tmpdir(), `cws-da-${config.runId}`);
      log.info('Rewriting extension source to inject hooks...');
      extensionLoadPath = await rewriteExtension(config.extensionPath, rewrittenPath);
    }

    // 1. Launch browser with extension
    log.info('Launching browser...');
    const { browser: b, extensionId } = await launchBrowser(
      extensionLoadPath,
      config.browser,
    );
    browser = b;

    if (config.extensionId === 'unknown') {
      config.extensionId = extensionId;
    }
    log.info({ extensionId: config.extensionId }, 'Browser launched, extension loaded');

    // Deterministic JSONL filename: events.jsonl (no UUID)
    jsonlPath = join(config.outputDir, 'events.jsonl');
    jsonl = new JsonlWriter(jsonlPath);
    await jsonl.open();

    // Save manifest for query manifest command
    try {
      const manifest = await readFile(join(config.extensionPath, 'manifest.json'), 'utf-8');
      await writeFile(join(config.outputDir, 'manifest.json'), manifest);
    } catch { /* manifest may not be readable */ }

    // 2. Find the service worker (may already be running)
    const swFilter = (t: Target) =>
      t.type() === 'service_worker' && t.url().startsWith('chrome-extension://');
    let swTarget = browser.targets().find(swFilter as any) as Target;
    if (!swTarget) {
      swTarget = await browser.waitForTarget(swFilter, { timeout: 30_000 });
    }

    const swCdp = await swTarget.createCDPSession();

    // Inject keep-alive to prevent SW from terminating during analysis.
    // Must be done via CDP (not source rewriting) because CWS extensions
    // have verified_contents.json that rejects modified files.
    await swCdp.send('Runtime.enable');
    await swCdp.send('Runtime.evaluate', {
      expression: 'setInterval(()=>{},20000)',
      awaitPromise: false,
    });

    // Enable network monitoring on service worker (with phase tracker)
    await enableNetworkMonitoring(swCdp, 'service_worker', (req: NetworkRequest) => {
      req.phase = phaseTracker.current;
      detector.scan(req);
      for (const cd of req.canaryDetections) {
        buffer.addCanaryDetection(cd);
      }
      buffer.addNetworkRequest(req);
      jsonl?.write({ type: 'network', ...req });
    }, phaseTracker);

    // Capture SW console messages (separate from page console)
    // @ts-ignore — CDPSession event type
swCdp.on('Runtime.consoleAPICalled', (event: any) => {
      // Skip our own hook messages (handled by onServiceWorkerHookCallback)
      const firstArg = event.args?.[0];
      if (firstArg?.value === '[CWS_HOOK]') return;

      const text = (event.args ?? [])
        .map((a: any) => a.value ?? a.description ?? '')
        .join(' ');
      buffer.addConsoleEntry({
        timestamp: new Date().toISOString(),
        level: event.type === 'error' ? 'error' : event.type === 'warning' ? 'warn' : 'log',
        source: 'extension',
        text,
        phase: phaseTracker.current,
      });
    });

    // Inject chrome.* API hooks into service worker via Runtime.evaluate
    // (must happen after Runtime.enable so console.log events are captured)
    await injectServiceWorkerHooks(swCdp, false);

    onServiceWorkerHookCallback(swCdp, (data: any) => {
      const call: ApiCall = {
        id: buffer.nextId(),
        timestamp: new Date(data.ts).toISOString(),
        api: data.api,
        args: data.args ?? [],
        returnValueSummary: data.result != null ? JSON.stringify(data.result).slice(0, 200) : undefined,
        callerContext: 'service_worker',
        source: 'bgsw',
        relatedEvents: [],
        phase: phaseTracker.current,
      };
      buffer.addApiCall(call);
      jsonl?.write({ type: 'api_call', ...call });
    });

    // Inject time acceleration if enabled
    if (config.scenario.timeAcceleration) {
      try {
        await accelerateAlarms(swCdp);
        for (const jump of config.scenario.timeJumps) {
          await injectTimeOverride(swCdp, jump);
        }
        log.info({ timeJumps: config.scenario.timeJumps }, 'Time acceleration injected');
      } catch (err) {
        log.warn({ err }, 'Time acceleration injection failed (non-fatal)');
      }
    }

    log.info('Service worker instrumented');

    // 3. Get main page and instrument it
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();

    await instrumentPage(page, buffer, detector, jsonl!, phaseTracker);

    // Instrument any new pages that open during the scenario
    browser.on('targetcreated', async (target: Target) => {
      if (target.type() === 'page') {
        try {
          const newPage = await target.page();
          if (newPage) {
            await instrumentPage(newPage, buffer, detector, jsonl!, phaseTracker);
          }
        } catch (err) {
          log.debug({ err }, 'Failed to instrument new page target');
        }
      }
    });

    // 4. Extension interaction phase — LLM navigates popup/options/onboarding
    if (config.scenario.phases.includes('ext-interact')) {
      phaseTracker.current = 'ext-interact';
      log.info('Starting LLM-driven extension interaction...');
      try {
        const { interactWithExtension } = await import('./scenario/ext-interact.js');
        const interactResult = await interactWithExtension(browser, {
          extensionId: config.extensionId,
          model: config.analysis.triageModel,
          maxTurns: 15,
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
    const browsingPhases = config.scenario.phases.filter(p => p !== 'ext-interact');
    log.info('Starting browsing scenario...');
    await runScenario(page, { ...config.scenario, phases: browsingPhases }, config.canary, canaryPort, phaseTracker);
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

    // 6. Write results
    await writeFile(join(config.outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(join(config.outputDir, 'llm_summary.md'), llmSummary);
    await writeFile(join(config.outputDir, 'stats.json'), JSON.stringify(stats, null, 2));
    await writeFile(join(config.outputDir, 'console.json'), JSON.stringify(buffer.consoleEntries, null, 2));

    await jsonl?.close();

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
    if (browser) await closeBrowser(browser);
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
  detector: Detector,
  jsonl: JsonlWriter,
  phaseTracker: PhaseTracker,
): Promise<void> {
  try {
    const cdp = await page.createCDPSession();

    const currentPageUrl = page.url();
    await enableNetworkMonitoring(cdp, 'page', (req: NetworkRequest) => {
      req.phase = phaseTracker.current;
      detector.scan(req);
      for (const cd of req.canaryDetections) {
        buffer.addCanaryDetection(cd);
      }
      buffer.addNetworkRequest(req);
      jsonl?.write({ type: 'network', ...req });
    }, phaseTracker, currentPageUrl);

    await injectPageHooks(page);
    page.on('cws:hook' as any, (data: any) => {
      const call: ApiCall = {
        id: buffer.nextId(),
        timestamp: new Date(data.ts).toISOString(),
        api: `page.${data.type}`,
        args: [data.data],
        callerContext: 'page',
        source: 'page',
        relatedEvents: [],
        phase: phaseTracker.current,
      };
      buffer.addApiCall(call);
      jsonl?.write({ type: 'page_hook', ...call });
    });

    page.on('console', (msg) => {
      // Skip our own hook messages
      if (msg.text().startsWith('[CWS_HOOK]')) return;
      buffer.addConsoleEntry({
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
