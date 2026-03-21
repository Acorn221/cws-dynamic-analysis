export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAN';
export type Confidence = 'confirmed' | 'high' | 'moderate' | 'low';

export type FindingType =
  | 'credential_exfil'
  | 'cookie_theft'
  | 'history_harvest'
  | 'canary_detected'
  | 'c2_communication'
  | 'dom_injection'
  | 'unauthorized_data_collection'
  | 'code_execution'
  | 'anti_analysis'
  | 'session_hijack'
  | 'csp_stripping'
  | 'remote_code_load'
  | 'time_bomb';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** A single confirmed finding from dynamic analysis */
export interface Finding {
  id: string;
  findingType: FindingType;
  severity: Severity;
  title: string;
  description: string;
  evidence: Evidence;
  staticCorrelation?: string;
  timestamp: string;
}

export interface Evidence {
  requestIds: string[];
  hookIds: string[];
  screenshots: string[];
  canaryDetections: string[];
  rawSnippets: string[];
}

/** Final verdict from LLM analysis */
export interface Verdict {
  riskLevel: RiskLevel;
  confidence: Confidence;
  summary: string;
  confirmedBehaviors: string[];
  disprovenSuspicions: string[];
  recommendations: string[];
  findings: Finding[];
}

/** Summary of an analysis run, used for DB ingest */
export interface RunSummary {
  runId: string;
  extensionId: string;
  extensionVersion?: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  status: 'completed' | 'failed' | 'timeout';
  chromeVersion?: string;
  scenarioConfig: ScenarioSummary;
  networkStats: NetworkStats;
  apiHookStats: ApiHookStats;
  canaryDetections: number;
  verdict?: Verdict;
  rawLogPath: string;
}

export interface ScenarioSummary {
  phasesRun: string[];
  totalDurationSeconds: number;
  sitesVisited: string[];
  formsInteracted: number;
  timeAccelerated: boolean;
}

export interface NetworkStats {
  totalRequests: number;
  externalDomains: string[];
  flaggedRequests: number;
  blockedRequests: number;
  totalBytesOut: number;
  totalBytesIn: number;
}

export interface ApiHookStats {
  totalCalls: number;
  byApi: Record<string, number>;
  sensitiveApis: string[];
}
