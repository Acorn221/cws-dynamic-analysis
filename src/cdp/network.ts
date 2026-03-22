import type { CDPSession } from 'puppeteer';
import type { NetworkRequest, TargetType, SourceLabel } from '../types/events.js';
import type { RequestWillBeSentParams, ResponseReceivedParams, LoadingFinishedParams, LoadingFailedParams, WebSocketCreatedParams, CallFrame } from '../types/cdp.js';
import type { PhaseTracker } from '../scenario/phase-tracker.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'network' });

export type NetworkEventHandler = (request: NetworkRequest) => void;

/**
 * Detect granular origin context for a network request.
 *
 * Labels:
 *   bgsw     — background service worker
 *   cs       — content script (extension JS running in page context)
 *   ext-page — extension popup, options page, side panel
 *   page     — main-world page JavaScript
 *   sandbox  — sandboxed extension page
 *   unknown  — can't determine
 *
 * @param pageUrl — the URL of the page/target the session is attached to
 */
/** @internal exported for testing */
export function detectSource(
  targetType: TargetType,
  initiatorUrl?: string,
  stackTrace?: string,
  pageUrl?: string,
): SourceLabel {
  // Service workers / background pages → bgsw
  if (targetType === 'service_worker' || targetType === 'background_page') {
    return 'bgsw';
  }

  // If the page itself is a chrome-extension:// URL → ext-page
  if (pageUrl?.startsWith('chrome-extension://')) {
    // Could be sandbox if the manifest declares it
    if (pageUrl.includes('sandbox')) return 'sandbox';
    return 'ext-page';
  }

  // Page target but initiator is chrome-extension:// → content script
  if (initiatorUrl?.startsWith('chrome-extension://')) {
    return 'cs';
  }
  if (stackTrace?.includes('chrome-extension://')) {
    return 'cs';
  }

  // Explicit popup / content_script target types
  if (targetType === 'popup') return 'ext-page';
  if (targetType === 'content_script') return 'cs';

  // Regular page traffic
  if (targetType === 'page') return 'page';

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
  pageUrl?: string,
): Promise<void> {
  const pendingRequests = new Map<string, Partial<NetworkRequest>>();

  await session.send('Network.enable', {
    maxTotalBufferSize: 10 * 1024 * 1024, // 10MB buffer
    maxResourceBufferSize: 5 * 1024 * 1024,
  });

  session.on('Network.requestWillBeSent', (params) => {
    const p = params as unknown as RequestWillBeSentParams;
    const initiatorUrl = p.initiator?.url;
    const stackTrace = p.initiator?.stack?.callFrames
      ?.slice(0, 3)
      .map((f: CallFrame) => `${f.functionName}@${f.url}:${f.lineNumber}`)
      .join(' → ');

    const req: Partial<NetworkRequest> = {
      id: p.requestId,
      timestamp: new Date(p.wallTime * 1000).toISOString(),
      url: p.request.url,
      method: p.request.method,
      headers: p.request.headers ?? {},
      bodySize: p.request.postDataLength,
      bodyPreview: p.request.postData ?? undefined,
      targetType,
      source: detectSource(targetType, initiatorUrl, stackTrace, pageUrl ?? p.documentURL),
      phase: phaseTracker?.current,
      initiator: {
        type: (p.initiator?.type as any) ?? 'other',
        url: initiatorUrl,
        lineNumber: p.initiator?.lineNumber,
        stackTrace,
      },
      flagged: false,
      flagReasons: [],
      canaryDetections: [],
      relatedEvents: [],
    };

    pendingRequests.set(p.requestId, req);
  });

  session.on('Network.responseReceived', async (params) => {
    const p = params as unknown as ResponseReceivedParams;
    const req = pendingRequests.get(p.requestId);
    if (!req) return;
    req.status = p.response.status;
    // Early capture — body may already be available for small responses
    await captureResponseBody(session, p.requestId, req).catch(() => {});
  });

  session.on('Network.loadingFinished', async (params) => {
    const p = params as unknown as LoadingFinishedParams;
    const req = pendingRequests.get(p.requestId);
    if (!req) return;
    pendingRequests.delete(p.requestId);

    // Final capture — body guaranteed complete now
    if (!req.responseBodyPreview) {
      await captureResponseBody(session, p.requestId, req).catch(() => {});
    }

    onEvent(req as NetworkRequest);
  });

  session.on('Network.loadingFailed', async (params) => {
    const p = params as unknown as LoadingFailedParams;
    const req = pendingRequests.get(p.requestId);
    if (!req) return;
    pendingRequests.delete(p.requestId);
    req.status = 0;
    req.flagReasons = [...(req.flagReasons ?? []), `failed: ${p.errorText}`];

    // Try capturing body even for failed/aborted requests —
    // Chrome often has the response body for ERR_ABORTED
    if (!req.responseBodyPreview) {
      await captureResponseBody(session, p.requestId, req).catch(() => {});
    }

    onEvent(req as NetworkRequest);
  });

  // WebSocket monitoring
  session.on('Network.webSocketCreated', (params) => {
    const p = params as unknown as WebSocketCreatedParams;
    log.info({ url: p.url, targetType }, 'WebSocket created');
    onEvent({
      id: p.requestId,
      timestamp: new Date().toISOString(),
      url: p.url,
      method: 'WS_CONNECT',
      targetType,
      source: detectSource(targetType, undefined, undefined, pageUrl),
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
      req.responseBodyPreview = body;
    }
  } catch {
    // Body not available (e.g., streaming, too large)
  }
}
