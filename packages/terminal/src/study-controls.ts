import { canReserveStudyKind, copyStudy, sameStudy } from './studies';
import type {
  TerminalBollingerStudyOptions,
  TerminalMacdStudyOptions,
  TerminalSingleStudyOptions,
  TerminalStudy,
  TerminalStudyKind,
  TerminalStudyOptions,
  TerminalStudyPatch,
} from './types';

interface StudyControlHandlers {
  setOpen?(open: boolean): void;
  add(options: TerminalStudyOptions): void;
  update(id: string, patch: TerminalStudyPatch): void;
  remove(id: string): void;
}

type FieldName =
  | 'period'
  | 'fastPeriod'
  | 'slowPeriod'
  | 'signalPeriod'
  | 'multiplier'
  | 'color'
  | 'signalColor'
  | 'positiveColor'
  | 'negativeColor'
  | 'upperColor'
  | 'lowerColor'
  | 'fillColor'
  | 'fillOpacity'
  | 'lineWidth'
  | 'visible';

type FieldControl = HTMLInputElement | HTMLSelectElement;

interface StudyRow {
  root: HTMLDivElement;
  controls: Map<FieldName, FieldControl>;
  cleanup: Array<() => void>;
  study: TerminalStudy;
}

const DATA_NAMES: Readonly<Record<FieldName, string>> = {
  period: 'period',
  fastPeriod: 'fast-period',
  slowPeriod: 'slow-period',
  signalPeriod: 'signal-period',
  multiplier: 'multiplier',
  color: 'color',
  signalColor: 'signal-color',
  positiveColor: 'positive-color',
  negativeColor: 'negative-color',
  upperColor: 'upper-color',
  lowerColor: 'lower-color',
  fillColor: 'fill-color',
  fillOpacity: 'fill-opacity',
  lineWidth: 'width',
  visible: 'visible',
};

function option(doc: Document, value: string, label = value): HTMLOptionElement {
  const result = doc.createElement('option');
  result.value = value;
  result.textContent = label;
  return result;
}

function labelled(doc: Document, caption: string, control: HTMLElement): HTMLLabelElement {
  const label = doc.createElement('label');
  const text = doc.createElement('span');
  text.textContent = caption;
  label.append(text, control);
  return label;
}

function numberInput(doc: Document, min: string, max: string, step = '1'): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = 'number';
  input.min = min;
  input.max = max;
  input.step = step;
  input.inputMode = step === '1' ? 'numeric' : 'decimal';
  return input;
}

function colorInput(doc: Document): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = 'color';
  return input;
}

function widthSelect(doc: Document): HTMLSelectElement {
  const select = doc.createElement('select');
  select.append(...[1, 2, 3, 4].map((value) => option(doc, String(value))));
  return select;
}

function listen(
  target: EventTarget,
  event: string,
  listener: EventListener,
  cleanups: Array<() => void>,
): void {
  target.addEventListener(event, listener);
  cleanups.push(() => target.removeEventListener(event, listener));
}

function setDataName(control: HTMLElement, prefix: 'add' | 'row', field: FieldName): void {
  control.setAttribute(
    prefix === 'add'
      ? `data-terminal-study-add-${DATA_NAMES[field]}`
      : `data-terminal-study-${DATA_NAMES[field]}`,
    '',
  );
}

function numericField(field: FieldName): boolean {
  return (
    field === 'period' ||
    field === 'fastPeriod' ||
    field === 'slowPeriod' ||
    field === 'signalPeriod' ||
    field === 'multiplier' ||
    field === 'fillOpacity' ||
    field === 'lineWidth'
  );
}

function fieldValue(study: TerminalStudy, field: FieldName): string | boolean {
  if (field === 'visible') return study.visible;
  if (field === 'color') return study.color;
  if (field === 'lineWidth') return String(study.lineWidth);
  if (field in study) return String(study[field as keyof typeof study]);
  throw new Error(`Study ${study.kind} has no ${field} field`);
}

function patchFor(field: FieldName, control: FieldControl): TerminalStudyPatch {
  if (field === 'visible') return { visible: (control as HTMLInputElement).checked };
  const value = numericField(field) ? Number(control.value) : control.value;
  return { [field]: value } as TerminalStudyPatch;
}

export interface TerminalStudyControls {
  readonly toggle: HTMLButtonElement;
  readonly panel: HTMLDivElement;
  render(studies: readonly TerminalStudy[], error?: string | null): void;
  setOpen(open: boolean): void;
  setEditingFocus(active: boolean): void;
  destroy(): void;
}

