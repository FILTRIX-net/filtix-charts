import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createTerminal, type TerminalApi, type TerminalState } from '@filtix/terminal';
import { createBinanceProvider } from '@filtix/datafeed';
import { createFixtureProvider } from './fixture-provider';
import { GridView } from './grid';
import { version as appVersion } from '../package.json';
import './style.css';

const fixtureMode = new URLSearchParams(location.search).get('source') === 'fixture';
const testing = new URLSearchParams(location.search).has('test');
const gridTesting = testing && new URLSearchParams(location.search).has('grid-test');
const initialView = new URLSearchParams(location.search).get('view') === 'grid' ? 'grid' : 'terminal';
const fixture = createFixtureProvider();
const storageKey = 'filtrix-charts:terminal:v1:' + (fixtureMode ? 'synthetic' : 'binance');
let active: TerminalApi | null = null;
const visibility: { state: DocumentVisibilityState; at: number }[] = [];
if (testing)
  document.addEventListener('visibilitychange', () =>
    visibility.push({ state: document.visibilityState, at: Date.now() }),
  );
function App() {
  const host = useRef<HTMLDivElement>(null);
  const [provider] = useState(() => (fixtureMode ? fixture.provider : createBinanceProvider()));
  const [view, setView] = useState<'terminal' | 'grid'>(initialView);
  const [mounted, setMounted] = useState(true);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('Connecting');
  useEffect(() => {
    if (view !== 'terminal' || !mounted || !host.current) return;
    let alive = true;
    const terminal = createTerminal(host.current, {
      provider,
      query: { symbol: 'BTCUSDT', interval: '1m' },
      studies: [
        { kind: 'ema', period: 20, color: '#c27a50' },
        { kind: 'sma', period: 200, color: '#c7ef57' },
        {
          kind: 'bollinger',
          period: 20,
          multiplier: 2,
          color: '#66b9c7',
          upperColor: '#7aa2f7',
          lowerColor: '#7aa2f7',
          fillColor: '#7aa2f7',
          fillOpacity: 0.12,
        },
        {
          kind: 'macd',
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9,
          color: '#7aa2f7',
          signalColor: '#e0af68',
          positiveColor: '#73c991',
          negativeColor: '#ef7c8e',
        },
        { kind: 'rsi', period: 14, color: '#a8a0dc' },
      ],
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      intervals: ['1m', '5m', '1h'],
      feed: fixtureMode
        ? {
            initialLimit: 500,
            pageSize: 200,
            maxBars: 10_000,
            maxBufferedBars: 500,
            staleAfterMs: 30_000,
            requestTimeoutMs: 3_000,
            reconnectBaseMs: 500,
            reconnectMaxMs: 5_000,
            maxRetries: 100,
          }
        : {},
      onState(state: TerminalState) {
        if (alive) setStatus(state.error ?? state.feed.status);
      },
    });
    active = terminal;
    return () => {
      alive = false;
      if (active === terminal) active = null;
      terminal.destroy();
    };
  }, [mounted, provider, view]);
  const save = () => {
    try {
      if (!active) return;
      localStorage.setItem(storageKey, JSON.stringify(active.getWorkspace()));
      setMessage('Workspace saved on this device.');
    } catch (e) {
      setMessage('Save failed: ' + String(e));
    }
  };
  const load = async () => {
    const target = active;
    if (!target) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) {
        setMessage('No saved workspace for this source.');
        return;
      }
      await target.restoreWorkspace(JSON.parse(saved));
      if (active !== target) return;
      const state = target.getState();
      setMessage(
        state.feed.status === 'live' && !state.error
          ? 'Workspace restored.'
          : 'Workspace loaded; ' + (state.error ?? state.feed.error?.message ?? state.feed.status),
      );
    } catch (e) {
      if (active === target) setMessage('Restore failed: ' + String(e));
    }
  };
  return (
    <>
      <header className="app-header">
        <a className="brand" href="/" aria-label="FILTIX Charts by FILTIX.net">
          <svg className="brand-mark" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
            <path d="M5 4h28l-4.5 8H14v5h12l-4.5 8H14v8H5z" fill="currentColor" />
          </svg>
          <span className="brand-text">
            <strong className="brand-name">FILTIX</strong>
            <span className="brand-product">CHARTS</span>
            <span className="brand-attribution">by FILTIX.net</span>
          </span>
        </a>
        <div className="source">
          <i />
          {fixtureMode ? 'SYNTHETIC / CLOCK' : 'BINANCE / SPOT'}
        </div>
        <span className="release">BETA · v{appVersion}</span>
      </header>
      <main>
        <div className="intro">
          <div>
            <p className="eyebrow">YOUR MARKET WORKSPACE</p>
            <h1>
              {view === 'grid' ? 'Four views.' : 'A clearer view.'}
              <br />
              <em>{view === 'grid' ? 'One workspace.' : 'Your own terminal.'}</em>
            </h1>
          </div>
          <p className="intro-copy">
            Price, studies and your ideas in one place.
            <br />
            Built to fit the way you work.
          </p>
        </div>
        <div className="view-switch" role="group" aria-label="Workspace view">
          <button type="button" aria-pressed={view === 'terminal'} onClick={() => setView('terminal')}>
            Terminal
          </button>
          <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
            Grid
          </button>
        </div>
        {view === 'terminal' ? (
          <section className="workspace" aria-label="Market workspace">
            <div className="workspace-bar">
              <div>
                <span className="live-dot" />
                {status}
              </div>
              <div className="workspace-actions">
                <button onClick={save} disabled={!mounted}>
                  Save workspace
                </button>
                <button onClick={() => void load()} disabled={!mounted}>
                  Restore
                </button>
                <button onClick={() => setMounted((value) => !value)}>
                  {mounted ? 'Close terminal' : 'Open terminal'}
                </button>
              </div>
            </div>
            <div ref={host} className="terminal-host" />
            {!mounted && (
              <div className="closed">
                <strong>Workspace closed</strong>
                <p>Open the terminal to start a fresh session.</p>
              </div>
            )}
            <div className="message" role="status">
              {message ||
                'Your drawings and preferences stay with each market. Save to keep them on this device.'}
            </div>
          </section>
        ) : (
          <GridView provider={provider} fixtureMode={fixtureMode} />
        )}
        <footer>
          <span>
            {fixtureMode
              ? 'Deterministic synthetic data · no trading signals'
              : 'Public market data · timestamps in UTC'}
          </span>
          <a href={fixtureMode ? '/' : '/?source=fixture'}>
            {fixtureMode ? 'Open live market ↗' : 'Explore synthetic market ↗'}
          </a>
          <a
            className="footer-attribution"
            href="https://filtix.net/?utm_source=filtix_charts&utm_medium=demo&utm_campaign=open_beta&utm_content=react-terminal"
            target="_blank"
            rel="noopener noreferrer"
          >
            by FILTIX.net · Explore ↗
          </a>
        </footer>
      </main>
    </>
  );
}
if (testing)
  Object.assign(window, {
    terminalHarness: {
      get terminal() {
        return active;
      },
      fixture,
      visibility,
      getLayout() {
        return active?.getLayout() ?? null;
      },
      applyLayout(patch: Parameters<TerminalApi['applyLayout']>[0]) {
        if (!active) throw new Error('Terminal is closed');
        active.applyLayout(patch);
      },
      resetLayout() {
        if (!active) throw new Error('Terminal is closed');
        active.resetLayout();
      },
    },
  });
if (testing && new URLSearchParams(location.search).has('alerts')) {
  // @ts-expect-error Dedicated installed-archive workload is intentionally plain JavaScript.
  void import('./alerts-test.js');
} else if (testing && new URLSearchParams(location.search).has('drawing-tools')) {
  // @ts-expect-error Dedicated installed-archive workload is intentionally plain JavaScript.
  void import('./drawing-tools-test.js');
} else if (gridTesting) {
  // @ts-expect-error Test-only instrumentation is intentionally plain JavaScript.
  void import('./grid-test.js').then((module) => {
    const root = createRoot(document.getElementById('root')!);
    module.attachRoot(root);
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
