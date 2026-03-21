#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { logger } from './logger.js';
import { defaultConfig } from './types/config.js';
import { analyze } from './analyzer.js';

const program = new Command();

program
  .name('cws-dynamic-analyze')
  .description('Dynamic analysis of Chrome extensions via CDP')
  .version('0.1.0');

program
  .command('run')
  .description('Analyze a single extension')
  .argument('<extension-path>', 'Path to unpacked extension directory')
  .option('-i, --extension-id <id>', 'Extension ID (auto-detected from service worker)')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('--headless', 'Run in headless mode (needs Xvfb or headless=new)', false)
  .option('--no-stealth', 'Disable stealth plugin')
  .option('--no-analysis', 'Skip LLM analysis phase')
  .option('--duration <seconds>', 'Max scenario duration in seconds', '120')
  .option('--chrome-path <path>', 'Path to Chrome binary')
  .option('--phases <phases>', 'Comma-separated phase list', 'install,browse,login,banking,shopping,idle,tabs')
  .action(async (extensionPath: string, opts: any) => {
    const absPath = resolve(extensionPath);

    // Verify extension path exists
    try {
      const s = await stat(absPath);
      if (!s.isDirectory()) {
        logger.error('Extension path must be a directory');
        process.exit(1);
      }
    } catch {
      logger.error({ path: absPath }, 'Extension path does not exist');
      process.exit(1);
    }

    // Verify manifest.json exists
    try {
      await stat(resolve(absPath, 'manifest.json'));
    } catch {
      logger.error({ path: absPath }, 'No manifest.json found — is this an unpacked extension?');
      process.exit(1);
    }

    const config = defaultConfig(opts.extensionId ?? 'unknown', absPath);

    config.outputDir = resolve(opts.output);
    config.browser.headless = opts.headless;
    config.browser.stealth = opts.stealth !== false;
    config.browser.executablePath = opts.chromePath;
    config.scenario.maxDuration = parseInt(opts.duration, 10);
    config.analysis.enabled = opts.analysis !== false;
    config.scenario.phases = opts.phases.split(',').map((s: string) => s.trim());

    logger.info({
      extensionPath: absPath,
      extensionId: config.extensionId,
      duration: config.scenario.maxDuration,
      phases: config.scenario.phases,
    }, 'Starting dynamic analysis');

    try {
      const result = await analyze(config);
      logger.info({
        outputDir: result.outputDir,
        status: result.summary.status,
        canaryDetections: result.summary.canaryDetections,
      }, 'Analysis complete');

      // Print the LLM summary to stdout for easy piping
      console.log('\n' + result.llmSummary);
    } catch (err) {
      logger.error({ err }, 'Analysis failed');
      process.exit(1);
    }
  });

program
  .command('mcp')
  .description('Start the MCP server for LLM-driven investigation')
  .option('-p, --port <port>', 'MCP server port', '3100')
  .action(async (opts: any) => {
    logger.info({ port: opts.port }, 'MCP server not yet implemented — coming in Phase 3');
  });

program.parse();
