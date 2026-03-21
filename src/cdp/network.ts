import type { CDPSession } from 'puppeteer';
import type { NetworkRequest, TargetType } from '../types/events.js';
import type { PhaseTracker } from '../scenario/phase-tracker.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'network' });

export type NetworkEventHandler = (request: NetworkRequest) => void;

/**
 * Determine whether a network request originated from the extension or the page.
 */
function detectSource(
  targetType: TargetType,
  initiatorUrl?: string,
  stackTrace?: string,
): 'extension' | 'page' | 'unknown' {
  // Service workers and background pages are always extension context
  if (targetType === 'service_worker' || targetType === 'background_page') {
    return 'extension';
  }

  // Check initiator URL for chrome-extension:// scheme
  if (initiatorUrl && initiatorUrl.startsWith('chrome-extension://')) {
    return 'extension';
  }

  // Check stack trace for chrome-extension:// references
  if (stackTrace && stackTrace.includes('chrome-extension://')) {
    return 'extension';
  }

  // Popup and content_script contexts are extension-originated
  if (targetType === 'popup' || targetType === 'content_script') {
    return 'extension';
  }

  // Page target with no extension signals → page traffic
  if (targetType === 'page') {
    return 'page';
  }

  return 'unknown';
}

/**
 * Enable network monitoring on a CDP session.
 * Captures all HTTP requests and responses with initiator info.
 */
export async function enableNetworkMonitoring(
  session: CDPSession,
  targetType: TargetType,
  onEvent: NetworkEventHandler,
  phaseTracker?: PhaseTracker,
): Promise<void> {
  const pendingRequests = new Map<string, Partial<NetworkRequest>>();

  await session.send('Network.enable', {
    maxTotalBufferSize: 10 * 1024 * 1024, // 10MB buffer
    maxResourceBufferSize: 5 * 1024 * 1024,
  });

  session.on('Network.requestWillBeSent', (params: any) => {
    const initiatorUrl: string | undefined = params.initiator?.url;
    const stackTrace: string | undefined = params.initiator?.stack?.callFrames
      ?.slice(0, 3)
      .map((f: any) => `${f.functionName}@${f.url}:${f.lineNumber}`)
      .join(' → ');

    const req: Partial<NetworkRequest> = {
      id: params.requestId,
      timestamp: new Date(params.wallTime * 1000).toISOString(),
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers ?? {},
      bodySize: params.request.postDataLength,
      bodyPreview: params.request.postData?.slice(0, 2000),
      targetType,
      source: detectSource(targetType, initiatorUrl, stackTrace),
      phase: phaseTracker?.current,
      initiator: {
        type: params.initiator?.type ?? 'other',
        url: initiatorUrl,
        lineNumber: params.initiator?.lineNumber,
        stackTrace,
      },
      flagged: false,
      flagReasons: [],
      canaryDetections: [],
      relatedEvents: [],
    };

    pendingRequests.set(params.requestId, req);
  });

  session.on('Network.responseReceived', (params: any) => {
    const req = pendingRequests.get(params.requestId);
    if (!req) return;

    req.status = params.response.status;

    // Try to capture response body for flagged/suspicious requests
    captureResponseBody(session, params.requestId, req).catch(() => {
      // Response body may not be available — that's fine
    });
  });

  session.on('Network.loadingFinished', (params: any) => {
    const req = pendingRequests.get(params.requestId);
    if (!req) return;
    pendingRequests.delete(params.requestId);

    onEvent(req as NetworkRequest);
  });

  session.on('Network.loadingFailed', (params: any) => {
    const req = pendingRequests.get(params.requestId);
    if (!req) return;
    pendingRequests.delete(params.requestId);
    req.status = 0;
    req.flagReasons = [...(req.flagReasons ?? []), `failed: ${params.errorText}`];

    onEvent(req as NetworkRequest);
  });

  // WebSocket monitoring
  session.on('Network.webSocketCreated', (params: any) => {
    log.info({ url: params.url, targetType }, 'WebSocket created');
    onEvent({
      id: params.requestId,
      timestamp: new Date().toISOString(),
      url: params.url,
      method: 'WS_CONNECT',
      targetType,
      source: detectSource(targetType),
      phase: phaseTracker?.current,
      initiator: { type: 'script' },
      headers: {},
      flagged: true,
      flagReasons: ['websocket_connection'],
      canaryDetections: [],
      relatedEvents: [],
    });
  });

  log.debug({ targetType }, 'Network monitoring enabled');
}

async function captureResponseBody(
  session: CDPSession,
  requestId: string,
  req: Partial<NetworkRequest>,
): Promise<void> {
  try {
    const { body } = await session.send('Network.getResponseBody', { requestId });
    if (typeof body === 'string') {
      req.responseBodyPreview = body.slice(0, 2000);
    }
  } catch {
    // Body not available (e.g., streaming, too large)
  }
}
