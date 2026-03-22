// Public API
export { analyze } from './analyzer.js';
export { launchBrowser, closeBrowser } from './cdp/browser.js';
export { applyPageStealth, MAC_UA, STEALTH_ARGS } from './cdp/stealth.js';
export { SessionManager } from './cdp/sessions.js';
export { enableNetworkMonitoring } from './cdp/network.js';
export { injectPageHooks, injectServiceWorkerHooks } from './cdp/hooks.js';
export { EventBuffer } from './collector/buffer.js';
export { JsonlWriter } from './collector/jsonl-writer.js';
export { Detector } from './collector/detector.js';
export { summarizeForLLM } from './collector/summarizer.js';
export { linkCausalChains } from './collector/causal-linker.js';
export { defaultConfig } from './types/config.js';

export type * from './types/events.js';
export type * from './types/findings.js';
export type * from './types/config.js';
