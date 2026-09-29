import { describe, expect, it, vi } from 'vitest';
import { TerminalMutationSupersededError } from './mutation';
import { createGridLifecycle } from './grid-lifecycle';

function transaction(count: number) {
  const tokens = Array.from({ length: count }, () => vi.fn());
  return {
    tokens,
    commit: vi.fn(() => tokens as readonly (() => void)[]),
    abort: vi.fn(),
    activate: vi.fn(),
  };
}

describe('grid lifecycle coordinator', () => {
  it('owns every committed C token before a terminal starts and discharges activation after synchronous destroy', () => {
    const lifecycle = createGridLifecycle();
    const ticket = lifecycle.beginMutation();
    const membership = transaction(8);
    const leases = lifecycle.commit(ticket, membership);
    expect(leases).toBe(membership.tokens);
    expect(membership.commit).toHaveBeenCalledTimes(1);
    expect(membership.activate).not.toHaveBeenCalled();

    // Four grid and four terminal leases are canonical even when no preparation has started.
    lifecycle.destroy(() => leases.forEach((release) => release()));
    expect(membership.tokens.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(membership.activate).toHaveBeenCalledTimes(1);
    lifecycle.finishActivation();
    expect(membership.activate).toHaveBeenCalledTimes(1);
    expect(() => lifecycle.assertCurrent(ticket)).toThrow(TerminalMutationSupersededError);
  });

  it('marks nested async work stale immediately but waits to reserve until activation unwinds', async () => {
    const lifecycle = createGridLifecycle();
    const first = lifecycle.beginMutation();
    const membership = transaction(5);
    lifecycle.commit(first, membership);
    const nested = lifecycle.beginMutation();
    expect(() => lifecycle.assertCurrent(first)).toThrow(TerminalMutationSupersededError);
    let unblocked = false;
    const waiting = lifecycle.waitForActivation(nested).then(() => {
      unblocked = true;
    });
    await Promise.resolve();
    expect(unblocked).toBe(false);
    expect(membership.activate).not.toHaveBeenCalled();
    lifecycle.finishActivation();
    await waiting;
    expect(unblocked).toBe(true);
    expect(membership.activate).toHaveBeenCalledTimes(1);
    lifecycle.assertCurrent(nested);
  });

  it('aborts failed reservations without acquiring an activation obligation', () => {
    const lifecycle = createGridLifecycle();
    const ticket = lifecycle.beginMutation();
    const membership = transaction(1);
    membership.commit.mockImplementation(() => {
      throw new Error('changed participating store');
    });
    expect(() => lifecycle.commit(ticket, membership)).toThrow('changed participating store');
    expect(membership.abort).toHaveBeenCalledTimes(1);
    lifecycle.finishActivation();
    expect(membership.activate).not.toHaveBeenCalled();
  });

  it('shares one eight-attempt repair budget across nested observer repairs and reports exhaustion', () => {
    const lifecycle = createGridLifecycle();
    let attempts = 0;
    function mutateForever(): void {
      lifecycle.repair(() => {
        attempts++;
        lifecycle.beginMutation();
        mutateForever();
      });
    }
    expect(mutateForever).toThrow(/repair did not settle within 8 attempts/i);
    expect(attempts).toBe(8);
  });

  it('a retained slot remains current through a layout generation change while removed identity is fenced', () => {
    const lifecycle = createGridLifecycle();
    const retained = {};
    const removed = {};
    const canonical = new Map<string, object>([
      ['cell-1', retained],
      ['cell-2', removed],
    ]);
    const oldTicket = lifecycle.beginMutation();
    const nextTicket = lifecycle.beginMutation();
    canonical.delete('cell-2');
    expect(() => lifecycle.assertCurrent(oldTicket)).toThrow(TerminalMutationSupersededError);
    expect(lifecycle.isCanonical('cell-1', retained, canonical)).toBe(true);
    expect(lifecycle.isCanonical('cell-2', removed, canonical)).toBe(false);
    lifecycle.assertCurrent(nextTicket);
  });

  it('preference reentry invalidates precommit work but preserves canonical startup after commit', () => {
    const lifecycle = createGridLifecycle();
    const ticket = lifecycle.beginMutation();
    lifecycle.commit(ticket, transaction(8));
    lifecycle.finishActivation();
    lifecycle.beginPreferenceMutation();
    expect(() => lifecycle.assertCurrent(ticket)).toThrow(TerminalMutationSupersededError);
    expect(() => lifecycle.assertStartupCurrent(ticket)).not.toThrow();
    lifecycle.beginMutation();
    expect(() => lifecycle.assertStartupCurrent(ticket)).toThrow(TerminalMutationSupersededError);
  });
});
