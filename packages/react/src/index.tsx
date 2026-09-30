import { forwardRef, useEffect, useRef, type CSSProperties, type ForwardedRef } from 'react';
import { createChart, type ChartApi, type ChartOptions } from '@filtrix.net/charts';

export interface FiltrixChartProps {
  options?: ChartOptions;
  className?: string;
  style?: CSSProperties;
  onReady?: (chart: ChartApi) => void;
  onDestroy?: () => void;
}

function assignRef(ref: ForwardedRef<ChartApi | null>, value: ChartApi | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/** Browser lifecycle adapter. Data updates go through the chart API, not React state. */
export const FiltrixChart = forwardRef<ChartApi | null, FiltrixChartProps>(function FiltrixChart(
  { options, className, style, onReady, onDestroy },
  forwardedRef,
) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ChartApi | null>(null);
  const initialOptions = useRef(options);
  const callbacks = useRef({ onReady, onDestroy });

  useEffect(() => {
    callbacks.current = { onReady, onDestroy };
  }, [onReady, onDestroy]);

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, initialOptions.current);
    api.current = chart;
    try {
      callbacks.current.onReady?.(chart);
    } catch (error) {
      chart.destroy();
      api.current = null;
      throw error;
    }
    return () => {
      chart.destroy();
      api.current = null;
      callbacks.current.onDestroy?.();
    };
  }, []);

  useEffect(() => {
    assignRef(forwardedRef, api.current);
    return () => assignRef(forwardedRef, null);
  }, [forwardedRef]);

  useEffect(() => {
    if (options) api.current?.applyOptions(options);
  }, [options]);

  return <div ref={host} className={className} style={{ width: '100%', height: 400, ...style }} />;
});
/** @deprecated Use FiltrixChart. Retained for pre-beta integrations. */
export const FiltixChart = FiltrixChart;
/** @deprecated Use FiltrixChartProps. Retained for pre-beta integrations. */
export type FiltixChartProps = FiltrixChartProps;
export type { ChartApi, ChartOptions } from '@filtrix.net/charts';
