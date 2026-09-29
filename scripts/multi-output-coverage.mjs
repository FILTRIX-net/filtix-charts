import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded;

function systemChromePath() {
  const candidates = [
    process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      resolve(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

export async function loadBrowserCohort(root) {
  if (loaded) return loaded;
  const browserRoot = resolve(root, '.playwright');
  assert.ok(existsSync(browserRoot), 'Repository Playwright browser cohort is missing: ' + browserRoot);
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
  const playwright = await import('playwright');
  const chrome = process.platform === 'win32' ? systemChromePath() : null;
  const details = {
    browserRoot,
    chromium:
      process.platform === 'win32'
        ? { channel: 'chrome', executablePath: chrome }
        : { executablePath: playwright.chromium.executablePath() },
    firefox: { executablePath: playwright.firefox.executablePath() },
    webkit: { executablePath: playwright.webkit.executablePath() },
  };
  assert.ok(
    existsSync(details.chromium.executablePath),
    'Chromium executable is missing: ' + details.chromium.executablePath,
  );
  assert.ok(
    existsSync(details.firefox.executablePath),
    'Firefox executable is missing: ' + details.firefox.executablePath,
  );
  assert.ok(
    existsSync(details.webkit.executablePath),
    'WebKit executable is missing: ' + details.webkit.executablePath,
  );
  loaded = { ...playwright, details };
  return loaded;
}

export function browserLaunchOptions(name) {
  return {
    headless: true,
    timeout: 15_000,
    ...(process.platform === 'win32' && name === 'chromium' ? { channel: 'chrome' } : {}),
  };
}

function deadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' deadline exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function stopProcess(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill();
  try {
    await deadline(exited, 5000, label);
  } catch (error) {
    child.kill('SIGKILL');
    await deadline(exited, 5000, label + ' forced cleanup');
    throw error;
  }
}

export class CoverageProcessRegistry {
  constructor(cancelled = () => false) {
    this.cancelled = cancelled;
    this.owners = new Set();
    this.pendingLaunches = new Set();
    this.launches = [];
  }

  assertActive(label) {
    if (this.cancelled()) throw new Error('Coverage cancelled: ' + label);
  }

  async launch(name, engine) {
    this.assertActive('before ' + name + ' launch');
    const pending = engine.launchServer(browserLaunchOptions(name));
    this.pendingLaunches.add(pending);
    let server;
    try {
      server = await pending;
    } finally {
      this.pendingLaunches.delete(pending);
    }
    const child = server.process();
    const owner = {
      name,
      server,
      browser: null,
      pid: child.pid,
      closePromise: null,
      closed: false,
      forced: false,
    };
    this.owners.add(owner);
    this.launches.push({ name, pid: child.pid });
    try {
      this.assertActive('after ' + name + ' launch');
      owner.browser = await engine.connect(server.wsEndpoint());
      this.assertActive('after ' + name + ' connect');
      return owner;
    } catch (error) {
      await this.close(owner);
      throw error;
    }
  }

  async close(owner) {
    if (!owner) return;
    if (owner.closePromise) return owner.closePromise;
    owner.closePromise = (async () => {
      const child = owner.server.process();
      try {
        await deadline(owner.server.close(), 5000, owner.name + ' coverage normal close');
      } catch (normalError) {
        owner.forced = true;
        try {
          await deadline(owner.server.kill(), 5000, owner.name + ' coverage force close');
        } catch {
          // The verified child-process fallback remains authoritative.
        }
        await stopProcess(child, owner.name + ' coverage process');
        if (child.exitCode === null && child.signalCode === null) throw normalError;
      }
      await stopProcess(child, owner.name + ' coverage process');
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        owner.name + ' coverage process exited',
      );
      owner.closed = true;
    })();
    return owner.closePromise;
  }

  async closeAll() {
    const failures = [];
    while (this.pendingLaunches.size) {
      const pending = [...this.pendingLaunches];
      try {
        await deadline(Promise.allSettled(pending), 16_000, 'Coverage pending launch drain');
      } catch (error) {
        failures.push(error);
        break;
      }
    }
    const results = await Promise.allSettled([...this.owners].map((owner) => this.close(owner)));
    failures.push(...results.filter((result) => result.status === 'rejected').map((result) => result.reason));
    if (failures.length) throw new AggregateError(failures);
  }

  records() {
    return [...this.owners].map((owner) => ({
      name: owner.name,
      pid: owner.pid,
      closed: owner.closed,
      forced: owner.forced,
      processExited: owner.server.process().exitCode !== null || owner.server.process().signalCode !== null,
    }));
  }
}

export async function withFixtureGate(page, operation) {
  const previousGate = await page.evaluate(() => {
    const fixture = window.terminalHarness.fixture;
    const previous = fixture.stats().gated;
    fixture.gate(true);
    return previous;
  });
  try {
    return await operation(previousGate);
  } finally {
    await page.evaluate((previous) => window.terminalHarness.fixture.gate(previous), previousGate);
  }
}

export async function captureCoherentTerminal(page, holdMs = 300, flush = true) {
  return await page.evaluate(
    async ({ timerHoldMs, flush }) => {
      const harness = window.terminalHarness;
      const terminal = harness.terminal;
      const fixture = harness.fixture;
      const previousGate = fixture.stats().gated;
      const previousRange = terminal.chart.getVisibleRange();
      const follow = terminal.getSettings().followLatest;
      let off = null;
      let detach = null;
      fixture.gate(true);
      try {
        if (flush) fixture.flush(terminal.getState().feed.query);
        await terminal.chart.whenIdle();
        const bars = structuredClone(terminal.getData());
        const beforeTimer = fixture.stats();
        await new Promise((resolveTimer) => setTimeout(resolveTimer, timerHoldMs));
        await terminal.chart.whenIdle();
        const afterTimer = fixture.stats();
        terminal.chart.setVisibleRange({ from: -1, to: bars.length });
        await terminal.chart.whenIdle();
        let observed;
        off = terminal.chart.subscribeCrosshairMove((event) => {
          observed = event;
        });
        const rendered = [];
        for (const index of [18, 19, 24, 25, 32, 33, bars.length - 2, bars.length - 1]) {
          observed = null;
          terminal.chart.setCrosshairTime(bars[index].time);
          await terminal.chart.whenIdle();
          rendered.push({ index, time: observed?.time, points: observed?.points ?? {} });
        }
        let panes;
        detach = terminal.chart.attachPrimitive({
          draw(ctx, projection) {
            panes = projection.panes.map((pane) => ({ id: pane.id, scale: pane.scale }));
          },
        });
        await terminal.chart.whenIdle();
        return {
          bars,
          rendered,
          studies: terminal.getStudies(),
          state: terminal.getState(),
          panes,
          diagnostics: terminal.chart.getDiagnostics(),
          coherence: {
            holdMs: timerHoldMs,
            previousGate,
            beforeTimer,
            afterTimer,
            sourceTail: bars.at(-1),
          },
        };
      } finally {
        detach?.();
        off?.();
        terminal.chart.setCrosshairTime(null);
        terminal.chart.setVisibleRange(previousRange);
        terminal.chart.applyOptions({ followLatest: follow });
        await terminal.chart.whenIdle();
        fixture.gate(previousGate);
      }
    },
    { timerHoldMs: holdMs, flush },
  );
}
