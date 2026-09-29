import { StrictMode, createRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiltixChart } from '@filtix/react';
import type { ChartApi } from '@filtix/charts';
import { makeCandles } from './fixtures';

const ref = createRef<ChartApi | null>();
const state = {
  ready: 0,
  destroyed: 0,
  ref,
  readyVersions: [] as string[],
  destroyedVersions: [] as string[],
  initialApi: null as ChartApi | null,
};
function App() {
  const [visible, setVisible] = useState(true);
  const [light, setLight] = useState(false);
  const version = light ? 'light' : 'dark';
  return (
    <>
      <button onClick={() => setVisible((v) => !v)}>Toggle chart</button>
      <button onClick={() => setLight((v) => !v)}>Change theme</button>
      {visible && (
        <FiltixChart
          ref={ref}
          style={{ height: 400, width: 800 }}
          options={{ theme: { background: light ? '#f1e2d3' : '#102030' }, ariaLabel: 'Chart ' + version }}
          onReady={(chart) => {
            state.ready++;
            state.readyVersions.push(version);
            state.initialApi = chart;
            chart.addSeries('candlestick').setData(makeCandles(100));
            chart.fitContent();
          }}
          onDestroy={() => {
            state.destroyed++;
            state.destroyedVersions.push(version);
          }}
        />
      )}
    </>
  );
}
declare global {
  interface Window {
    testReact: typeof state;
  }
}
window.testReact = state;
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
