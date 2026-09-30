import { createTerminal } from '@filtrix.net/terminal';
import { createBinanceProvider } from '@filtrix.net/datafeed';
import './terminal.css';
const terminal = createTerminal(document.getElementById('terminal')!, {
  provider: createBinanceProvider(),
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
});
const message = document.getElementById('message')!;
const storageKey = 'filtrix-charts:showcase:terminal:v1';
document.getElementById('save')!.addEventListener('click', () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(terminal.getWorkspace()));
    message.textContent = 'Workspace saved on this device.';
  } catch (e) {
    message.textContent = 'Save failed: ' + String(e);
  }
});
document.getElementById('restore')!.addEventListener('click', () => {
  void (async () => {
    try {
      const value = localStorage.getItem(storageKey);
      if (!value) {
        message.textContent = 'No saved workspace.';
        return;
      }
      await terminal.restoreWorkspace(JSON.parse(value));
      message.textContent = 'Workspace restored.';
    } catch (e) {
      message.textContent = 'Restore failed: ' + String(e);
    }
  })();
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) terminal.destroy();
});
