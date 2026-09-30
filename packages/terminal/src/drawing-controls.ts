import type {
  Drawing,
  DrawingLayer,
  DrawingPatch,
  DrawingStore,
  FibonacciLevel,
} from '@filtrix.net/drawings';

interface DrawingControlSources {
  store(): DrawingStore | null;
  layer(): DrawingLayer | null;
}

interface LevelDraft {
  key: number;
  ratio: string;
  color: string;
  lineWidth: string;
  lineStyle: string;
}

interface Draft {
  id: string;
  type: Drawing['type'];
  color: string;
  lineWidth: string;
  fillOpacity: string;
  locked: boolean;
  visible: boolean;
  text: string;
  fontSize: string;
  levels: LevelDraft[];
}

export interface TerminalDrawingControls {
  readonly toggle: HTMLButtonElement;
  readonly panel: HTMLElement;
  refresh(): void;
  destroy(): void;
}

const COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const LEVEL_STYLES = ['', 'solid', 'dashed', 'dotted'] as const;

function option(doc: Document, value: string, label: string): HTMLOptionElement {
  const result = doc.createElement('option');
  result.value = value;
  result.textContent = label;
  return result;
}

function label(doc: Document, caption: string, control: HTMLElement): HTMLLabelElement {
  const element = doc.createElement('label');
  const title = doc.createElement('span');
  title.textContent = caption;
  element.append(title, control);
  return element;
}

function input(doc: Document, name: string, aria: string): HTMLInputElement {
  const element = doc.createElement('input');
  element.type = 'text';
  element.dataset[name] = '';
  element.setAttribute('aria-label', aria);
  return element;
}

function button(doc: Document, text: string, name: string): HTMLButtonElement {
  const element = doc.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.dataset[name] = '';
  return element;
}

function numeric(text: string, name: string, min: number, max: number): number {
  if (text.trim() === '') throw new Error(name + ' is required');
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(name + ' must be between ' + min + ' and ' + max);
  return value;
}

function draftFor(drawing: Drawing, nextKey: () => number): Draft {
  return {
    id: drawing.id,
    type: drawing.type,
    color: drawing.style.color,
    lineWidth: String(drawing.style.lineWidth),
    fillOpacity: String(drawing.style.fillOpacity),
    locked: drawing.locked,
    visible: drawing.visible,
    text: drawing.type === 'text-note' ? drawing.text : '',
    fontSize: drawing.type === 'text-note' ? String(drawing.fontSize) : '',
    levels:
      drawing.type === 'fibonacci-retracement'
        ? drawing.levels.map((level) => ({
            key: nextKey(),
            ratio: String(level.ratio),
            color: level.color ?? '',
            lineWidth: level.lineWidth === undefined ? '' : String(level.lineWidth),
            lineStyle: level.lineStyle ?? '',
          }))
        : [],
  };
}

function patchFor(draft: Draft): DrawingPatch {
  if (!COLOR.test(draft.color)) throw new Error('Color must be #RRGGBB or #RRGGBBAA');
  const style = {
    color: draft.color,
    lineWidth: numeric(draft.lineWidth, 'Width', 0.5, 8),
    fillOpacity: numeric(draft.fillOpacity, 'Fill opacity', 0, 1),
  };
  const patch: DrawingPatch = { style, locked: draft.locked, visible: draft.visible };
  if (draft.type === 'text-note') {
    const normalized = draft.text.replace(/\r\n/g, '\n');
    if (!normalized.trim() || normalized.length > 2000 || normalized.split('\n').length > 20)
      throw new Error('Note text needs content, at most 2000 characters and 20 lines');
    patch.text = normalized;
    patch.fontSize = numeric(draft.fontSize, 'Font size', 8, 48);
  }
  if (draft.type === 'fibonacci-retracement') {
    if (draft.levels.length < 1 || draft.levels.length > 32)
      throw new Error('Fibonacci levels need 1–32 rows');
    const seen = new Set<number>();
    const levels: FibonacciLevel[] = [];
    for (const row of draft.levels) {
      const ratio = numeric(row.ratio, 'Level ratio', -10, 10);
      if (seen.has(ratio)) throw new Error('Fibonacci ratios must be unique');
      seen.add(ratio);
      const level: FibonacciLevel = { ratio };
      if (row.color.trim()) {
        if (!COLOR.test(row.color)) throw new Error('Level color must be #RRGGBB or #RRGGBBAA');
        level.color = row.color;
      }
      if (row.lineWidth.trim()) level.lineWidth = numeric(row.lineWidth, 'Level width', 0.5, 8);
      if (row.lineStyle) {
        if (row.lineStyle !== 'solid' && row.lineStyle !== 'dashed' && row.lineStyle !== 'dotted')
          throw new Error('Level line style is invalid');
        level.lineStyle = row.lineStyle;
      }
      levels.push(level);
    }
    patch.levels = levels;
  }
  return patch;
}

