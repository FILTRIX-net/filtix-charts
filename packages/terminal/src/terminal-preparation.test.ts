import { describe, expect, test } from 'vitest';
import { createTerminalPreparationLifecycle } from './terminal-preparation';

function harness() {
  const calls: string[] = [];
  const token = () => calls.push('release');
  const lifecycle = createTerminalPreparationLifecycle({
    attach() {
      calls.push('attach');
      return token;
    },
    acceptLease(lease) {
      expect(typeof lease).toBe('function');
      calls.push('accept');
    },
    activate() {
      calls.push('activate');
    },
    dispose(lease) {
      calls.push('dispose');
      lease?.();
    },
  });
  return { lifecycle, calls, token };
}

describe('DOM-free terminal preparation lifecycle', () => {
  test('preparation is silent, start is single-shot, and destroy releases the exact acquired lease once', async () => {
    const { lifecycle, calls, token } = harness();
    expect(calls).toEqual([]);
    expect(lifecycle.getAlertLease()).toBe(null);
    await lifecycle.start();
    expect(lifecycle.getAlertLease()).toBe(token);
    await lifecycle.start();
    expect(calls).toEqual(['attach', 'accept', 'activate']);
    lifecycle.destroy();
    lifecycle.destroy();
    expect(calls).toEqual(['attach', 'accept', 'activate', 'dispose', 'release']);
    await expect(lifecycle.start()).rejects.toThrow(/destroyed/i);
  });

  test('a supplied C lease is claimed without attach or wrapping and released on teardown', async () => {
    const { lifecycle, calls } = harness();
    const supplied = () => calls.push('supplied release');
    await lifecycle.start({ alertLease: supplied });
    expect(lifecycle.getAlertLease()).toBe(supplied);
    expect(calls).toEqual(['accept', 'activate']);
    lifecycle.destroy();
    expect(calls).toEqual(['accept', 'activate', 'dispose', 'supplied release']);
  });

  test('pre-start destruction has no attachment or activation and fences future starts', async () => {
    const { lifecycle, calls } = harness();
    lifecycle.destroy();
    expect(calls).toEqual(['dispose']);
    await expect(lifecycle.start()).rejects.toThrow(/destroyed/i);
    expect(calls).toEqual(['dispose']);
  });

  test('destruction during effectful attach releases its late token without activating', async () => {
    const calls: string[] = [];
    const token = () => calls.push('release');
    let lifecycle: ReturnType<typeof createTerminalPreparationLifecycle>;
    lifecycle = createTerminalPreparationLifecycle({
      attach() {
        calls.push('attach');
        lifecycle.destroy();
        return token;
      },
      acceptLease() {
        calls.push('accept');
      },
      activate() {
        calls.push('activate');
      },
      dispose(lease) {
        calls.push('dispose');
        lease?.();
      },
    });
    await expect(lifecycle.start()).rejects.toThrow(/destroyed/i);
    expect(calls).toEqual(['attach', 'dispose', 'release']);
  });

  test('a callback destroying after lease admission fences later activation work', async () => {
    const calls: string[] = [];
    let lifecycle: ReturnType<typeof createTerminalPreparationLifecycle>;
    const token = () => calls.push('release');
    lifecycle = createTerminalPreparationLifecycle({
      attach() {
        return token;
      },
      acceptLease() {
        calls.push('accept');
        lifecycle.destroy();
      },
      activate() {
        calls.push('activate');
      },
      dispose(lease) {
        calls.push('dispose');
        lease?.();
      },
    });
    await expect(lifecycle.start()).rejects.toThrow(/destroyed/i);
    expect(calls).toEqual(['accept', 'dispose', 'release']);
  });
});
