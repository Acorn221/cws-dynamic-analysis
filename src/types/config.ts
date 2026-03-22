import type { RiskLevel } from './findings.js';

/** Top-level configuration for an analysis run */
export interface RunConfig {
  /** Extension ID (32-char CWS ID) */
  extensionId: string;
  /** Path to unpacked extension directory */
  extensionPath: string;
  /** Unique run identifier */
  runId: string;
  /** Where to write JSONL + results */
  outputDir: string;

  /** Chrome/browser settings */
  browser: BrowserConfig;
  /** Scenario settings */
  scenario: ScenarioConfig;
  /** Canary data settings */
  canary: CanaryConfig;
  /** LLM analysis settings */
  analysis: AnalysisConfig;
  /** Network isolation settings */
  network: NetworkConfig;
  /** Rewrite extension source to inject hooks (default: true) */
  instrument: boolean;
  /** Path to interact session dir — reuse its browser instead of launching new one */
  sessionDir?: string;
  /** CDP Fetch overrides — mock or block specific URLs */
  overrides?: Array<{
    urlPattern: string;
    action: 'mock' | 'block';
    status?: number;
    body?: string;
    contentType?: string;
  }>;
}

export interface BrowserConfig {
  /** Path to Chrome binary (auto-detected if omitted) */
  executablePath?: string;
  /** Use headless=new (default: false, use Xvfb) */
  headless: boolean;
  /** Extra Chrome flags */
  extraArgs: string[];
  /** Apply stealth plugin (default: true) */
  stealth: boolean;
  /** User data dir (tmpfs in Docker, temp dir locally) */
  userDataDir?: string;
}

export interface ScenarioConfig {
  /** Which phases to run (default: all) */
  phases: PhaseId[];
  /** Total max duration in seconds (default: 900 = 15min) */
  maxDuration: number;
  /** Per-phase duration overrides in seconds */
  phaseDurations: Partial<Record<PhaseId, number>>;
  /** Enable time acceleration for timer-based triggers */
  timeAcceleration: boolean;
  /** Simulated time jumps (seconds into future) */
  timeJumps: number[];
  /** Sites to visit during browsing phase */
  browsingSites: string[];
}

export type PhaseId =
  | 'install'
  | 'ext-interact'
  | 'browse'
  | 'login'
  | 'banking'
  | 'shopping'
  | 'idle'
  | 'tabs';

export interface CanaryConfig {
  /** Canary email for login forms */
  email: string;
  /** Canary password for login forms */
  password: string;
  /** Canary credit card number */
  creditCard: string;
  /** Canary session token value */
  sessionToken: string;
  /** Extra custom canary values to watch for */
  custom: Record<string, string>;
}

export interface AnalysisConfig {
  /** Run LLM analysis after collection (default: true) */
  enabled: boolean;
  /** Model for triage pass (default: haiku) */
  triageModel: string;
  /** Model for deep analysis (default: sonnet) */
  deepModel: string;
  /** Risk threshold to trigger deep analysis */
  deepAnalysisThreshold: RiskLevel;
  /** Max tokens per LLM pass */
  maxTokensPerPass: number;
  /** Path to static analysis results (for correlation) */
  staticAnalysisPath?: string;
}

export interface NetworkConfig {
  /** Use mitmproxy sidecar (default: false for local, true in Docker) */
  mitmproxy: boolean;
  /** Proxy address if using mitmproxy */
  proxyAddress?: string;
  /** Block outbound to non-allowlisted domains */
  blockExfiltration: boolean;
  /** Allowlisted domains (CDNs, Google APIs, etc.) */
  allowlist: string[];
}

/** Default configuration factory */
export function defaultConfig(
  extensionId: string,
  extensionPath: string,
): RunConfig {
  const runId = crypto.randomUUID();
  return {
    extensionId,
    extensionPath,
    runId,
    outputDir: `./output/${extensionId}`,
    browser: {
      headless: false,
      extraArgs: [],
      stealth: true,
    },
    scenario: {
      phases: ['install', 'ext-interact', 'browse', 'login', 'banking', 'shopping', 'idle', 'tabs'],
      maxDuration: 900,
      phaseDurations: {
        'install': 30,
        'ext-interact': 120,
        'browse': 90,
        'login': 120,
        'banking': 120,
        'shopping': 120,
        'idle': 300,
        'tabs': 120,
      },
      timeAcceleration: true,
      timeJumps: [3600, 86400, 259200],  // 1hr, 1day, 3days
      browsingSites: [
        'https://www.google.com',
        'https://www.amazon.com',
        'https://www.facebook.com',
        'https://www.reddit.com',
        'https://en.wikipedia.org',
        'https://www.github.com',
        'https://mail.google.com',
        'https://www.youtube.com',
      ],
    },
    canary: {
      email: `testuser_CANARY_${runId.slice(0, 8)}@example.com`,
      password: `P@ssw0rd_CANARY_${runId.slice(0, 8)}`,
      creditCard: '4111111111111111',
      sessionToken: `canary_session_${runId.slice(0, 12)}`,
      custom: {},
    },
    analysis: {
      enabled: true,
      triageModel: 'claude-haiku-4-5-20251001',
      deepModel: 'claude-sonnet-4-5-20250514',
      deepAnalysisThreshold: 'MEDIUM',
      maxTokensPerPass: 25000,
    },
    network: {
      mitmproxy: false,
      blockExfiltration: false,
      allowlist: [],
    },
    instrument: true,
  };
}
