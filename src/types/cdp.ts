/**
 * Typed interfaces for CDP events and responses we use.
 * Derived from devtools-protocol but simplified to what we actually need.
 * Avoids `as any` everywhere.
 */

/** Runtime.consoleAPICalled event */
export interface ConsoleAPICalledEvent {
  type: string;
  args: Array<{
    type: string;
    value?: string;
    description?: string;
  }>;
  executionContextId: number;
  timestamp: number;
  stackTrace?: { callFrames: CallFrame[] };
}

export interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/** Network.requestWillBeSent params */
export interface RequestWillBeSentParams {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    postDataLength?: number;
  };
  wallTime: number;
  documentURL?: string;
  initiator?: {
    type: string;
    url?: string;
    lineNumber?: number;
    stack?: {
      callFrames: CallFrame[];
    };
  };
}

/** Network.responseReceived params */
export interface ResponseReceivedParams {
  requestId: string;
  response: {
    url: string;
    status: number;
    headers: Record<string, string>;
  };
}

/** Network.loadingFinished params */
export interface LoadingFinishedParams {
  requestId: string;
  encodedDataLength: number;
}

/** Network.loadingFailed params */
export interface LoadingFailedParams {
  requestId: string;
  errorText: string;
}

/** Network.webSocketCreated params */
export interface WebSocketCreatedParams {
  requestId: string;
  url: string;
}

/** Fetch.requestPaused event */
export interface FetchRequestPausedEvent {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  frameId: string;
  resourceType: string;
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

/** Runtime.evaluate result */
export interface EvaluateResult {
  result: {
    type: string;
    value?: unknown;
    description?: string;
    objectId?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: { description: string };
  };
}

/** Target info from Target domain */
export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** SQLite row types for our schema */
export interface RequestRow {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  domain: string;
  source: string;
  phase: string;
  status: number | null;
  body_size: number | null;
  body: string | null;
  response_body: string | null;
  flagged: number;
  flag_reasons: string | null;
  canary_count: number;
  initiator_url: string | null;
  initiator_stack: string | null;
}

export interface HookRow {
  id: string;
  timestamp: string;
  api: string;
  args: string;
  return_value: string | null;
  caller: string;
  source: string | null;
  phase: string | null;
}

export interface ConsoleRow {
  rowid: number;
  timestamp: string;
  level: string;
  source: string;
  text: string;
  url: string | null;
  phase: string | null;
}

export interface CanaryRow {
  rowid: number;
  canary_type: string;
  canary_value: string;
  request_id: string;
  destination: string;
  match_location: string;
  timestamp: string;
}

export interface ApiCountRow {
  api: string;
  count: number;
  first_seen: string;
  last_seen: string;
}
