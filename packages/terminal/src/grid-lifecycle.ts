import type { PreparedAlertMembership } from '@filtrix.net/alerts/internal';
import { TerminalMutationSupersededError } from './mutation';

/** DOM-free generation, transaction, and observer-repair coordinator for one grid. */
export function createGridLifecycle() {
  let generation = 0;
  let lastStructuralGeneration = 0;
  let destroyed = false;
  let pending: PreparedAlertMembership | null = null;
  let completing = false;
  let waiters: Array<() => void> = [];
  let repairBudget: { remaining: number } | null = null;

  function assertCurrent(ticket: number): void {
    if (destroyed || ticket !== generation) throw new TerminalMutationSupersededError();
  }

  function beginMutation(): number {
    if (destroyed) throw new Error('Terminal grid has been destroyed');
    lastStructuralGeneration = ++generation;
    return generation;
  }

  function beginPreferenceMutation(): number {
    if (destroyed) throw new Error('Terminal grid has been destroyed');
    return ++generation;
  }

  function assertStartupCurrent(ticket: number): void {
    if (destroyed || lastStructuralGeneration > ticket) throw new TerminalMutationSupersededError();
  }

  function clearWaiters(): void {
    if (pending || completing) return;
    const ready = waiters;
    waiters = [];
    ready.forEach((resolve) => resolve());
  }

  async function waitForActivation(ticket: number): Promise<void> {
    assertCurrent(ticket);
    if (pending || completing) await new Promise<void>((resolve) => waiters.push(resolve));
    assertCurrent(ticket);
  }

  function commit(ticket: number, transaction: PreparedAlertMembership): readonly (() => void)[] {
    assertCurrent(ticket);
    if (pending || completing) throw new Error('Grid membership activation is pending');
    try {
      const leases = transaction.commit();
      pending = transaction;
      return leases;
    } catch (error) {
      transaction.abort();
      throw error;
    }
  }

  function finishActivation(): void {
    if (!pending || completing) return;
    const transaction = pending;
    pending = null;
    completing = true;
    try {
      transaction.activate();
    } finally {
      completing = false;
      clearWaiters();
    }
  }

  function destroy(cleanup: () => void): void {
    if (destroyed) return;
    destroyed = true;
    generation++;
    try {
      cleanup();
    } finally {
      finishActivation();
      clearWaiters();
    }
  }

  function repair(work: () => void): void {
    const prior = repairBudget;
    const budget = (repairBudget ??= { remaining: 8 });
    try {
      while (!destroyed) {
        if (budget.remaining-- <= 0) throw new Error('Grid repair did not settle within 8 attempts');
        const ticket = generation;
        try {
          work();
        } catch (error) {
          if (error instanceof Error && error.message === 'Grid repair did not settle within 8 attempts')
            throw error;
          if (destroyed) return;
          if (ticket === generation) throw error;
        }
        if (ticket === generation) return;
      }
    } finally {
      repairBudget = prior;
    }
  }

  return {
    beginMutation,
    beginPreferenceMutation,
    assertCurrent,
    assertStartupCurrent,
    waitForActivation,
    commit,
    finishActivation,
    destroy,
    repair,
    isCanonical: (id: string, identity: object, slots: ReadonlyMap<string, object>): boolean =>
      !destroyed && slots.get(id) === identity,
    get generation() {
      return generation;
    },
    get destroyed() {
      return destroyed;
    },
    get activationPending() {
      return pending !== null || completing;
    },
  };
}
