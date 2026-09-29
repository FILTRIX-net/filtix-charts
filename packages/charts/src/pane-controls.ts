import type { ChartPaneLayout, Scene } from './types';
import { measurePaneLayout, resizePanePair, samePaneLayout } from './pane-layout';

interface Actions {
  committed(): ChartPaneLayout;
  revision(): number;
  preview(value: ChartPaneLayout | null): void;
  commit(value: ChartPaneLayout): void;
  resize(index: number, delta: number): void;
  syncSize(): void;
}
export function createPaneControls(wrapper: HTMLElement, scene: Scene, actions: Actions) {
  const doc = wrapper.ownerDocument,
    win = doc.defaultView!;
  const layer = doc.createElement('div');
  layer.dataset.filtixPaneControls = '';
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  wrapper.append(layer);
  const separators: HTMLElement[] = [];
  const separatorCleanups = new Map<HTMLElement, () => void>();
  let gesture: {
    pointerId: number;
    element: HTMLElement;
    upper: object;
    lower: object;
    index: number;
    y: number;
    revision: number;
    start: ChartPaneLayout;
    candidate: ChartPaneLayout;
  } | null = null;
  let disposed = false;
  const ignoredPointers = new Set<number>();
  function cancel() {
    const old = gesture;
    if (!old) return;
    gesture = null;
    try {
      if (old.element.hasPointerCapture(old.pointerId)) old.element.releasePointerCapture(old.pointerId);
    } catch {}
    if (!disposed) actions.preview(null);
  }
  function currentGesture() {
    const g = gesture;
    if (!g) return null;
    if (
      actions.revision() !== g.revision ||
      scene.panes[g.index] !== g.upper ||
      scene.panes[g.index + 1] !== g.lower
    ) {
      cancel();
      return null;
    }
    return g;
  }
  function create(index: number): HTMLElement {
    const element = doc.createElement('div');
    const listeners: Array<() => void> = [];
    function listen<K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ): void {
      element.addEventListener(type, handler as EventListener);
      listeners.push(() => element.removeEventListener(type, handler as EventListener));
    }
    element.dataset.filtixSeparator = String(index);
    element.setAttribute('role', 'separator');
    element.setAttribute('aria-orientation', 'horizontal');
    element.style.cssText =
      'position:absolute;left:0;height:24px;box-sizing:border-box;touch-action:none;pointer-events:auto;cursor:row-resize;outline-offset:-2px;';
    const grip = doc.createElement('span');
    grip.setAttribute('aria-hidden', 'true');
    grip.style.cssText =
      'position:absolute;left:50%;top:10px;transform:translateX(-50%);width:36px;height:4px;border-radius:3px;background:currentColor;opacity:.75;pointer-events:none;';
    element.append(grip);
    listen('focus', () => {
      element.style.outline = '2px solid #3b82f6';
    });
    listen('blur', () => {
      element.style.outline = '';
    });
    listen('pointerdown', (event) => {
      if (
        disposed ||
        ignoredPointers.has(event.pointerId) ||
        event.button !== 0 ||
        element.getAttribute('aria-disabled') === 'true'
      )
        return;
      if (gesture) {
        cancel();
        return;
      }
      const upper = scene.panes[index],
        lower = scene.panes[index + 1];
      if (!upper || !lower) return;
      event.preventDefault();
      event.stopPropagation();
      element.focus({ preventScroll: true });
      const start = actions.committed();
      gesture = {
        pointerId: event.pointerId,
        element,
        upper,
        lower,
        index,
        y: event.clientY,
        revision: actions.revision(),
        start,
        candidate: start,
      };
      try {
        element.setPointerCapture(event.pointerId);
      } catch {}
    });
    listen('pointermove', (event) => {
      const g = currentGesture();
      if (!g || event.pointerId !== g.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      g.candidate = resizePanePair(g.start, scene.height, g.index, event.clientY - g.y);
      actions.preview(g.candidate);
    });
    listen('pointerup', (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      actions.syncSize();
      const g = currentGesture();
      if (!g) return;
      event.preventDefault();
      event.stopPropagation();
      const candidate = resizePanePair(g.start, scene.height, g.index, event.clientY - g.y);
      cancel();
      if (!samePaneLayout(candidate, actions.committed())) actions.commit(candidate);
    });
    listen('pointercancel', (event) => {
      if (gesture?.pointerId === event.pointerId) cancel();
    });
    listen('lostpointercapture', (event) => {
      if (gesture?.pointerId === event.pointerId) cancel();
    });
    listen('keydown', (event) => {
      if (event.key === 'Escape') {
        cancel();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (element.getAttribute('aria-disabled') === 'true') return;
      const layout = actions.committed();
      const current = measurePaneLayout(layout, scene.height).panes[index]?.height ?? 0;
      const low =
        measurePaneLayout(resizePanePair(layout, scene.height, index, -Number.MAX_VALUE), scene.height).panes[
          index
        ]?.height ?? current;
      const high =
        measurePaneLayout(resizePanePair(layout, scene.height, index, Number.MAX_VALUE), scene.height).panes[
          index
        ]?.height ?? current;
      let delta: number;
      switch (event.key) {
        case 'ArrowDown':
          delta = event.shiftKey ? 32 : 8;
          break;
        case 'ArrowUp':
          delta = event.shiftKey ? -32 : -8;
          break;
        case 'Home':
          delta = low - current;
          break;
        case 'End':
          delta = high - current;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      actions.resize(index, delta);
    });
    layer.append(element);
    separatorCleanups.set(element, () => {
      if (gesture?.element === element) cancel();
      for (const remove of listeners) remove();
      element.remove();
    });
    return element;
  }
  function removeSeparator(element: HTMLElement): void {
    separatorCleanups.get(element)?.();
    separatorCleanups.delete(element);
  }
  function sync() {
    if (disposed) return;
    const layout = actions.committed();
    const wanted = Math.max(0, scene.panes.length - 1);
    while (separators.length > wanted) removeSeparator(separators.pop()!);
    while (separators.length < wanted) separators.push(create(separators.length));
    for (const [index, element] of separators.entries()) {
      const upper = scene.panes[index]!,
        lower = scene.panes[index + 1]!;
      const normal = layout.maximizedPaneId === null && upper.height > 0 && lower.height > 0;
      const lowerBound = normal ? resizePanePair(layout, scene.height, index, -Number.MAX_VALUE) : layout;
      const upperBound = normal ? resizePanePair(layout, scene.height, index, Number.MAX_VALUE) : layout;
      const min = measurePaneLayout(lowerBound, scene.height).panes[index]?.height ?? upper.height;
      const max = measurePaneLayout(upperBound, scene.height).panes[index]?.height ?? upper.height;
      const available =
        normal && max - min > 0.5 && upper.height >= 24 && lower.height >= 24 && scene.plotWidth > 0;
      element.setAttribute('aria-label', `Resize ${upper.id} and ${lower.id} panes`);
      element.setAttribute('aria-valuenow', String(upper.height));
      element.setAttribute('aria-valuemin', String(min));
      element.setAttribute('aria-valuemax', String(max));
      element.setAttribute('aria-disabled', String(!available));
      element.tabIndex = available ? 0 : -1;
      element.style.display = available ? 'block' : 'none';
      element.style.top = `${upper.top + upper.height - 9.5}px`;
      element.style.width = `${scene.plotWidth}px`;
      element.style.color = scene.theme.mutedText;
    }
  }
  const blur = () => cancel();
  const second = (event: PointerEvent) => {
    if (gesture && event.pointerId !== gesture.pointerId) {
      ignoredPointers.add(event.pointerId);
      cancel();
    }
  };
  const clearIgnored = (event: PointerEvent) => {
    ignoredPointers.delete(event.pointerId);
  };
  win.addEventListener('blur', blur);
  win.addEventListener('pointerdown', second, true);
  win.addEventListener('pointerup', clearIgnored, true);
  win.addEventListener('pointercancel', clearIgnored, true);
  return {
    sync,
    cancel,
    destroy() {
      if (disposed) return;
      cancel();
      disposed = true;
      win.removeEventListener('blur', blur);
      win.removeEventListener('pointerdown', second, true);
      win.removeEventListener('pointerup', clearIgnored, true);
      win.removeEventListener('pointercancel', clearIgnored, true);
      ignoredPointers.clear();
      for (const element of separators) removeSeparator(element);
      separators.length = 0;
      layer.remove();
    },
  };
}
