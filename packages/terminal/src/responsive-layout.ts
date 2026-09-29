import { measurePaneLayout, type ChartPaneLayout } from '@filtix/charts';
import type { TerminalLayout, TerminalPaneId } from './types';

export type TerminalEditorMode = 'rail' | 'bottom' | 'overlay';

export interface TerminalPresentation {
  mode: TerminalEditorMode;
  editorHeight: number;
  effectiveMaximizedPaneId: TerminalPaneId | null;
  editingFocus: boolean;
}

export function presentationFor(
  width: number,
  bodyHeight: number,
  chartLayout: ChartPaneLayout,
  canonical: TerminalLayout,
): TerminalPresentation {
  const height = Math.max(0, Number.isFinite(bodyHeight) ? bodyHeight : 0);
  const mode: TerminalEditorMode = width >= 900 ? 'rail' : height >= 320 ? 'bottom' : 'overlay';
  const editorHeight =
    !canonical.studiesOpen || mode === 'rail'
      ? 0
      : mode === 'bottom'
        ? Math.max(0, Math.min(height * 0.4, height - 192))
        : height * 0.45;
  const chartHeight = mode === 'bottom' ? height - editorHeight : height;
  if (!canonical.studiesOpen || canonical.maximizedPaneId !== null)
    return { mode, editorHeight, effectiveMaximizedPaneId: canonical.maximizedPaneId, editingFocus: false };
  const preferences = new Map(canonical.panes.map((pane) => [pane.id, pane]));
  const prospective: ChartPaneLayout = {
    panes: chartLayout.panes.map((pane) => {
      const saved = preferences.get(pane.id as TerminalPaneId);
      return saved ? { ...pane, weight: saved.weight, minHeight: saved.minHeight } : pane;
    }),
    maximizedPaneId: null,
  };
  const price = measurePaneLayout(prospective, chartHeight).panes.find((pane) => pane.id === 'price');
  const visibleHeight = price
    ? Math.max(
        0,
        Math.min(price.height, mode === 'overlay' ? chartHeight - editorHeight - price.top : price.height),
      )
    : 0;
  const editingFocus = visibleHeight < 96;
  return { mode, editorHeight, effectiveMaximizedPaneId: editingFocus ? 'price' : null, editingFocus };
}
