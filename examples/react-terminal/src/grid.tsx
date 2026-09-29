import { useEffect, useRef, useState } from 'react';
import { createTerminalGrid, type TerminalGridApi, type TerminalGridState } from '@filtix/terminal';
import type { MarketDataProvider } from '@filtix/datafeed';

interface GridTestHooks {
  mounted(grid: TerminalGridApi): void;
  destroyed(grid: TerminalGridApi): void;
}

export function GridView({ provider, fixtureMode }: { provider: MarketDataProvider; fixtureMode: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const gridRef = useRef<TerminalGridApi | null>(null);
  const [mounted, setMounted] = useState(true);
  const [status, setStatus] = useState('Connecting');
  const [message, setMessage] = useState(
    'Save this grid to keep each market, drawing and alert on this device.',
  );
  const storageKey = `filtix:terminal-grid:v1:${provider.id}`;

  useEffect(() => {
    if (!mounted || !host.current) return;
    let alive = true;
    let grid: TerminalGridApi;
    try {
      grid = createTerminalGrid(host.current, {
        provider,
        query: { symbol: 'BTCUSDT', interval: '1m' },
        symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        intervals: ['1m', '5m', '1h'],
        layout: 4,
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
        onState(state: TerminalGridState) {
          if (!alive) return;
          const active = state.cells.find((cell) => cell.id === state.activeCellId);
          setStatus(state.error ?? active?.terminal?.error ?? active?.terminal?.feed.status ?? 'Ready');
        },
      });
      gridRef.current = grid;
      (window as unknown as { __filtixGridTestHooks?: GridTestHooks }).__filtixGridTestHooks?.mounted(grid);
    } catch (failure) {
      setStatus('Grid unavailable');
      setMessage('Grid failed: ' + String(failure));
      return () => {
        alive = false;
      };
    }
    return () => {
      alive = false;
      if (gridRef.current === grid) gridRef.current = null;
      grid.destroy();
      (window as unknown as { __filtixGridTestHooks?: GridTestHooks }).__filtixGridTestHooks?.destroyed(grid);
    };
  }, [mounted, provider, fixtureMode]);

  const save = () => {
    try {
      const grid = gridRef.current;
      if (!grid) return;
      localStorage.setItem(storageKey, JSON.stringify(grid.getWorkspace()));
      setMessage('Grid saved on this device.');
    } catch (failure) {
      setMessage('Save failed: ' + String(failure));
    }
  };

  const restore = async () => {
    const grid = gridRef.current;
    if (!grid) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === null) {
        setMessage('No saved grid for this source.');
        return;
      }
      await grid.restoreWorkspace(JSON.parse(saved));
      if (gridRef.current !== grid) return;
      const state = grid.getState();
      setMessage(state.error ? `Grid loaded; ${state.error}` : 'Grid restored.');
    } catch (failure) {
      if (gridRef.current === grid) setMessage('Restore failed: ' + String(failure));
    }
  };

  return (
    <section className="workspace grid-workspace" aria-label="Grid market workspace">
      <div className="workspace-bar">
        <div>
          <span className="live-dot" />
          {status}
        </div>
        <div className="workspace-actions">
          <button onClick={save} disabled={!mounted}>
            Save grid
          </button>
          <button onClick={() => void restore()} disabled={!mounted}>
            Restore grid
          </button>
          <button onClick={() => setMounted((value) => !value)}>
            {mounted ? 'Close grid' : 'Open grid'}
          </button>
        </div>
      </div>
      <div ref={host} className="grid-host" data-grid-example-host="" />
      {!mounted && (
        <div className="closed">
          <strong>Grid closed</strong>
          <p>Open the grid to start a fresh session.</p>
        </div>
      )}
      <div className="message" role="status" data-grid-example-message="">
        {message}
      </div>
    </section>
  );
}
