import type { MarketQuery } from '@filtrix.net/datafeed';
import type {
  PriceAlert,
  PriceAlertCondition,
  PriceAlertEvent,
  PriceAlertFrequency,
  PriceAlertMonitor,
  PriceAlertStore,
} from '@filtrix.net/alerts';

export interface TerminalAlertControls {
  readonly toggle: HTMLButtonElement;
  readonly panel: HTMLDivElement;
  refresh(): void;
  recordEvent(event: PriceAlertEvent): void;
  destroy(): void;
}

interface AlertControlsOptions {
  store(): PriceAlertStore;
  monitor(): PriceAlertMonitor;
  symbols: readonly string[];
  intervals: readonly string[];
  currentQuery(): MarketQuery;
}

interface Fields {
  symbol: HTMLSelectElement;
  interval: HTMLSelectElement;
  price: HTMLInputElement;
  condition: HTMLSelectElement;
  frequency: HTMLSelectElement;
  label: HTMLInputElement;
}

interface Row {
  root: HTMLDivElement;
  fields: Fields;
  status: HTMLSpanElement;
  transport: HTMLSpanElement;
  error: HTMLDivElement;
  pause: HTMLButtonElement;
  dirty: boolean;
  dispose(): void;
}

const NOTICE =
  'Alerts are evaluated while this application is running and receiving data. Crossings missed during a gap are not recovered.';

function select(doc: Document, values: readonly string[], value: string, name: string): HTMLSelectElement {
  const element = doc.createElement('select');
  element.setAttribute('aria-label', name);
  for (const item of values) {
    const option = doc.createElement('option');
    option.value = item;
    option.textContent = item;
    element.append(option);
  }
  element.value = value;
  return element;
}

function label(doc: Document, text: string, control: HTMLElement): HTMLLabelElement {
  const element = doc.createElement('label');
  const caption = doc.createElement('span');
  caption.textContent = text;
  element.append(caption, control);
  return element;
}

function fields(doc: Document, options: AlertControlsOptions, query: MarketQuery): Fields {
  const symbol = select(doc, options.symbols, query.symbol, 'Alert instrument');
  const interval = select(doc, options.intervals, query.interval, 'Alert interval');
  const price = doc.createElement('input');
  price.type = 'text';
  price.inputMode = 'decimal';
  price.setAttribute('aria-label', 'Alert threshold price');
  price.dataset.terminalAlertPrice = '';
  const condition = select(doc, ['crosses-up', 'crosses-down', 'crosses'], 'crosses-up', 'Alert direction');
  for (const option of condition.options) {
    option.textContent =
      option.value === 'crosses-up'
        ? 'Crosses above'
        : option.value === 'crosses-down'
          ? 'Crosses below'
          : 'Crosses either direction';
  }
  const frequency = select(doc, ['once', 'repeat'], 'once', 'Alert frequency');
  const name = doc.createElement('input');
  name.type = 'text';
  name.maxLength = 120;
  name.setAttribute('aria-label', 'Alert label');
  return { symbol, interval, price, condition, frequency, label: name };
}

function appendFields(doc: Document, target: HTMLElement, value: Fields): void {
  target.append(
    label(doc, 'Market', value.symbol),
    label(doc, 'Interval', value.interval),
    label(doc, 'Price', value.price),
    label(doc, 'Direction', value.condition),
    label(doc, 'Frequency', value.frequency),
    label(doc, 'Label', value.label),
  );
}

function input(value: Fields): {
  query: MarketQuery;
  price: number;
  condition: PriceAlertCondition;
  frequency: PriceAlertFrequency;
  label: string;
} {
  const raw = value.price.value.trim();
  const price = raw === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(price)) throw new TypeError('Price must be a finite number');
  return {
    query: { symbol: value.symbol.value, interval: value.interval.value },
    price,
    condition: value.condition.value as PriceAlertCondition,
    frequency: value.frequency.value as PriceAlertFrequency,
    label: value.label.value,
  };
}

