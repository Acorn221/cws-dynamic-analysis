/**
 * Raw CDP WebSocket client for attaching to targets Puppeteer can't see.
 * Used for service workers that are invisible to Puppeteer's target list.
 */
import WebSocket from 'ws';
import { logger } from '../logger.js';
import type { NetworkRequest, TargetType } from '../types/events.js';
import { detectSource } from './network.js';
import type { PhaseTracker } from '../scenario/phase-tracker.js';

const log = logger.child({ component: 'raw-cdp' });

interface RawCdpOptions {
  wsEndpoint: string;
  swTargetId: string;
  onRequest: (req: NetworkRequest) => void;
  phaseTracker?: PhaseTracker;
}

/**
 * Attach to a service worker via raw WebSocket CDP and enable network monitoring.
 * Returns a cleanup function to close the connection.
 */
export async function attachToSwViaCdp(opts: RawCdpOptions): Promise<() => void> {
  const { wsEndpoint, swTargetId, onRequest, phaseTracker } = opts;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsEndpoint);
    let msgId = 1;
    let sessionId: string | null = null;
    const pendingRequests = new Map<string, Partial<NetworkRequest>>();

    const send = (method: string, params?: any, sid?: string) => {
      const msg: any = { id: msgId++, method };
      if (params) msg.params = params;
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return msg.id;
    };

    let attachId: number;

    ws.on('open', () => {
      attachId = send('Target.attachToTarget', { targetId: swTargetId, flatten: true });
    });

    ws.on('error', (err) => {
      log.debug({ err }, 'Raw CDP WebSocket error');
    });

    ws.on('message', (data: WebSocket.Data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch { return; }

      // Handle attachToTarget response
      if (msg.id === attachId && msg.result?.sessionId) {
        sessionId = msg.result.sessionId;
        log.info({ sessionId, swTargetId }, 'Raw CDP attached to SW');

        // Enable network monitoring on the SW session
        send('Network.enable', {
          maxTotalBufferSize: 10 * 1024 * 1024,
          maxResourceBufferSize: 5 * 1024 * 1024,
        }, sessionId);

        // Enable runtime for hooks
        send('Runtime.enable', {}, sessionId);

        // Resolve with cleanup function
        resolve(() => {
          try { ws.close(); } catch {}
        });
      }

      // Handle network events from the SW session
      if (msg.sessionId === sessionId) {
        if (msg.method === 'Network.requestWillBeSent') {
          const p = msg.params;
          const req: Partial<NetworkRequest> = {
            id: p.requestId,
            timestamp: p.wallTime ? new Date(p.wallTime * 1000).toISOString() : new Date().toISOString(),
            url: p.request.url,
            method: p.request.method,
            headers: p.request.headers ?? {},
            bodySize: p.request.postDataLength,
            bodyPreview: p.request.postData ?? undefined,
            targetType: 'service_worker' as TargetType,
            source: 'bgsw',
            phase: phaseTracker?.current,
            initiator: {
              type: p.initiator?.type ?? 'other',
              url: p.initiator?.url,
            },
            flagged: false,
            flagReasons: [],
            canaryDetections: [],
            relatedEvents: [],
          };
          pendingRequests.set(p.requestId, req);
        }

        if (msg.method === 'Network.responseReceived') {
          const p = msg.params;
          const req = pendingRequests.get(p.requestId);
          if (req) {
            req.status = p.response.status;
          }
          // Try to get response body
          const bodyId = send('Network.getResponseBody', { requestId: p.requestId }, sessionId!);
          // Store the ID so we can match the response
          (pendingRequests as any)[`body_${bodyId}`] = p.requestId;
        }

        if (msg.method === 'Network.loadingFinished') {
          const p = msg.params;
          const req = pendingRequests.get(p.requestId);
          if (req) {
            pendingRequests.delete(p.requestId);
            // Try to get response body if we don't have it
            if (!req.responseBodyPreview) {
              const bodyId = send('Network.getResponseBody', { requestId: p.requestId }, sessionId!);
              // Wait briefly then emit
              setTimeout(() => {
                onRequest(req as NetworkRequest);
              }, 500);
            } else {
              onRequest(req as NetworkRequest);
            }
          }
        }

        if (msg.method === 'Network.loadingFailed') {
          const p = msg.params;
          const req = pendingRequests.get(p.requestId);
          if (req) {
            pendingRequests.delete(p.requestId);
            req.status = 0;
            req.flagReasons = [...(req.flagReasons ?? []), `failed: ${p.errorText}`];
            onRequest(req as NetworkRequest);
          }
        }
      }

      // Handle getResponseBody responses
      if (msg.id && msg.result?.body) {
        const reqId = (pendingRequests as any)[`body_${msg.id}`];
        if (reqId) {
          const req = pendingRequests.get(reqId);
          if (req) {
            req.responseBodyPreview = msg.result.body;
          }
          delete (pendingRequests as any)[`body_${msg.id}`];
        }
      }
    });

    // Timeout if attachment fails
    setTimeout(() => {
      if (!sessionId) {
        log.warn('Raw CDP attachment timed out');
        try { ws.close(); } catch {}
        resolve(() => {}); // Resolve with noop cleanup
      }
    }, 10_000);
  });
}
