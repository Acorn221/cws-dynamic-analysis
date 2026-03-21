import type { NetworkRequest, CanaryDetection, CanaryType } from '../types/events.js';
import type { CanaryConfig } from '../types/config.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'detector' });

/**
 * Known-benign domains: first-party telemetry and major platforms whose
 * normal traffic routinely matches heuristic patterns (base64 blobs,
 * credential-like field names, cookie headers).  Canary detection is
 * NEVER skipped — these only suppress pattern-based flags.
 */
const BENIGN_DOMAINS = new Set([
  'unagi.amazon.com', 'unagi-na.amazon.com', 'fls-na.amazon.com',  // Amazon telemetry
  'www.facebook.com',  // FB ajax/bz
  'www.instagram.com',
  'collector.github.com',  // GitHub telemetry
  'ogads-pa.clients6.google.com',  // Google ads
  'play.google.com',
  'accounts.google.com',
  'www.google.com',  // Google search
  'www.youtube.com',  // YouTube
  'www.reddit.com', 'www.redditstatic.com',
  'en.wikipedia.org',
  'api.github.com',
]);

const BENIGN_URL_PATTERNS = [
  /\.token\.awswaf\.com\//,    // AWS WAF challenge tokens
  /\/ajax\/bz\?/,              // Facebook telemetry
  /\/api\/jnn\//,              // YouTube integrity
  /\/gen_204\?/,               // Google beacons
  /\/csm\//,                   // Amazon CSM
];

interface CanaryEntry {
  type: CanaryType;
  value: string;
  pattern: RegExp;
}

/**
 * Scans network requests for canary data and suspicious patterns.
 * Canary detection is the strongest signal — if canary data leaves
 * the browser, it's confirmed exfiltration with zero false positives.
 */
export class Detector {
  private canaries: CanaryEntry[] = [];

  constructor(config: CanaryConfig) {
    this.registerCanary('email', config.email);
    this.registerCanary('password', config.password);
    this.registerCanary('credit_card', config.creditCard);
    this.registerCanary('session_token', config.sessionToken);
    for (const [key, val] of Object.entries(config.custom)) {
      this.registerCanary('custom', val);
    }
  }

  private registerCanary(type: CanaryType, value: string): void {
    if (!value) return;
    // Match the value itself, URL-encoded, or base64-encoded
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const urlEncoded = encodeURIComponent(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const b64 = Buffer.from(value).toString('base64').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(${escaped}|${urlEncoded}|${b64})`, 'i');
    this.canaries.push({ type, value, pattern });
  }

  /**
   * Scan a network request for canary data and suspicious patterns.
   * Mutates the request in place, adding flags and canary detections.
   */
  scan(request: NetworkRequest): void {
    // Skip internal requests
    if (
      request.url.startsWith('chrome-extension://') ||
      request.url.includes('localhost') ||
      request.url.includes('127.0.0.1')
    ) {
      return;
    }

    const searchable = [
      request.url,
      request.bodyPreview ?? '',
      JSON.stringify(request.headers),
    ].join(' ');

    // Canary detection
    for (const canary of this.canaries) {
      if (canary.pattern.test(searchable)) {
        const detection: CanaryDetection = {
          canaryType: canary.type,
          canaryValue: canary.value,
          foundInRequestId: request.id,
          destination: extractDomain(request.url),
          timestamp: request.timestamp,
          matchLocation: canary.pattern.test(request.bodyPreview ?? '')
            ? 'body'
            : canary.pattern.test(request.url)
              ? 'url'
              : 'header',
        };
        request.canaryDetections.push(detection);
        request.flagged = true;
        request.flagReasons.push(`canary:${canary.type}`);
        log.warn(
          { canaryType: canary.type, destination: detection.destination },
          'CANARY DATA DETECTED IN OUTBOUND REQUEST',
        );
      }
    }

    // Suspicious pattern detection
    if (request.method === 'POST' || request.method === 'PUT') {
      const body = request.bodyPreview ?? '';
      const domain = extractDomain(request.url);
      const source = (request as any).source as string | undefined;

      // Pattern-based flags only fire when the request comes from an
      // extension OR targets a domain that isn't known-benign.  This
      // eliminates FPs from AWS WAF tokens, Amazon telemetry, YouTube
      // integrity tokens, Facebook analytics, etc.
      const isBenignTarget =
        source !== 'extension' &&
        (BENIGN_DOMAINS.has(domain) ||
          BENIGN_URL_PATTERNS.some((re) => re.test(request.url)));

      if (!isBenignTarget) {
        // Large POST to unknown domain
        if ((request.bodySize ?? 0) > 5000) {
          request.flagged = true;
          request.flagReasons.push('large_outbound_post');
        }

        // Base64 blobs (common exfil encoding)
        if (/[A-Za-z0-9+/]{100,}={0,2}/.test(body)) {
          request.flagged = true;
          request.flagReasons.push('base64_blob');
        }

        // Credential-like patterns
        if (/(?:password|passwd|pwd|secret|token|api[_-]?key)/i.test(body)) {
          request.flagged = true;
          request.flagReasons.push('credential_pattern');
        }

        // Cookie-like patterns
        if (/(?:cookie|session[_-]?id|csrf|jwt|auth[_-]?token)/i.test(body)) {
          request.flagged = true;
          request.flagReasons.push('cookie_pattern');
        }
      }
    }
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
