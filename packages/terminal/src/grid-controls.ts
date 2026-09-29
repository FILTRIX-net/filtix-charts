import type { TerminalGridApi, TerminalGridLayout, TerminalGridState } from './grid-types';

type GridActions = Pick<TerminalGridApi, 'setLayout' | 'setActiveCell' | 'setSync'> & {
  getState(): Pick<TerminalGridState, 'layout' | 'activeCellId' | 'sync'>;
};

export interface GridControls {
  refresh(): void;
  destroy(): void;
}

export function createGridControls(host: HTMLElement, actions: GridActions): GridControls {
  const doc = host.ownerDocument;
  const removers: Array<() => void> = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    node: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ) => {
    node.addEventListener(type, listener as EventListener);
    removers.push(() => node.removeEventListener(type, listener as EventListener));
  };
  const group = (name: string) => {
    const element = doc.createElement('div');
    element.className = 'filtix-terminal-grid-control-group';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', name);
    return element;
  };
  let dead = false;
  try {
    host.classList.add('filtix-terminal-grid-toolbar');
    host.setAttribute('role', 'toolbar');
    host.setAttribute('aria-label', 'Grid workspace controls');

    const layoutGroup = group('Layout');
    const caption = doc.createElement('span');
    caption.className = 'filtix-terminal-grid-caption';
    caption.textContent = 'LAYOUT';
    layoutGroup.append(caption);
    const buttons = new Map<TerminalGridLayout, HTMLButtonElement>();
    for (const layout of [1, 2, 4] as const) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.gridLayout = String(layout);
      button.textContent = String(layout);
      button.setAttribute('aria-label', `${layout} ${layout === 1 ? 'chart' : 'charts'}`);
      buttons.set(layout, button);
      layoutGroup.append(button);
      listen(button, 'click', () => {
        void actions.setLayout(layout).then(
          () => refresh(),
          () => refresh(),
        );
      });
    }

    const active = doc.createElement('span');
    active.className = 'filtix-terminal-grid-active';
    active.dataset.gridActiveCell = '';
    active.setAttribute('aria-live', 'polite');

    const syncGroup = group('Synchronization');
    const syncCaption = doc.createElement('span');
    syncCaption.className = 'filtix-terminal-grid-caption';
    syncCaption.textContent = 'SYNC';
    syncGroup.append(syncCaption);
    const check = (labelText: string, key: 'viewport' | 'crosshair') => {
      const label = doc.createElement('label');
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.dataset[key === 'viewport' ? 'gridViewport' : 'gridCrosshair'] = '';
      const text = doc.createElement('span');
      text.textContent = labelText;
      label.append(input, text);
      syncGroup.append(label);
      listen(input, 'change', () => {
        try {
          actions.setSync({ [key]: input.checked });
        } finally {
          refresh();
        }
      });
      return input;
    };
    const viewport = check('Viewport', 'viewport');
    const crosshair = check('Crosshair', 'crosshair');

    const matchLabel = doc.createElement('label');
    const matchText = doc.createElement('span');
    matchText.textContent = 'Match';
    const match = doc.createElement('select');
    match.dataset.gridCrosshairMatch = '';
    match.setAttribute('aria-label', 'Crosshair match');
    for (const value of ['exact', 'nearest'] as const) {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = value === 'exact' ? 'Exact' : 'Nearest';
      match.append(option);
    }
    matchLabel.append(matchText, match);
    syncGroup.append(matchLabel);
    listen(match, 'change', () => {
      try {
        actions.setSync({ crosshairMatch: match.value as 'exact' | 'nearest' });
      } finally {
        refresh();
      }
    });
    host.append(layoutGroup, active, syncGroup);

    function refresh(): void {
      if (dead) return;
      const state = actions.getState();
      for (const [layout, button] of buttons) {
        const pressed = String(state.layout === layout);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
      }
      const caption = `ACTIVE ${state.activeCellId.slice(-1)}`;
      if (active.textContent !== caption) active.textContent = caption;
      if (active.dataset.gridActiveCell !== state.activeCellId)
        active.dataset.gridActiveCell = state.activeCellId;
      if (viewport.checked !== state.sync.viewport) viewport.checked = state.sync.viewport;
      if (crosshair.checked !== state.sync.crosshair) crosshair.checked = state.sync.crosshair;
      if (match.value !== state.sync.crosshairMatch) match.value = state.sync.crosshairMatch;
    }

    return {
      refresh,
      destroy() {
        if (dead) return;
        dead = true;
        for (const remove of removers) remove();
        host.replaceChildren();
      },
    };
  } catch (failure) {
    dead = true;
    for (const remove of removers) remove();
    host.replaceChildren();
    throw failure;
  }
}