export function createDrawingControls(
  doc: Document,
  container: HTMLElement,
  sources: DrawingControlSources,
): TerminalDrawingControls {
  const cleanups: Array<() => void> = [];
  const listen = (target: EventTarget, name: string, listener: EventListener): void => {
    target.addEventListener(name, listener);
    cleanups.push(() => target.removeEventListener(name, listener));
  };
  let dead = false;
  let key = 0;
  let currentStore: DrawingStore | null = null;
  let currentLayer: DrawingLayer | null = null;
  let unsubscribe: (() => void) | null = null;
  let selectedId: string | null = null;
  let selectedFingerprint: string | null = null;
  let listFingerprint = '';
  let draft: Draft | null = null;
  const levelRows = new Map<number, HTMLDivElement>();

  const toggle = button(doc, 'Objects', 'terminalDrawingsToggle');
  toggle.setAttribute('aria-expanded', 'false');
  const panel = doc.createElement('section');
  panel.dataset.terminalDrawingsPanel = '';
  panel.setAttribute('aria-label', 'Drawing objects');
  panel.hidden = true;
  panel.id = 'terminal-drawings-' + Math.random().toString(36).slice(2);
  toggle.setAttribute('aria-controls', panel.id);
  const header = doc.createElement('div');
  header.dataset.terminalDrawingsHead = '';
  const title = doc.createElement('strong');
  title.textContent = 'Objects';
  const close = button(doc, 'Close', 'terminalDrawingsClose');
  header.append(title, close);
  const object = doc.createElement('select');
  object.dataset.terminalDrawingObject = '';
  object.setAttribute('aria-label', 'Drawing object');
  object.append(option(doc, '', 'Select an object'));
  const objectLabel = label(doc, 'Drawing', object);
  const fields = doc.createElement('div');
  fields.dataset.terminalDrawingFields = '';
  const empty = doc.createElement('p');
  empty.dataset.terminalDrawingEmpty = '';
  empty.textContent = 'Select an object to edit its appearance.';
  const common = doc.createElement('div');
  common.dataset.terminalDrawingCommon = '';
  const color = input(doc, 'terminalDrawingColor', 'Drawing color');
  const width = input(doc, 'terminalDrawingWidth', 'Drawing line width');
  width.inputMode = 'decimal';
  const fill = input(doc, 'terminalDrawingFill', 'Drawing fill opacity');
  fill.inputMode = 'decimal';
  const fillLabel = label(doc, 'Fill opacity', fill);
  const locked = doc.createElement('input');
  locked.type = 'checkbox';
  locked.dataset.terminalDrawingLocked = '';
  locked.setAttribute('aria-label', 'Lock geometry');
  const visible = doc.createElement('input');
  visible.type = 'checkbox';
  visible.dataset.terminalDrawingVisible = '';
  visible.setAttribute('aria-label', 'Show drawing');
  common.append(
    label(doc, 'Color', color),
    label(doc, 'Width', width),
    fillLabel,
    label(doc, 'Lock geometry', locked),
    label(doc, 'Show drawing', visible),
  );
  const note = doc.createElement('div');
  note.dataset.terminalDrawingNote = '';
  const noteText = doc.createElement('textarea');
  noteText.dataset.terminalDrawingText = '';
  noteText.setAttribute('aria-label', 'Note text');
  const fontSize = input(doc, 'terminalDrawingFontSize', 'Note font size');
  fontSize.inputMode = 'decimal';
  note.append(label(doc, 'Text', noteText), label(doc, 'Font size', fontSize));
  const fibonacci = doc.createElement('div');
  fibonacci.dataset.terminalDrawingFibonacci = '';
  const fibHeading = doc.createElement('strong');
  fibHeading.textContent = 'Retracement levels';
  const levelList = doc.createElement('div');
  levelList.dataset.terminalLevelList = '';
  const addLevel = button(doc, 'Add level', 'terminalLevelAdd');
  fibonacci.append(fibHeading, levelList, addLevel);
  const error = doc.createElement('div');
  error.dataset.terminalDrawingError = '';
  error.setAttribute('role', 'alert');
  const actions = doc.createElement('div');
  actions.dataset.terminalDrawingActions = '';
  const apply = button(doc, 'Apply changes', 'terminalDrawingApply');
  const remove = button(doc, 'Delete object', 'terminalDrawingDelete');
  actions.append(apply, remove);
  fields.append(common, note, fibonacci, error, actions);
  panel.append(header, objectLabel, empty, fields);
  container.append(panel);

  function show(open: boolean): void {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  function renderLevels(): void {
    const active = draft;
    const wanted = new Set(active?.levels.map((level) => level.key) ?? []);
    for (const [rowKey, row] of levelRows) {
      if (wanted.has(rowKey)) continue;
      row.remove();
      levelRows.delete(rowKey);
    }
    if (!active) return;
    for (const [index, level] of active.levels.entries()) {
      const existing = levelRows.get(level.key);
      if (existing) {
        if (levelList.children[index] !== existing)
          levelList.insertBefore(existing, levelList.children[index] ?? null);
        continue;
      }
      const row = doc.createElement('div');
      row.dataset.terminalFibonacciLevel = '';
      row.dataset.levelKey = String(level.key);
      const ratio = input(doc, 'terminalLevelRatio', 'Level ratio');
      ratio.inputMode = 'decimal';
      ratio.value = level.ratio;
      const colorOverride = input(doc, 'terminalLevelColor', 'Level color override; blank inherits');
      colorOverride.value = level.color;
      const levelWidth = input(doc, 'terminalLevelWidth', 'Level width override; blank inherits');
      levelWidth.inputMode = 'decimal';
      levelWidth.value = level.lineWidth;
      const lineStyle = doc.createElement('select');
      lineStyle.dataset.terminalLevelStyle = '';
      lineStyle.setAttribute('aria-label', 'Level line style override');
      lineStyle.append(...LEVEL_STYLES.map((value) => option(doc, value, value || 'Inherit')));
      lineStyle.value = level.lineStyle;
      const drop = button(doc, 'Remove', 'terminalLevelRemove');
      drop.setAttribute('aria-label', 'Remove level ' + level.ratio);
      row.append(
        label(doc, 'Ratio', ratio),
        label(doc, 'Color override', colorOverride),
        label(doc, 'Width override', levelWidth),
        label(doc, 'Line style', lineStyle),
        drop,
      );
      levelRows.set(level.key, row);
      levelList.insertBefore(row, levelList.children[index] ?? null);
    }
  }

  function renderDraft(): void {
    const active = draft;
    fields.hidden = !active;
    empty.hidden = Boolean(active);
    if (!active) return;
    color.value = active.color;
    width.value = active.lineWidth;
    fill.value = active.fillOpacity;
    locked.checked = active.locked;
    visible.checked = active.visible;
    fillLabel.hidden = !['rectangle', 'measure', 'parallel-channel', 'text-note'].includes(active.type);
    note.hidden = active.type !== 'text-note';
    fibonacci.hidden = active.type !== 'fibonacci-retracement';
    noteText.value = active.text;
    fontSize.value = active.fontSize;
    renderLevels();
  }

  function refresh(): void {
    if (dead) return;
    const store = sources.store();
    const layer = sources.layer();
    const replaced = store !== currentStore || layer !== currentLayer;
    if (replaced) {
      unsubscribe?.();
      unsubscribe = null;
      currentStore = store;
      currentLayer = layer;
      selectedId = null;
      selectedFingerprint = null;
      listFingerprint = '';
      draft = null;
      error.textContent = '';
      if (store && layer) unsubscribe = store.subscribe(refresh);
    }
    const drawings = store && layer ? store.list() : [];
    const nextList = JSON.stringify(
      drawings.map((drawing) => [
        drawing.id,
        drawing.type,
        drawing.visible,
        drawing.locked,
        drawing.type === 'text-note' ? drawing.text : '',
      ]),
    );
    if (nextList !== listFingerprint) {
      listFingerprint = nextList;
      object.replaceChildren(
        option(doc, '', 'Select an object'),
        ...drawings.map((drawing) =>
          option(
            doc,
            drawing.id,
            (drawing.type === 'text-note' ? drawing.text.split('\n')[0]!.slice(0, 24) : drawing.type) +
              (drawing.visible ? '' : ' · hidden') +
              (drawing.locked ? ' · locked' : '') +
              ' · ' +
              drawing.id,
          ),
        ),
      );
    }
    const id = layer?.getState().selectedId ?? null;
    const drawing = id ? (drawings.find((candidate) => candidate.id === id) ?? null) : null;
    const fingerprint = drawing ? JSON.stringify(drawing) : null;
    if (replaced || id !== selectedId || fingerprint !== selectedFingerprint) {
      selectedId = id;
      selectedFingerprint = fingerprint;
      draft = drawing ? draftFor(drawing, () => ++key) : null;
      error.textContent = '';
      renderDraft();
    }
    if (object.value !== (id ?? '')) object.value = id ?? '';
  }

  listen(toggle, 'click', () => {
    show(panel.hidden);
    refresh();
  });
  listen(close, 'click', () => show(false));
  listen(object, 'change', () => {
    const layer = sources.layer();
    if (layer) layer.select(object.value || null);
    refresh();
  });
  listen(panel, 'input', (event) => {
    if (!draft) return;
    const target = event.target as HTMLElement;
    if (target === color) draft.color = color.value;
    else if (target === width) draft.lineWidth = width.value;
    else if (target === fill) draft.fillOpacity = fill.value;
    else if (target === locked) draft.locked = locked.checked;
    else if (target === visible) draft.visible = visible.checked;
    else if (target === noteText) draft.text = noteText.value;
    else if (target === fontSize) draft.fontSize = fontSize.value;
    else {
      const row = target.closest<HTMLElement>('[data-terminal-fibonacci-level]');
      const level = draft.levels.find((candidate) => candidate.key === Number(row?.dataset.levelKey));
      if (level) {
        if (target.hasAttribute('data-terminal-level-ratio'))
          level.ratio = (target as HTMLInputElement).value;
        if (target.hasAttribute('data-terminal-level-color'))
          level.color = (target as HTMLInputElement).value;
        if (target.hasAttribute('data-terminal-level-width'))
          level.lineWidth = (target as HTMLInputElement).value;
        if (target.hasAttribute('data-terminal-level-style'))
          level.lineStyle = (target as HTMLSelectElement).value;
      }
    }
    error.textContent = '';
  });
  listen(panel, 'change', (event) => {
    if (event.target instanceof doc.defaultView!.HTMLSelectElement) {
      const target = event.target as HTMLSelectElement;
      if (target.hasAttribute('data-terminal-level-style')) {
        const row = target.closest<HTMLElement>('[data-terminal-fibonacci-level]');
        const level = draft?.levels.find((candidate) => candidate.key === Number(row?.dataset.levelKey));
        if (level) level.lineStyle = target.value;
      }
    }
  });
  listen(addLevel, 'click', () => {
    if (!draft || draft.levels.length >= 32) {
      error.textContent = 'Fibonacci levels allow at most 32 rows';
      return;
    }
    const used = new Set(draft.levels.map((level) => Number(level.ratio)));
    const ratio = [1.272, 1.618, 2, -0.236, -0.618, 3].find((candidate) => !used.has(candidate));
    draft.levels.push({
      key: ++key,
      ratio: ratio === undefined ? '' : String(ratio),
      color: '',
      lineWidth: '',
      lineStyle: '',
    });
    renderLevels();
    error.textContent = '';
  });
  listen(levelList, 'click', (event) => {
    const target = event.target as HTMLElement;
    if (!target.hasAttribute('data-terminal-level-remove') || !draft) return;
    const row = target.closest<HTMLElement>('[data-terminal-fibonacci-level]');
    draft.levels = draft.levels.filter((level) => level.key !== Number(row?.dataset.levelKey));
    renderLevels();
    error.textContent = '';
  });
  listen(apply, 'click', () => {
    if (!draft || !currentStore) return;
    try {
      const patch = patchFor(draft);
      currentStore.update(draft.id, patch);
      error.textContent = '';
      refresh();
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
    }
  });
  listen(remove, 'click', () => {
    if (!draft || !currentStore) return;
    try {
      currentStore.remove(draft.id);
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
    }
  });
  refresh();
  return {
    toggle,
    panel,
    refresh,
    destroy() {
      if (dead) return;
      dead = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const cleanup of cleanups.splice(0)) cleanup();
      panel.remove();
      toggle.remove();
    },
  };
}