export function createStudyControls(doc: Document, handlers: StudyControlHandlers): TerminalStudyControls {
  const cleanups: Array<() => void> = [];
  const rows = new Map<string, StudyRow>();
  let renderedStudies: readonly TerminalStudy[] = [];
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Indicators';
  toggle.dataset.terminalStudiesToggle = '';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'terminal-studies-' + Math.random().toString(36).slice(2));

  const panel = doc.createElement('div');
  panel.dataset.terminalStudiesPanel = '';
  panel.id = toggle.getAttribute('aria-controls')!;
  panel.hidden = true;
  const heading = doc.createElement('div');
  heading.dataset.terminalStudiesHeading = '';
  heading.textContent = 'Indicators';
  heading.tabIndex = -1;
  const head = doc.createElement('div');
  head.dataset.terminalStudiesHead = '';
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.dataset.terminalStudiesClose = '';
  const focusStatus = doc.createElement('span');
  focusStatus.dataset.terminalStudiesFocusStatus = '';
  focusStatus.hidden = true;
  head.append(heading, focusStatus, close);
  const inlineError = doc.createElement('div');
  inlineError.dataset.terminalStudiesError = '';
  inlineError.setAttribute('role', 'alert');
  const addBar = doc.createElement('div');
  addBar.dataset.terminalStudiesAdd = '';

  const kind = doc.createElement('select');
  kind.dataset.terminalStudyAddKind = '';
  kind.setAttribute('aria-label', 'Indicator kind');
  kind.append(
    option(doc, 'sma', 'SMA'),
    option(doc, 'ema', 'EMA'),
    option(doc, 'rsi', 'RSI'),
    option(doc, 'macd', 'MACD'),
    option(doc, 'bollinger', 'Bollinger'),
  );

  const addControls = new Map<FieldName, FieldControl>();
  const addLabels = new Map<FieldName, HTMLLabelElement>();
  const addField = (field: FieldName, caption: string, control: FieldControl): void => {
    setDataName(control, 'add', field);
    const label = labelled(doc, caption, control);
    label.dataset.terminalStudyAddField = field;
    addControls.set(field, control);
    addLabels.set(field, label);
    addBar.append(label);
  };
  addField('period', 'Period', numberInput(doc, '2', '500'));
  addField('fastPeriod', 'Fast', numberInput(doc, '2', '500'));
  addField('slowPeriod', 'Slow', numberInput(doc, '2', '500'));
  addField('signalPeriod', 'Signal', numberInput(doc, '2', '500'));
  addField('multiplier', 'Multiplier', numberInput(doc, '0.01', '10', '0.1'));
  addField('color', 'Primary', colorInput(doc));
  addField('signalColor', 'Signal color', colorInput(doc));
  addField('positiveColor', 'Histogram +', colorInput(doc));
  addField('negativeColor', 'Histogram −', colorInput(doc));
  addField('upperColor', 'Upper', colorInput(doc));
  addField('lowerColor', 'Lower', colorInput(doc));
  addField('fillColor', 'Fill', colorInput(doc));
  addField('fillOpacity', 'Fill opacity', numberInput(doc, '0', '1', '0.01'));
  addField('lineWidth', 'Width', widthSelect(doc));

  const add = doc.createElement('button');
  add.type = 'button';
  add.textContent = 'Add';
  add.dataset.terminalStudyAdd = '';
  addBar.prepend(labelled(doc, 'Type', kind));
  addBar.append(add);

  const list = doc.createElement('div');
  list.dataset.terminalStudiesList = '';
  panel.append(head, inlineError, addBar, list);

  const input = (field: FieldName): FieldControl => addControls.get(field)!;
  const setAddDefaults = (selected: TerminalStudyKind): void => {
    input('period').value = selected === 'rsi' ? '14' : '20';
    input('fastPeriod').value = '12';
    input('slowPeriod').value = '26';
    input('signalPeriod').value = '9';
    input('multiplier').value = '2';
    input('color').value =
      selected === 'ema'
        ? '#c27a50'
        : selected === 'rsi'
          ? '#a8a0dc'
          : selected === 'macd'
            ? '#7aa2f7'
            : '#c7ef57';
    input('signalColor').value = '#e0af68';
    input('positiveColor').value = '#73c991';
    input('negativeColor').value = '#ef7c8e';
    input('upperColor').value = '#7aa2f7';
    input('lowerColor').value = '#7aa2f7';
    input('fillColor').value = '#7aa2f7';
    input('fillOpacity').value = '0.12';
    input('lineWidth').value = '2';
  };

  const visibleAddFields = (selected: TerminalStudyKind): ReadonlySet<FieldName> => {
    if (selected === 'macd')
      return new Set([
        'fastPeriod',
        'slowPeriod',
        'signalPeriod',
        'color',
        'signalColor',
        'positiveColor',
        'negativeColor',
        'lineWidth',
      ]);
    if (selected === 'bollinger')
      return new Set([
        'period',
        'multiplier',
        'color',
        'upperColor',
        'lowerColor',
        'fillColor',
        'fillOpacity',
        'lineWidth',
      ]);
    return new Set(['period', 'color', 'lineWidth']);
  };

  const updateAddDisabled = (): void => {
    const disabled = !canReserveStudyKind(renderedStudies, kind.value as TerminalStudyKind);
    if (add.disabled !== disabled) add.disabled = disabled;
  };

  const syncAddKind = (reset: boolean): void => {
    const selected = kind.value as TerminalStudyKind;
    if (reset) setAddDefaults(selected);
    const visible = visibleAddFields(selected);
    for (const [field, label] of addLabels) label.hidden = !visible.has(field);
    updateAddDisabled();
  };

  listen(
    toggle,
    'click',
    () => {
      if (handlers.setOpen) {
        handlers.setOpen(panel.hidden);
        return;
      }
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
    },
    cleanups,
  );
  listen(close, 'click', () => handlers.setOpen?.(false), cleanups);
  listen(
    panel,
    'keydown',
    (event) => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Escape') return;
      const target = key.target as HTMLElement;
      if (
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLInputElement && target.type === 'color')
      )
        return;
      key.stopPropagation();
      key.preventDefault();
      handlers.setOpen?.(false);
    },
    cleanups,
  );
  listen(kind, 'change', () => syncAddKind(true), cleanups);
  listen(
    add,
    'click',
    () => {
      const selected = kind.value as TerminalStudyKind;
      const shared = {
        color: input('color').value,
        lineWidth: Number(input('lineWidth').value),
      };
      let options: TerminalStudyOptions;
      if (selected === 'macd') {
        options = {
          kind: selected,
          fastPeriod: Number(input('fastPeriod').value),
          slowPeriod: Number(input('slowPeriod').value),
          signalPeriod: Number(input('signalPeriod').value),
          ...shared,
          signalColor: input('signalColor').value,
          positiveColor: input('positiveColor').value,
          negativeColor: input('negativeColor').value,
        } satisfies TerminalMacdStudyOptions;
      } else if (selected === 'bollinger') {
        options = {
          kind: selected,
          period: Number(input('period').value),
          multiplier: Number(input('multiplier').value),
          ...shared,
          upperColor: input('upperColor').value,
          lowerColor: input('lowerColor').value,
          fillColor: input('fillColor').value,
          fillOpacity: Number(input('fillOpacity').value),
        } satisfies TerminalBollingerStudyOptions;
      } else {
        options = {
          kind: selected,
          period: Number(input('period').value),
          ...shared,
        } satisfies TerminalSingleStudyOptions;
      }
      handlers.add(options);
    },
    cleanups,
  );

  function createRow(study: TerminalStudy, position: number): StudyRow {
    const rowCleanups: Array<() => void> = [];
    const root = doc.createElement('div');
    root.dataset.terminalStudyRow = study.id;
    const name = doc.createElement('span');
    name.dataset.terminalStudyName = '';
    name.textContent = `${position + 1}. ${study.kind.toUpperCase()}`;
    root.append(name);
    const controls = new Map<FieldName, FieldControl>();

    const addRowField = (field: FieldName, caption: string, control: FieldControl): void => {
      setDataName(control, 'row', field);
      controls.set(field, control);
      root.append(labelled(doc, caption, control));
      listen(control, 'change', () => handlers.update(study.id, patchFor(field, control)), rowCleanups);
    };
    const period = () => numberInput(doc, '2', '500');
    if (study.kind === 'macd') {
      addRowField('fastPeriod', 'Fast', period());
      addRowField('slowPeriod', 'Slow', period());
      addRowField('signalPeriod', 'Signal', period());
      addRowField('color', 'MACD', colorInput(doc));
      addRowField('signalColor', 'Signal color', colorInput(doc));
      addRowField('positiveColor', 'Histogram +', colorInput(doc));
      addRowField('negativeColor', 'Histogram −', colorInput(doc));
    } else if (study.kind === 'bollinger') {
      addRowField('period', 'Period', period());
      addRowField('multiplier', 'Multiplier', numberInput(doc, '0.01', '10', '0.1'));
      addRowField('color', 'Middle', colorInput(doc));
      addRowField('upperColor', 'Upper', colorInput(doc));
      addRowField('lowerColor', 'Lower', colorInput(doc));
      addRowField('fillColor', 'Fill', colorInput(doc));
      addRowField('fillOpacity', 'Fill opacity', numberInput(doc, '0', '1', '0.01'));
    } else {
      addRowField('period', 'Period', period());
      addRowField('color', 'Color', colorInput(doc));
    }
    addRowField('lineWidth', 'Width', widthSelect(doc));
    const visible = doc.createElement('input');
    visible.type = 'checkbox';
    addRowField('visible', 'Show', visible);

    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.dataset.terminalStudyRemove = '';
    root.append(remove);
    listen(remove, 'click', () => handlers.remove(study.id), rowCleanups);
    return {
      root,
      controls,
      cleanup: rowCleanups,
      study: copyStudy(study),
    };
  }

  setAddDefaults('sma');
  syncAddKind(false);

  return {
    toggle,
    panel,
    setEditingFocus(active) {
      if (focusStatus.hidden !== !active) focusStatus.hidden = !active;
      const caption = active ? 'Price focused while editing' : '';
      if (focusStatus.textContent !== caption) focusStatus.textContent = caption;
    },
    setOpen(open) {
      const wasOpen = !panel.hidden;
      const focusedInside = panel.contains(doc.activeElement);
      if (panel.hidden !== !open) panel.hidden = !open;
      const expanded = String(open);
      if (toggle.getAttribute('aria-expanded') !== expanded) toggle.setAttribute('aria-expanded', expanded);
      if (open && !wasOpen) heading.focus({ preventScroll: true });
      if (!open && wasOpen && focusedInside) toggle.focus({ preventScroll: true });
    },
    render(studies, error = null) {
      renderedStudies = studies;
      const message = error ?? '';
      if (inlineError.textContent !== message) inlineError.textContent = message;
      const ids = new Set(studies.map((study) => study.id));
      let focusAfterRemoval = false;
      let removedIndex = 0;
      for (const [id, row] of [...rows]) {
        if (ids.has(id)) continue;
        if (row.root.contains(doc.activeElement)) {
          focusAfterRemoval = true;
          removedIndex = [...rows.keys()].indexOf(id);
        }
        for (const cleanup of row.cleanup) cleanup();
        row.root.remove();
        rows.delete(id);
      }
      studies.forEach((study, index) => {
        let row = rows.get(study.id);
        if (row && row.study.kind !== study.kind) {
          for (const cleanup of row.cleanup) cleanup();
          row.root.remove();
          rows.delete(study.id);
          row = undefined;
        }
        if (!row) {
          row = createRow(study, index);
          rows.set(study.id, row);
          list.append(row.root);
        }
        const name = row.root.querySelector<HTMLElement>('[data-terminal-study-name]')!;
        const caption = `${index + 1}. ${study.kind.toUpperCase()}`;
        if (name.textContent !== caption) name.textContent = caption;
        const changed = !sameStudy(row.study, study);
        for (const [field, control] of row.controls) {
          const value = fieldValue(study, field);
          if (field === 'visible') {
            if (changed || doc.activeElement !== control) {
              const input = control as HTMLInputElement;
              if (input.checked !== value) input.checked = value as boolean;
            }
          } else if (changed || doc.activeElement !== control) {
            if (control.value !== value) control.value = value as string;
          }
        }
        row.study = copyStudy(study);
        const current = list.children.item(index);
        if (current !== row.root) list.insertBefore(row.root, current);
      });
      updateAddDisabled();
      if (focusAfterRemoval) {
        const next = list.children.item(Math.min(removedIndex, list.children.length - 1));
        (next?.querySelector<HTMLElement>('input,select,button') ?? add).focus({ preventScroll: true });
      }
    },
    destroy() {
      for (const cleanup of cleanups.splice(0)) cleanup();
      for (const row of rows.values()) for (const cleanup of row.cleanup) cleanup();
      rows.clear();
    },
  };
}
