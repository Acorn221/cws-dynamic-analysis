/**
 * CDP Screencast bridge — streams Chrome viewport frames over WebSocket
 * and forwards mouse/keyboard input back to Chrome.
 */
import puppeteer, { type Browser, type Page, type CDPSession } from 'puppeteer';
import type { WebSocket } from 'ws';
import { logger } from '../logger.js';

const log = logger.child({ component: 'screencast' });

export class ScreencastBridge {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private active = false;
  private ws: WebSocket | null = null;

  async connect(wsEndpoint: string): Promise<string[]> {
    this.browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    const pages = await this.browser.pages();
    const urls = pages.map((p) => p.url());
    // Default to first non-extension, non-blank page
    this.page = pages.find((p) => !p.url().startsWith('chrome') && p.url() !== 'about:blank') ?? pages[0];
    log.info({ pageUrl: this.page?.url(), pageCount: pages.length }, 'Connected to browser');
    return urls;
  }

  async selectPage(urlSubstring: string): Promise<boolean> {
    if (!this.browser) return false;
    const pages = await this.browser.pages();
    const match = pages.find((p) => p.url().includes(urlSubstring));
    if (match) {
      await this.stop();
      this.page = match;
      return true;
    }
    return false;
  }

  async start(ws: WebSocket, opts: { quality?: number; maxWidth?: number; maxHeight?: number } = {}): Promise<void> {
    if (!this.page) throw new Error('No page selected');
    if (this.active) await this.stop();

    this.ws = ws;
    this.cdp = await this.page.createCDPSession();

    // Listen for screencast frames
    (this.cdp as any).on('Page.screencastFrame', (event: any) => {
      if (!this.ws || this.ws.readyState !== 1) return; // WebSocket.OPEN = 1

      this.ws.send(JSON.stringify({
        type: 'frame',
        data: event.data, // base64 JPEG
        sessionId: event.sessionId,
        metadata: event.metadata,
      }));

      // Acknowledge so Chrome sends the next frame
      this.cdp!.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });

    // Re-start screencast on navigation (it stops on cross-origin nav)
    (this.cdp as any).on('Page.frameNavigated', () => {
      if (this.active) {
        this.cdp!.send('Page.startScreencast', {
          format: 'jpeg',
          quality: opts.quality ?? 70,
          maxWidth: opts.maxWidth ?? 1280,
          maxHeight: opts.maxHeight ?? 800,
          everyNthFrame: 1,
        }).catch(() => {});
      }
    });

    await this.cdp.send('Page.startScreencast' as any, {
      format: 'jpeg',
      quality: opts.quality ?? 70,
      maxWidth: opts.maxWidth ?? 1280,
      maxHeight: opts.maxHeight ?? 800,
      everyNthFrame: 1,
    });

    this.active = true;
    log.info('Screencast started');
  }

  async stop(): Promise<void> {
    if (this.cdp && this.active) {
      await this.cdp.send('Page.stopScreencast' as any).catch(() => {});
      await this.cdp.detach().catch(() => {});
    }
    this.active = false;
    this.cdp = null;
    this.ws = null;
  }

  async dispatchMouse(params: {
    type: string;
    x: number;
    y: number;
    button?: string;
    clickCount?: number;
    modifiers?: number;
    deltaX?: number;
    deltaY?: number;
  }): Promise<void> {
    if (!this.cdp) return;

    if (params.type === 'scroll') {
      await this.cdp.send('Input.dispatchMouseEvent' as any, {
        type: 'mouseWheel',
        x: params.x,
        y: params.y,
        deltaX: params.deltaX ?? 0,
        deltaY: params.deltaY ?? 0,
        modifiers: params.modifiers ?? 0,
      });
      return;
    }

    await this.cdp.send('Input.dispatchMouseEvent' as any, {
      type: params.type,
      x: params.x,
      y: params.y,
      button: params.button ?? 'left',
      clickCount: params.clickCount ?? 1,
      modifiers: params.modifiers ?? 0,
    });
  }

  async dispatchKey(params: {
    type: string;
    key: string;
    code?: string;
    text?: string;
    modifiers?: number;
  }): Promise<void> {
    if (!this.cdp) return;

    await this.cdp.send('Input.dispatchKeyEvent' as any, {
      type: params.type,
      key: params.key,
      code: params.code ?? '',
      text: params.text,
      modifiers: params.modifiers ?? 0,
      windowsVirtualKeyCode: params.key.length === 1 ? params.key.charCodeAt(0) : 0,
    });
  }

  async listPages(): Promise<Array<{ url: string; title: string }>> {
    if (!this.browser) return [];
    const pages = await this.browser.pages();
    return Promise.all(pages.map(async (p) => ({
      url: p.url(),
      title: await p.title().catch(() => ''),
    })));
  }

  disconnect(): void {
    this.stop().catch(() => {});
    this.browser?.disconnect();
    this.browser = null;
    this.page = null;
  }
}
