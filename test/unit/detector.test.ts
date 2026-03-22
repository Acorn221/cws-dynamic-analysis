import { describe, it, expect } from 'vitest';
import { Detector } from '../../src/collector/detector.js';
import type { NetworkRequest } from '../../src/types/events.js';

function makeRequest(overrides: Partial<NetworkRequest> = {}): NetworkRequest {
  return {
    id: 'test-1',
    timestamp: new Date().toISOString(),
    url: 'https://evil.com/collect',
    method: 'POST',
    headers: {},
    targetType: 'service_worker',
    source: 'bgsw',
    initiator: { type: 'script' },
    flagged: false,
    flagReasons: [],
    canaryDetections: [],
    relatedEvents: [],
    ...overrides,
  };
}

const canaryConfig = {
  email: 'canary@test.example',
  password: 'SuperSecret123!',
  creditCard: '4111111111111111',
  sessionToken: 'tok_canary_abc123',
  custom: { ssn: '123-45-6789' },
};

describe('Detector', () => {
  describe('canary detection', () => {
    it('detects canary email in request body', () => {
      const d = new Detector(canaryConfig);
      const req = makeRequest({ bodyPreview: '{"email":"canary@test.example"}' });
      d.scan(req);
      expect(req.canaryDetections).toHaveLength(1);
      expect(req.canaryDetections[0].canaryType).toBe('email');
      expect(req.canaryDetections[0].matchLocation).toBe('body');
    });

    it('detects canary password in URL', () => {
      const d = new Detector(canaryConfig);
      const req = makeRequest({ url: 'https://evil.com/log?pw=SuperSecret123!' });
      d.scan(req);
      expect(req.canaryDetections.length).toBeGreaterThanOrEqual(1);
      expect(req.canaryDetections[0].canaryType).toBe('password');
    });

    it('detects base64-encoded canary', () => {
      const d = new Detector(canaryConfig);
      const b64 = Buffer.from('canary@test.example').toString('base64');
      const req = makeRequest({ bodyPreview: `{"data":"${b64}"}` });
      d.scan(req);
      expect(req.canaryDetections).toHaveLength(1);
    });

    it('detects URL-encoded canary', () => {
      const d = new Detector(canaryConfig);
      const encoded = encodeURIComponent('canary@test.example');
      const req = makeRequest({ bodyPreview: `data=${encoded}` });
      d.scan(req);
      expect(req.canaryDetections).toHaveLength(1);
    });

    it('detects credit card canary', () => {
      const d = new Detector(canaryConfig);
      const req = makeRequest({ bodyPreview: '{"cc":"4111111111111111"}' });
      d.scan(req);
      expect(req.canaryDetections).toHaveLength(1);
      expect(req.canaryDetections[0].canaryType).toBe('credit_card');
    });

    it('does NOT skip canary detection for benign domains', () => {
      const d = new Detector(canaryConfig);
      // Even amazon.com should trigger canary detection
      const req = makeRequest({
        url: 'https://unagi.amazon.com/collect',
        bodyPreview: 'canary@test.example',
        source: 'page',
      });
      d.scan(req);
      expect(req.canaryDetections).toHaveLength(1); // canary ALWAYS detected
    });
  });

  describe('benign domain allowlist', () => {
    it('suppresses pattern flags for benign page-sourced requests', () => {
      const d = new Detector(canaryConfig);
      const req = makeRequest({
        url: 'https://unagi.amazon.com/collect',
        bodyPreview: 'A'.repeat(200), // large base64-like blob
        bodySize: 6000,
        source: 'page',
        targetType: 'page',
      });
      d.scan(req);
      // Pattern flags should be suppressed for benign page traffic
      expect(req.flagReasons).not.toContain('large_outbound_post');
      expect(req.flagReasons).not.toContain('base64_blob');
    });

    it('does NOT suppress flags for extension-sourced requests to benign domains', () => {
      const d = new Detector(canaryConfig);
      const req = makeRequest({
        url: 'https://www.google.com/collect',
        bodyPreview: 'A'.repeat(200),
        bodySize: 6000,
        source: 'bgsw',
        targetType: 'service_worker',
      });
      d.scan(req);
      // Extension-sourced traffic should ALWAYS be flagged
      expect(req.flagged).toBe(true);
    });
  });

  describe('skips internal requests', () => {
    it('skips chrome-extension:// URLs', () => {
      const d = new Detector(canaryConfig);
      const req = makeRequest({
        url: 'chrome-extension://abc123/popup.html',
        bodyPreview: 'canary@test.example',
      });
      d.scan(req);
      expect(req.canaryDetections).toHaveLength(0);
    });

    it('skips localhost URLs', () => {
      const d = new Detector(canaryConfig);
      const req = makeRequest({
        url: 'http://localhost:3200/login',
        bodyPreview: 'canary@test.example',
      });
      d.scan(req);
      expect(req.canaryDetections).toHaveLength(0);
    });
  });
});
