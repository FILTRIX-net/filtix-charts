import type { TerminalApi } from './types';

export interface PreparedTerminal {
  readonly api: TerminalApi;
  start(options?: { alertLease?: () => void }): Promise<void>;
  getAlertLease(): (() => void) | null;
  destroy(): void;
}

interface LifecycleHooks {
  attach(): () => void;
  acceptLease(lease: () => void): void;
  activate(): void;
  dispose(lease: (() => void) | null): void;
}

/** Keeps callbacks from an effectful attachment from reviving a destroyed preparation. */
export function createTerminalPreparationLifecycle(hooks: LifecycleHooks) {
  let phase: 'prepared' | 'starting' | 'started' | 'destroyed' = 'prepared';
  let lease: (() => void) | null = null;

  function destroyed(): Error {
    return new Error('Terminal has been destroyed');
  }

  function isDestroyed(): boolean {
    return phase === 'destroyed';
  }

  function destroy(): void {
    if (phase === 'destroyed') return;
    phase = 'destroyed';
    const owned = lease;
    lease = null;
    hooks.dispose(owned);
  }

  function startNow(options?: { alertLease?: () => void }): void {
    if (phase === 'destroyed') throw destroyed();
    if (phase !== 'prepared') return;
    if (options?.alertLease !== undefined && typeof options.alertLease !== 'function')
      throw new TypeError('alertLease must be a release function');
    phase = 'starting';
    try {
      const acquired = options?.alertLease ?? hooks.attach();
      if (isDestroyed()) {
        acquired();
        throw destroyed();
      }
      lease = acquired;
      hooks.acceptLease(acquired);
      if (isDestroyed()) throw destroyed();
      hooks.activate();
      if (isDestroyed()) throw destroyed();
      phase = 'started';
    } catch (error) {
      if (!isDestroyed()) destroy();
      throw error;
    }
  }

  function start(options?: { alertLease?: () => void }): Promise<void> {
    try {
      startNow(options);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return {
    start,
    startNow,
    getAlertLease: () => lease,
    destroy,
  };
}
