import { logicalX, xLogical } from './layout';
import type { LogicalRange, Scene } from './types';
interface Actions {
  range(value: LogicalRange): void;
  fit(): void;
  latest(): void;
  pointer(
    value: {
      x: number;
      y: number;
    } | null,
  ): void;
  layout(): void;
}
export function attachInteraction(
  root: HTMLElement,
  scene: Scene,
  actions: Actions,
): (() => void) & { clearCursor(): void } {
  const win = root.ownerDocument.defaultView!;
  const pointers = new Map<
    number,
    {
      x: number;
      y: number;
    }
  >();
  const removers: Array<() => void> = [];
  let disposed = false;
  let drag: {
    x: number;
    range: LogicalRange;
  } | null = null;
  let pinch: {
    distance: number;
    anchor: number;
    ratio: number;
    span: number;
  } | null = null;
  let cursor: {
    x: number;
    y: number;
  } | null = null;
  function on<K extends keyof HTMLElementEventMap>(
    name: K,
    callback: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) {
    root.addEventListener(name, callback, options);
    removers.push(() => root.removeEventListener(name, callback, options));
  }
  function point(event: PointerEvent | WheelEvent) {
    const rect = root.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function cancel() {
    for (const id of pointers.keys())
      try {
        if (root.hasPointerCapture(id)) root.releasePointerCapture(id);
      } catch {}
    pointers.clear();
    drag = null;
    pinch = null;
    root.style.cursor = 'crosshair';
  }
  function startPinch() {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const mid = (a.x + b.x) / 2;
    pinch = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      anchor: xLogical(scene, mid),
      ratio: (mid - 8) / Math.max(1, scene.plotWidth - 16),
      span: scene.range.to - scene.range.from,
    };
    drag = null;
  }
  function zoom(factor: number, x: number) {
    actions.layout();
    const span = Math.max(
      1,
      Math.min(Math.max(1, scene.timeline.length - 1), (scene.range.to - scene.range.from) * factor),
    );
    const ratio = Math.max(0, Math.min(1, (x - 8) / Math.max(1, scene.plotWidth - 16)));
    const anchor = scene.range.from + ratio * (scene.range.to - scene.range.from);
    actions.range({ from: anchor - span * ratio, to: anchor + span * (1 - ratio) });
  }
  root.style.cursor = 'crosshair';
  on('pointerdown', (event) => {
    if (event.button !== 0 || disposed) return;
    actions.layout();
    const p = point(event);
    if (p.x < 0 || p.x > scene.plotWidth || p.y < 0 || p.y > scene.plotHeight) return;
    event.preventDefault();
    root.focus({ preventScroll: true });
    pointers.set(event.pointerId, p);
    try {
      root.setPointerCapture(event.pointerId);
    } catch {}
    if (pointers.size >= 2) {
      startPinch();
      return;
    }
    drag = { x: p.x, range: { ...scene.range } };
    root.style.cursor = 'grabbing';
  });
  on('pointermove', (event) => {
    if (disposed) return;
    actions.layout();
    const p = point(event);
    cursor = p;
    actions.pointer(p);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const span = Math.max(
        1,
        Math.min(Math.max(1, scene.timeline.length - 1), (pinch.span * pinch.distance) / distance),
      );
      const ratio = ((a.x + b.x) / 2 - 8) / Math.max(1, scene.plotWidth - 16);
      actions.range({ from: pinch.anchor - span * ratio, to: pinch.anchor + span * (1 - ratio) });
      return;
    }
    if (drag) {
      const delta = ((p.x - drag.x) / Math.max(1, scene.plotWidth - 16)) * (drag.range.to - drag.range.from);
      actions.range({ from: drag.range.from - delta, to: drag.range.to - delta });
    } else root.style.cursor = 'crosshair';
  });
  function end(event: PointerEvent) {
    pointers.delete(event.pointerId);
    try {
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    } catch {}
    pinch = null;
    const remaining = [...pointers.values()][0];
    drag = remaining ? { x: remaining.x, range: { ...scene.range } } : null;
    root.style.cursor = 'crosshair';
  }
  on('pointerup', end);
  on('pointercancel', () => {
    cancel();
    cursor = null;
    actions.pointer(null);
  });
  on('lostpointercapture', (event) => {
    if (pointers.has(event.pointerId)) end(event);
  });
  on('pointerleave', () => {
    if (!pointers.size) {
      cursor = null;
      actions.pointer(null);
    }
  });
  on(
    'wheel',
    (event) => {
      const p = point(event);
      if (p.x < 0 || p.x > scene.plotWidth || p.y < 0 || p.y > scene.plotHeight) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scene.height : 1;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey) {
        const delta =
          ((event.deltaX * unit) / Math.max(1, scene.plotWidth)) * (scene.range.to - scene.range.from);
        actions.range({ from: scene.range.from + delta, to: scene.range.to + delta });
      } else zoom(Math.exp(Math.max(-2, Math.min(2, event.deltaY * unit * 0.0015))), p.x);
    },
    { passive: false },
  );
  on('keydown', (event) => {
    if (root.ownerDocument.activeElement !== root) return;
    const span = scene.range.to - scene.range.from;
    switch (event.key) {
      case 'Home':
        actions.fit();
        break;
      case 'End':
        actions.latest();
        break;
      case '+':
      case '=':
        zoom(0.8, cursor?.x ?? scene.plotWidth / 2);
        break;
      case '-':
      case '_':
        zoom(1.25, cursor?.x ?? scene.plotWidth / 2);
        break;
      case 'Escape':
        cancel();
        cursor = null;
        actions.pointer(null);
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        if (cursor) {
          const index = Math.max(
            0,
            Math.min(scene.timeline.length - 1, Math.round(xLogical(scene, cursor.x)) + direction),
          );
          cursor = { x: logicalX(scene, index), y: cursor.y };
          actions.pointer(cursor);
        } else {
          const delta = Math.max(1, span * 0.1) * direction;
          actions.range({ from: scene.range.from + delta, to: scene.range.to + delta });
        }
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown':
        if (cursor) {
          cursor = {
            x: cursor.x,
            y: Math.max(0, Math.min(scene.plotHeight, cursor.y + (event.key === 'ArrowUp' ? -8 : 8))),
          };
          actions.pointer(cursor);
        } else zoom(event.key === 'ArrowUp' ? 0.8 : 1.25, scene.plotWidth / 2);
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  const blur = () => {
    cancel();
    cursor = null;
    actions.pointer(null);
  };
  win.addEventListener('blur', blur);
  root.addEventListener('blur', blur);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    cancel();
    for (const remove of removers) remove();
    removers.length = 0;
    win.removeEventListener('blur', blur);
    root.removeEventListener('blur', blur);
    cursor = null;
  };
  return Object.assign(cleanup, {
    clearCursor() {
      cursor = null;
    },
  });
}
