/** Normalized CDP event envelope — every collected event gets wrapped in this */
export interface CDPEvent {
  timestamp: string;
  runId: string;
  extensionId: string;
  sessionId: string;
  targetType: TargetType;
  targetUrl: string;
  domain: string;
  method: string;
  params: Record<string, unknown>;
}

export type TargetType =
  | 'page'
  | 'service_worker'
  | 'background_page'
  | 'popup'
  | 'content_script'
  | 'worker';

/** Network request captured via CDP Network domain */
export interface NetworkRequest {
  id: string;
  timestamp: string;
  url: string;
  method: string;
  status?: number;
  initiator: RequestInitiator;
  headers: Record<string, string>;
  bodySize?: number;
  bodyPreview?: string;
  responseBodyPreview?: string;
  targetType: TargetType;
  flagged: boolean;
  flagReasons: string[];
  canaryDetections: CanaryDetection[];
  relatedEvents: string[];
}

export interface RequestInitiator {
  type: 'script' | 'parser' | 'other' | 'preflight';
  url?: string;
  lineNumber?: number;
  stackTrace?: string;
}

/** Chrome API call captured via monkey-patching */
export interface ApiCall {
  id: string;
  timestamp: string;
  api: string;
  args: unknown[];
  returnValueSummary?: string;
  callerContext: TargetType;
  relatedEvents: string[];
}

/** Canary data detected in outbound traffic */
export interface CanaryDetection {
  canaryType: CanaryType;
  canaryValue: string;
  foundInRequestId: string;
  destination: string;
  timestamp: string;
  matchLocation: 'body' | 'url' | 'header' | 'cookie';
}

export type CanaryType =
  | 'email'
  | 'password'
  | 'credit_card'
  | 'session_token'
  | 'browsing_url'
  | 'clipboard'
  | 'custom';

/** DOM mutation observed from content script injection */
export interface DOMMutation {
  id: string;
  timestamp: string;
  type: 'script_injection' | 'iframe' | 'form_modification' | 'element_added' | 'attribute_changed';
  targetSelector?: string;
  detail: string;
  pageUrl: string;
}

/** Console log captured from extension or page */
export interface ConsoleEntry {
  timestamp: string;
  level: 'log' | 'warn' | 'error' | 'debug' | 'info';
  source: 'page' | 'extension' | 'hook';
  text: string;
  url?: string;
  lineNumber?: number;
}
