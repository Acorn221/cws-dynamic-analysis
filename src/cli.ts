#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import { defaultConfig } from './types/config.js';

const program = new Command();

program
  .name('cws-dynamic-analyze')
  .description('Dynamic analysis of Chrome extensions via CDP')
  .version('0.1.0');

program
  .command('run')
  .description('Analyze a single extension')
  .argument('<extension-path>', 'Path to unpacked extension directory')
  .option('-i, --extension-id <id>', 'Extension ID (auto-detected if omitted)')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('--headless', 'Run in headless mode (requires Xvfb)', false)
  .option('--no-stealth', 'Disable stealth plugin')
  .option('--no-analysis', 'Skip LLM analysis phase')
  .option('--duration <seconds>', 'Max scenario duration', '900')
  .option('--time-accel', 'Enable time acceleration', true)
  .option('--chrome-path <path>', 'Path to Chrome binary')
  .action(async (extensionPath, opts) => {
    const absPath = resolve(extensionPath);
    const config = defaultConfig(opts.extensionId ?? 'unknown', absPath);

    config.outputDir = resolve(opts.output);
    config.browser.headless = opts.headless;
    config.browser.stealth = opts.stealth !== false;
    config.browser.executablePath = opts.chromePath;
    config.scenario.maxDuration = parseInt(opts.duration, 10);
    config.scenario.timeAcceleration = opts.timeAccel;
    config.analysis.enabled = opts.analysis !== false;

    logger.info({ extensionPath: absPath, config: config.extensionId }, 'Starting analysis');

    // TODO: Wire up the full analysis pipeline
    // 1. Launch browser with extension
    // 2. Set up CDP sessions + hooks
    // 3. Run scenario phases
    // 4. Collect events + detect canaries
    // 5. Summarize + run LLM analysis
    // 6. Write results

    logger.info('Analysis pipeline not yet implemented — scaffold only');
  });

program
  .command('mcp')
  .description('Start the MCP server for LLM-driven investigation')
  .option('-p, --port <port>', 'MCP server port', '3100')
  .action(async (opts) => {
    logger.info({ port: opts.port }, 'MCP server not yet implemented — scaffold only');
  });

program.parse();
