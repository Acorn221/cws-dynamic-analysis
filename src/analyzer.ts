/**
 * Core analysis pipeline — orchestrates the full e2e flow:
 * Launch browser → instrument → run scenarios → collect → detect → summarize → output
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
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

  await mkdir(config.outputDir, { recursive: true });

  // Start canary page server
  const canaryPort = 3200;
  await startCanaryServer(canaryPort);
  log.info({ port: canaryPort }, 'Canary server started');

  let browser: Browser | null = null;
  // JSONL path is set after we know the extension ID
  let jsonlPath = '';
  let jsonl: JsonlWriter | null = null;
  let rewrittenPath: string | null = null;

  try {
    // 0. Optionally rewrite extension source to inject hooks
    let extensionLoadPath = config.extensionPath;
    if (config.instrument !== false) {
      rewrittenPath = join(tmpdir(), `cws-da-${config.runId}`);
      log.info('Rewriting extension source to inject hooks...');
      extensionLoadPath = await rewriteExtension(config.extensionPath, rewrittenPath);
    }

    // 1. Launch browser with extension
    log.info('Launching browser...');
    const { browser: b, extensionId, browserSession } = await launchBrowser(
      extensionLoadPath,
      config.browser,
    );
    browser = b;

    // Update config with detected extension ID
    if (config.extensionId === 'unknown') {
      config.extensionId = extensionId;
    }
    log.info({ extensionId: config.extensionId }, 'Browser launched, extension loaded');

    // Now we know the ID — create the JSONL writer
    jsonlPath = join(config.outputDir, `${config.extensionId}_${config.runId}.jsonl`);
    jsonl = new JsonlWriter(jsonlPath);
    await jsonl.open();

    // 2. Find and instrument the service worker
    const swTarget = await browser.waitForTarget(
      (t: Target) =>
        t.type() === 'service_worker' &&
        t.url().startsWith('chrome-extension://'),
      { timeout: 10_000 },
    );

    const swCdp = await swTarget.createCDPSession();

    // Enable network monitoring on service worker
    await enableNetworkMonitoring(swCdp, 'service_worker', (req: NetworkRequest) => {
      detector.scan(req);
      for (const cd of req.canaryDetections) {
        buffer.addCanaryDetection(cd);
      }
      buffer.addNetworkRequest(req);
      jsonl?.write({ type: 'network', ...req });
    });

    // Inject chrome.* API hooks into service worker
    await injectServiceWorkerHooks(swCdp);
    onServiceWorkerHookCallback(swCdp, (data: any) => {
      const call: ApiCall = {
        id: buffer.nextId(),
        timestamp: new Date(data.ts).toISOString(),
        api: data.api,
        args: data.args ?? [],
        returnValueSummary: data.result != null ? JSON.stringify(data.result).slice(0, 200) : undefined,
        callerContext: 'service_worker',
        relatedEvents: [],
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

    await instrumentPage(page, buffer, detector, jsonl!);

    // Instrument any new pages that open during the scenario
    browser.on('targetcreated', async (target: Target) => {
      if (target.type() === 'page') {
        try {
          const newPage = await target.page();
          if (newPage) {
            await instrumentPage(newPage, buffer, detector, jsonl!);
          }
        } catch (err) {
          log.debug({ err }, 'Failed to instrument new page target');
        }
      }
    });

    // 4. Run the scenario
    log.info('Starting scenario...');
    await runScenario(page, config.scenario, config.canary, canaryPort);
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
        formsInteracted: 3, // login, banking, checkout
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
    await writeFile(
      join(config.outputDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    await writeFile(
      join(config.outputDir, 'llm_summary.md'),
      llmSummary,
    );
    await writeFile(
      join(config.outputDir, 'stats.json'),
      JSON.stringify(stats, null, 2),
    );

    await jsonl?.close();

    // Print results
    log.info('=== ANALYSIS COMPLETE ===');
    log.info({
      extensionId: config.extensionId,
      duration: `${durationSeconds}s`,
      networkRequests: stats.totalNetworkRequests,
      externalDomains: stats.externalDomains.length,
      flaggedRequests: stats.flaggedRequests,
      apiCalls: stats.totalApiCalls,
      canaryDetections: stats.canaryDetections,
    }, 'Results');

    if (stats.canaryDetections > 0) {
      log.warn(
        { detections: buffer.canaryDetections },
        '🚨 CANARY DATA EXFILTRATION DETECTED',
      );
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
      scenarioConfig: {
        phasesRun: [],
        totalDurationSeconds: 0,
        sitesVisited: [],
        formsInteracted: 0,
        timeAccelerated: false,
      },
      networkStats: {
        totalRequests: 0,
        externalDomains: [],
        flaggedRequests: 0,
        blockedRequests: 0,
        totalBytesOut: 0,
        totalBytesIn: 0,
      },
      apiHookStats: { totalCalls: 0, byApi: {}, sensitiveApis: [] },
      canaryDetections: 0,
      rawLogPath: jsonlPath,
    };

    await writeFile(
      join(config.outputDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );

    throw err;
  } finally {
    if (browser) await closeBrowser(browser);
    await stopCanaryServer();
    // Clean up rewritten extension copy
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
): Promise<void> {
  try {
    const cdp = await page.createCDPSession();

    // Network monitoring
    await enableNetworkMonitoring(cdp, 'page', (req: NetworkRequest) => {
      detector.scan(req);
      for (const cd of req.canaryDetections) {
        buffer.addCanaryDetection(cd);
      }
      buffer.addNetworkRequest(req);
      jsonl?.write({ type: 'network', ...req });
    });

    // Page-side hooks
    await injectPageHooks(page);
    page.on('cws:hook' as any, (data: any) => {
      const call: ApiCall = {
        id: buffer.nextId(),
        timestamp: new Date(data.ts).toISOString(),
        api: `page.${data.type}`,
        args: [data.data],
        callerContext: 'page',
        relatedEvents: [],
      };
      buffer.addApiCall(call);
      jsonl?.write({ type: 'page_hook', ...call });
    });

    // Console log capture
    page.on('console', (msg) => {
      buffer.addConsoleEntry({
        timestamp: new Date().toISOString(),
        level: msg.type() === 'error' ? 'error' : (msg.type() as string) === 'warning' ? 'warn' : 'log',
        source: msg.location()?.url?.includes('chrome-extension://') ? 'extension' : 'page',
        text: msg.text(),
        url: msg.location()?.url,
        lineNumber: msg.location()?.lineNumber,
      });
    });

    log.debug({ url: page.url() }, 'Page instrumented');
  } catch (err) {
    log.debug({ err }, 'Failed to instrument page (may be internal)');
  }
}
