import type { ChartApi } from '@filtrix.net/charts';
import type { TerminalLayout, TerminalPaneId, TerminalStudy } from './types';

interface Handlers {
  apply(patch: { maximizedPaneId: TerminalPaneId | null }): void;
  reset(): void;
  close(): void;
}

function controlButton(doc: Document, label: string, dataName: string): HTMLButtonElement {
  const item = doc.createElement('button');
  item.type = 'button';
  item.textContent = label;
  item.setAttribute(dataName, '');
  return item;
}

function paneLabel(id: TerminalPaneId, studies: readonly TerminalStudy[]): string {
  if (id === 'price') return 'Price';
  if (id === 'terminal-volume-pane') return 'Volume';
  const study = studies.find((item) => 'terminal-' + item.id + '-pane' === id);
  return study ? study.kind.toUpperCase() + ' ' + study.id : id;
}

function reconcileOptions(
  doc: Document,
  select: HTMLSelectElement,
  entries: readonly { value: string; label: string }[],
): void {
  const previous = [...select.options];
  const byValue = new Map<string, HTMLOptionElement>();
  for (const option of previous) if (!byValue.has(option.value)) byValue.set(option.value, option);
  const retained = new Set<HTMLOptionElement>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const option = byValue.get(entry.value) ?? doc.createElement('option');
    if (!option.hasAttribute('value') || option.value !== entry.value) option.value = entry.value;
    if (option.textContent !== entry.label) option.textContent = entry.label;
    if (select.options.item(index) !== option) select.insertBefore(option, select.options.item(index));
    retained.add(option);
  }
  for (const option of previous) if (!retained.has(option)) option.remove();
}

export interface TerminalLayoutControls {
  readonly root: HTMLDivElement;
  render(
    layout: TerminalLayout,
    studies: readonly TerminalStudy[],
    visible: ReadonlySet<TerminalPaneId>,
    editingFocus: boolean,
  ): void;
  refreshAvailability(): void;
  destroy(): void;
}

export function createTerminalLayoutControls(
  doc: Document,
  chart: ChartApi,
  handlers: Handlers,
): TerminalLayoutControls {
  const cleanups: Array<() => void> = [];
  const root = doc.createElement('div');
  root.dataset.terminalLayoutControls = '';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Pane layout');
  const target = doc.createElement('select');
  target.dataset.terminalPaneSelect = '';
  target.setAttribute('aria-label', 'Resize pane');
  const view = doc.createElement('select');
  view.dataset.terminalLayoutView = '';
  view.setAttribute('aria-label', 'View');
  const resizeLabel = doc.createElement('label');
  const resizeCaption = doc.createElement('span');
  resizeCaption.textContent = 'Resize pane';
  resizeCaption.dataset.terminalCompactLabel = '';
  resizeLabel.append(resizeCaption, target);
  const viewLabel = doc.createElement('label');
  const viewCaption = doc.createElement('span');
  viewCaption.textContent = 'View';
  viewCaption.dataset.terminalCompactLabel = '';
  viewLabel.append(viewCaption, view);
  const grow = controlButton(doc, 'Grow', 'data-terminal-pane-grow');
  const shrink = controlButton(doc, 'Shrink', 'data-terminal-pane-shrink');
  const maximize = controlButton(doc, 'Maximize', 'data-terminal-pane-maximize');
  const restore = controlButton(doc, 'Restore panes', 'data-terminal-pane-restore');
  const reset = controlButton(doc, 'Reset layout', 'data-terminal-layout-reset');
  const status = doc.createElement('span');
  status.dataset.terminalLayoutStatus = '';
  status.setAttribute('role', 'status');
  root.append(resizeLabel, viewLabel, grow, shrink, maximize, restore, reset, status);
  let latestRender: {
    layout: TerminalLayout;
    visible: ReadonlySet<TerminalPaneId>;
    editingFocus: boolean;
  } | null = null;
  function refreshActionAvailability(): void {
    if (!latestRender) return;
    const { layout, visible, editingFocus } = latestRender;
    const ids = layout.panes.map((pane) => pane.id).filter((id) => visible.has(id));
    const terminalTarget = ids.includes(target.value as TerminalPaneId);
    const actualTarget = chart.getPaneLayout().panes.some((pane) => pane.id === target.value);
    const canQuery = terminalTarget && actualTarget && !editingFocus;
    const growDisabled = !canQuery || !chart.canResizePane(target.value, 8);
    if (grow.disabled !== growDisabled) grow.disabled = growDisabled;
    const shrinkDisabled = !canQuery || !chart.canResizePane(target.value, -8);
    if (shrink.disabled !== shrinkDisabled) shrink.disabled = shrinkDisabled;
    if (maximize.disabled !== !terminalTarget) maximize.disabled = !terminalTarget;
  }
  const listen = (node: EventTarget, event: string, callback: EventListener) => {
    node.addEventListener(event, callback);
    cleanups.push(() => node.removeEventListener(event, callback));
  };
  listen(target, 'change', () => refreshActionAvailability());
  listen(grow, 'click', () => chart.resizePane(target.value, 8));
  listen(shrink, 'click', () => chart.resizePane(target.value, -8));
  listen(maximize, 'click', () => handlers.apply({ maximizedPaneId: target.value as TerminalPaneId }));
  listen(restore, 'click', () => {
    if (restore.dataset.terminalDerivedRestore === 'true') handlers.close();
    else handlers.apply({ maximizedPaneId: null });
  });
  listen(reset, 'click', () => handlers.reset());
  listen(view, 'change', () =>
    handlers.apply({ maximizedPaneId: view.value ? (view.value as TerminalPaneId) : null }),
  );
  return {
    root,
    render(layout, studies, visible, editingFocus) {
      const ids = layout.panes.map((pane) => pane.id).filter((id) => visible.has(id));
      const currentTarget = ids.includes(target.value as TerminalPaneId) ? target.value : 'price';
      const currentView = layout.maximizedPaneId ?? '';
      reconcileOptions(
        doc,
        target,
        ids.map((id) => ({ value: id, label: paneLabel(id, studies) })),
      );
      if (target.value !== currentTarget) target.value = currentTarget;
      reconcileOptions(doc, view, [
        {
          value: '',
          label: editingFocus ? 'Price focus while editing (all panes saved)' : 'All panes',
        },
        ...ids.map((id) => ({ value: id, label: paneLabel(id, studies) })),
      ]);
      if (view.value !== currentView) view.value = currentView;
      latestRender = { layout, visible, editingFocus };
      refreshActionAvailability();
      const restoreDisabled = layout.maximizedPaneId === null && !editingFocus;
      if (restore.disabled !== restoreDisabled) restore.disabled = restoreDisabled;
      const restoreCaption =
        editingFocus && layout.maximizedPaneId === null ? 'Close editor and restore panes' : 'Restore panes';
      if (restore.textContent !== restoreCaption) restore.textContent = restoreCaption;
      const derived = String(editingFocus && layout.maximizedPaneId === null);
      if (restore.dataset.terminalDerivedRestore !== derived)
        restore.dataset.terminalDerivedRestore = derived;
      const caption = editingFocus ? 'Price focused while editing' : '';
      if (status.textContent !== caption) status.textContent = caption;
    },
    refreshAvailability() {
      refreshActionAvailability();
    },
    destroy() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