function syncFields(target: Fields, rule: PriceAlert): void {
  setValue(target.symbol, rule.query.symbol);
  setValue(target.interval, rule.query.interval);
  setValue(target.price, String(rule.price));
  setValue(target.condition, rule.condition);
  setValue(target.frequency, rule.frequency);
  setValue(target.label, rule.label ?? '');
}

function setValue(target: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (target.value !== value) target.value = value;
}

function setText(target: HTMLElement, value: string): void {
  if (target.textContent !== value) target.textContent = value;
}

export function createAlertControls(doc: Document, options: AlertControlsOptions): TerminalAlertControls {
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Alerts';
  toggle.dataset.terminalAlertsToggle = '';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Price alerts');
  const panel = doc.createElement('div');
  panel.dataset.terminalAlertsPanel = '';
  panel.hidden = true;
  const heading = doc.createElement('div');
  heading.dataset.terminalAlertsHeading = '';
  const title = doc.createElement('strong');
  title.textContent = 'Price alerts';
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close price alerts');
  heading.append(title, close);
  const notice = doc.createElement('p');
  notice.dataset.terminalAlertsNotice = '';
  notice.textContent = NOTICE;
  const add = doc.createElement('form');
  add.dataset.terminalAlertForm = '';
  const addFields = fields(doc, options, options.currentQuery());
  appendFields(doc, add, addFields);
  const addButton = doc.createElement('button');
  addButton.type = 'submit';
  addButton.textContent = 'Add alert';
  addButton.dataset.terminalAlertAdd = '';
  const addError = doc.createElement('div');
  addError.dataset.terminalAlertError = '';
  addError.setAttribute('role', 'alert');
  add.append(addButton, addError);
  const list = doc.createElement('div');
  list.dataset.terminalAlertsList = '';
  const events = doc.createElement('div');
  events.dataset.terminalAlertEvents = '';
  const eventsHeading = doc.createElement('strong');
  eventsHeading.textContent = 'Recent triggers';
  events.append(eventsHeading);
  panel.append(heading, notice, add, list, events);
  const rows = new Map<string, Row>();
  const recent: PriceAlertEvent[] = [];
  let currentStore: PriceAlertStore | null = null;
  let currentMonitor: PriceAlertMonitor | null = null;
  let unsubscribeStore = () => {};
  let unsubscribeMonitor = () => {};
  let destroyed = false;
  const controlListeners: Array<() => void> = [];
  function listen<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    removers: Array<() => void> = controlListeners,
  ): void {
    element.addEventListener(type, handler as EventListener);
    removers.push(() => element.removeEventListener(type, handler as EventListener));
  }

  const refresh = (): void => {
    if (destroyed) return;
    const store = options.store();
    const monitor = options.monitor();
    if (store !== currentStore) {
      unsubscribeStore();
      currentStore = store;
      unsubscribeStore = store.subscribe(refresh);
    }
    if (monitor !== currentMonitor) {
      unsubscribeMonitor();
      currentMonitor = monitor;
      unsubscribeMonitor = monitor.subscribe(refresh);
    }
    const rules = store.list();
    const queryStates = monitor.getState().queries;
    const live = new Set(rules.map((rule) => rule.id));
    for (const [id, row] of rows)
      if (!live.has(id)) {
        row.dispose();
        row.root.remove();
        rows.delete(id);
      }
    for (const [index, rule] of rules.entries()) {
      let row = rows.get(rule.id);
      if (!row) {
        const root = doc.createElement('div');
        root.dataset.terminalAlertRow = '';
        root.dataset.terminalAlertId = rule.id;
        const rowFields = fields(doc, options, rule.query);
        appendFields(doc, root, rowFields);
        const status = doc.createElement('span');
        status.dataset.terminalAlertStatus = '';
        const transport = doc.createElement('span');
        transport.dataset.terminalAlertTransport = '';
        const apply = doc.createElement('button');
        apply.type = 'button';
        apply.textContent = 'Save';
        apply.dataset.terminalAlertSave = '';
        const pause = doc.createElement('button');
        pause.type = 'button';
        pause.dataset.terminalAlertPause = '';
        const remove = doc.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.dataset.terminalAlertRemove = '';
        const error = doc.createElement('div');
        error.dataset.terminalAlertRowError = '';
        error.setAttribute('role', 'alert');
        root.append(status, transport, apply, pause, remove, error);
        const rowListeners: Array<() => void> = [];
        row = {
          root,
          fields: rowFields,
          status,
          transport,
          error,
          pause,
          dirty: false,
          dispose() {
            for (const remove of rowListeners) remove();
            rowListeners.length = 0;
          },
        };
        rows.set(rule.id, row);
        for (const control of Object.values(rowFields)) {
          listen(
            control,
            'input',
            () => {
              row!.dirty = true;
            },
            rowListeners,
          );
          listen(
            control,
            'change',
            () => {
              row!.dirty = true;
            },
            rowListeners,
          );
        }
        listen(
          apply,
          'click',
          () => {
            try {
              storeForAction().update(rule.id, input(row!.fields));
              row!.dirty = false;
              row!.error.textContent = '';
              refresh();
            } catch (problem) {
              row!.error.textContent = problem instanceof Error ? problem.message : String(problem);
            }
          },
          rowListeners,
        );
        listen(
          pause,
          'click',
          () => {
            try {
              const latest = storeForAction()
                .list()
                .find((item) => item.id === rule.id);
              if (latest?.status === 'armed') storeForAction().pause(rule.id);
              else storeForAction().rearm(rule.id);
              row!.error.textContent = '';
            } catch (problem) {
              row!.error.textContent = problem instanceof Error ? problem.message : String(problem);
            }
          },
          rowListeners,
        );
        listen(
          remove,
          'click',
          () => {
            try {
              storeForAction().remove(rule.id);
            } catch (problem) {
              row!.error.textContent = problem instanceof Error ? problem.message : String(problem);
            }
          },
          rowListeners,
        );
      }
      if (!row.dirty) syncFields(row.fields, rule);
      setText(
        row.status,
        `Rule: ${rule.status}${rule.lastTrigger ? ` · Last trigger ${new Date(rule.lastTrigger.observedAt).toLocaleString()}` : ''}`,
      );
      const transport = queryStates.find(
        (item) => item.query.symbol === rule.query.symbol && item.query.interval === rule.query.interval,
      );
      setText(
        row.transport,
        `Feed: ${rule.status === 'armed' ? (transport?.status ?? 'waiting') : 'inactive'}`,
      );
      setText(row.pause, rule.status === 'armed' ? 'Pause' : 'Rearm');
      if (list.children[index] !== row.root) list.insertBefore(row.root, list.children[index] ?? null);
    }
  };

  const storeForAction = (): PriceAlertStore => {
    if (destroyed) throw new Error('Terminal has been destroyed');
    return options.store();
  };
  const setOpen = (open: boolean): void => {
    if (destroyed) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) refresh();
  };
  listen(toggle, 'click', () => setOpen(panel.hidden));
  listen(close, 'click', () => setOpen(false));
  listen(add, 'submit', (event) => {
    event.preventDefault();
    try {
      storeForAction().add(input(addFields));
      addError.textContent = '';
      addFields.price.value = '';
      addFields.label.value = '';
      refresh();
    } catch (problem) {
      addError.textContent = problem instanceof Error ? problem.message : String(problem);
      addFields.price.focus();
    }
  });
  refresh();
  return {
    toggle,
    panel,
    refresh,
    recordEvent(event) {
      if (destroyed) return;
      recent.unshift({ ...event, query: { ...event.query } });
      if (recent.length > 20) recent.length = 20;
      events.replaceChildren(eventsHeading);
      for (const item of recent) {
        const row = doc.createElement('div');
        row.dataset.terminalAlertEvent = '';
        row.textContent = `${item.query.symbol} ${item.query.interval} ${item.condition} ${item.threshold}: ${item.price}`;
        events.append(row);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeStore();
      unsubscribeMonitor();
      for (const row of rows.values()) row.dispose();
      rows.clear();
      for (const remove of controlListeners) remove();
      controlListeners.length = 0;
      panel.remove();
      toggle.remove();
    },
  };
}
