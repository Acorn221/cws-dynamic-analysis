import type { Browser, CDPSession, Target } from 'puppeteer';
import { logger } from '../logger.js';
import type { TargetType } from '../types/events.js';

const log = logger.child({ component: 'sessions' });

export interface ManagedSession {
  session: CDPSession;
  targetId: string;
  targetType: TargetType;
  targetUrl: string;
}

type SessionHandler = (managed: ManagedSession) => Promise<void>;

/**
 * Manages CDP sessions across all extension targets.
 * Auto-attaches to new targets (service workers, pages, popups)
 * and runs the provided handler to instrument each session.
 */
export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private handler: SessionHandler;
  private browserSession: CDPSession;

  constructor(browserSession: CDPSession, handler: SessionHandler) {
    this.browserSession = browserSession;
    this.handler = handler;
  }

  /** Get all active sessions */
  getAll(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /** Get sessions by target type */
  getByType(type: TargetType): ManagedSession[] {
    return [...this.sessions.values()].filter((s) => s.targetType === type);
  }

  /**
   * Start auto-attaching to extension targets.
   * waitForDebuggerOnStart: true pauses new targets so we can inject
   * instrumentation before any extension code runs.
   */
  async startAutoAttach(extensionId: string): Promise<void> {
    // Listen for new target attachments
    this.browserSession.on(
      'Target.attachedToTarget',
      async (event: any) => {
        const { sessionId, targetInfo } = event;
        if (!targetInfo.url.includes(extensionId)) {
          // Not our extension — resume and ignore
          try {
            await (this.browserSession as any).send(
              'Runtime.runIfWaitingForDebugger',
              {},
              sessionId,
            );
          } catch { /* target may have already resumed */ }
          return;
        }

        const targetType = this.mapTargetType(targetInfo.type);
        log.info(
          { targetType, url: targetInfo.url, sessionId },
          'Extension target attached',
        );

        // Create a managed session wrapper
        // Note: in flattened mode, we send commands via the browser session
        // with the sessionId parameter, but Puppeteer also lets us get
        // a CDPSession object for the target
        const managed: ManagedSession = {
          session: null as any, // filled below
          targetId: targetInfo.targetId,
          targetType,
          targetUrl: targetInfo.url,
        };

        this.sessions.set(targetInfo.targetId, managed);

        // Run the instrumentation handler
        try {
          await this.handler(managed);
        } catch (err) {
          log.error({ err, targetType }, 'Failed to instrument target');
        }
      },
    );

    this.browserSession.on(
      'Target.detachedFromTarget',
      (event: any) => {
        const { targetId } = event;
        if (this.sessions.has(targetId)) {
          log.info({ targetId }, 'Extension target detached');
          this.sessions.delete(targetId);
        }
      },
    );

    // Enable auto-attach with debugger pause
    await this.browserSession.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [
        { type: 'service_worker', exclude: false },
        { type: 'page', exclude: false },
      ],
    });

    log.info({ extensionId }, 'Auto-attach enabled');
  }

  private mapTargetType(cdpType: string): TargetType {
    switch (cdpType) {
      case 'service_worker':
        return 'service_worker';
      case 'background_page':
        return 'background_page';
      case 'worker':
        return 'worker';
      default:
        return 'page';
    }
  }
}
