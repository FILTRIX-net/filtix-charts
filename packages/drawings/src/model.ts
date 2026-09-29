import { ChartError, timeKey, type ChartTime, type TimeDomain } from '@filtix/core';
import {
  copyDrawing,
  decodeDrawingDocument,
  normalizeDrawingInput,
  sameDrawing,
  validDrawingId,
} from './codec';
import type {
  Drawing,
  DrawingHistoryState,
  DrawingInput,
  DrawingMeasurement,
  DrawingPoint,
  DrawingStore,
  DrawingStoreOptions,
} from './types';

type InternalSnapshot = readonly Drawing[];
type HistoryEntry = { before: InternalSnapshot; after: InternalSnapshot };
function fail(code: string, message: string): never {
  throw new ChartError(code, message);
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_DRAWING', 'Drawing values must be objects');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Reflect.ownKeys(value))
    if (typeof key !== 'string' || !accepted.has(key))
      fail('INVALID_DRAWING', 'Unknown ' + label + ' field: ' + String(key));
}
function copyDrawings(drawings: InternalSnapshot): InternalSnapshot {
  return Object.freeze(drawings.map((drawing) => Object.freeze(copyDrawing(drawing))));
}
function cloneDrawings(drawings: InternalSnapshot): Drawing[] {
  return drawings.map(copyDrawing);
}
function equalDrawings(a: InternalSnapshot, b: InternalSnapshot): boolean {
  return a.length === b.length && a.every((drawing, index) => sameDrawing(drawing, b[index]!));
}
function validateOptions(options: DrawingStoreOptions | undefined): {
  domain: TimeDomain;
  maxDrawings: number;
  maxHistory: number;
} {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)))
    fail('INVALID_DRAWING', 'Store options must be an object');
  const domain = options?.timeDomain === undefined ? 'utc-ms' : options.timeDomain;
  if (domain !== 'utc-ms' && domain !== 'business-date') fail('INVALID_TIME_DOMAIN', 'Unknown time domain');
  const maxDrawings = options?.maxDrawings === undefined ? 200 : options.maxDrawings;
  const maxHistory = options?.maxHistory === undefined ? 100 : options.maxHistory;
  if (!Number.isInteger(maxDrawings) || maxDrawings < 1 || maxDrawings > 1000)
    fail('INVALID_DRAWING', 'maxDrawings must be an integer from 1 to 1000');
  if (!Number.isInteger(maxHistory) || maxHistory < 0 || maxHistory > 500)
    fail('INVALID_DRAWING', 'maxHistory must be an integer from 0 to 500');
  return { domain, maxDrawings, maxHistory };
}

export function createDrawingStore(options?: DrawingStoreOptions): DrawingStore {
  const { domain, maxDrawings, maxHistory } = validateOptions(options);
  let current: InternalSnapshot = Object.freeze([]);
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  const listeners = new Set<() => void>();
  // A bounded scalar replaces the lifetime set of every deleted/restored ID.
  // Canonical caller IDs advance this cursor; undo never rewinds it.
  let generatedId = 1n;
  const maximumGeneratedId = 10n ** 72n - 1n;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* observers are isolated from the model */
      }
    }
  };

  const commit = (next: InternalSnapshot, reserve: readonly string[] = []): void => {
    if (equalDrawings(current, next)) return;
    const before = current;
    current = copyDrawings(next);
    for (const id of reserve) {
      const canonical = /^drawing-([1-9][0-9]*)$/.exec(id);
      if (canonical) {
        const next = BigInt(canonical[1]!) + 1n;
        if (next > generatedId) generatedId = next;
      }
    }
    if (maxHistory > 0) {
      undoStack.push({ before, after: current });
      if (undoStack.length > maxHistory) undoStack.shift();
      redoStack.length = 0;
    }
    notify();
  };

  const store: DrawingStore = {
    get timeDomain() {
      return domain;
    },
    add(input) {
      const value = record(input);
      const suppliedId = value.id === undefined ? undefined : validDrawingId(value.id, 'id');
      if (suppliedId !== undefined && current.some((drawing) => drawing.id === suppliedId))
        fail('DUPLICATE_DRAWING_ID', `Drawing id already exists: ${suppliedId}`);
      if (current.length >= maxDrawings) fail('DRAWING_LIMIT', 'Maximum drawing count reached');
      if (suppliedId === undefined && generatedId > maximumGeneratedId)
        fail('DRAWING_ID_EXHAUSTED', 'Generated drawing ID namespace is exhausted; supply a custom ID');
      const id = suppliedId ?? `drawing-${generatedId}`;
      const drawing = normalizeDrawingInput(input, domain, id);
      commit([...current, drawing], [id]);
      return id;
    },
    update(id, patch) {
      const checkedId = validDrawingId(id, 'id');
      const index = current.findIndex((drawing) => drawing.id === checkedId);
      if (index < 0) fail('DRAWING_NOT_FOUND', `Unknown drawing id: ${checkedId}`);
      const patchValue = record(patch);
      keys(
        patchValue,
        ['points', 'style', 'paneId', 'locked', 'visible', 'levels', 'text', 'fontSize'],
        'patch',
      );
      const existing = current[index]!;
      const changes = Object.fromEntries(
        Object.entries(patchValue).filter(([, value]) => value !== undefined),
      );
      const merged: DrawingInput = {
        ...existing,
        ...changes,
        style:
          patchValue.style === undefined
            ? existing.style
            : { ...existing.style, ...record(patchValue.style) },
      };
      const replacement = normalizeDrawingInput(merged, domain, existing.id);
      if (!sameDrawing(existing, replacement)) {
        const next = [...current];
        next[index] = replacement;
        commit(next);
      }
    },
    remove(id) {
      const checkedId = validDrawingId(id, 'id');
      const index = current.findIndex((drawing) => drawing.id === checkedId);
      if (index < 0) fail('DRAWING_NOT_FOUND', `Unknown drawing id: ${checkedId}`);
      commit(current.filter((_, itemIndex) => itemIndex !== index));
    },
    clear() {
      if (current.length > 0) commit([]);
    },
    get(id) {
      const drawing = current.find((item) => item.id === id);
      return drawing === undefined ? null : copyDrawing(drawing);
    },
    list() {
      return cloneDrawings(current);
    },
    undo() {
      if (undoStack.length === 0) return false;
      const entry = undoStack.pop()!;
      current = entry.before;
      if (maxHistory > 0) redoStack.push(entry);
      notify();
      return true;
    },
    redo() {
      if (redoStack.length === 0) return false;
      const entry = redoStack.pop()!;
      current = entry.after;
      if (maxHistory > 0) undoStack.push(entry);
      notify();
      return true;
    },
    getHistoryState(): DrawingHistoryState {
      return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    },
    subscribe(listener) {
      if (typeof listener !== 'function') fail('INVALID_DRAWING', 'Listener must be a function');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toJSON() {
      return {
        schema: 'filtix-drawings' as const,
        version: 2 as const,
        timeDomain: domain,
        drawings: cloneDrawings(current),
      };
    },
    restore(document) {
      const decoded = decodeDrawingDocument(document, { timeDomain: domain, maxDrawings });
      const candidate = decoded.drawings;
      const seen = new Set(candidate.map((drawing) => drawing.id));
      commit(candidate, [...seen]);
    },
  };
  return store;
}

function daysFromCivil(year: number, month: number, day: number): number {
  let adjustedYear = year;
  adjustedYear -= month <= 2 ? 1 : 0;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function businessDateMillis(time: ChartTime, domain: TimeDomain): number {
  const key = timeKey(time, domain);
  if (domain === 'utc-ms') return key;
  const year = Math.floor(key / 10_000);
  const month = Math.floor((key % 10_000) / 100);
  const day = key % 100;
  return daysFromCivil(year, month, day) * 86_400_000;
}
export function measureDrawing(
  drawing: Drawing,
  timeDomain: TimeDomain = 'utc-ms',
): DrawingMeasurement | null {
  if (drawing.type === 'horizontal-line') return null;
  if (!Array.isArray(drawing.points) || drawing.points.length !== 2)
    fail('INVALID_DRAWING', 'Measurement requires two points');
  const first = drawing.points[0]!;
  const second = drawing.points[1]!;
  const firstPrice = first.price;
  const secondPrice = second.price;
  const priceChange =
    Number.isFinite(firstPrice) && Number.isFinite(secondPrice) && Number.isFinite(secondPrice - firstPrice)
      ? secondPrice - firstPrice
      : null;
  let percentChange: number | null = null;
  if (priceChange !== null && firstPrice !== 0) {
    const percentage = (priceChange / Math.abs(firstPrice)) * 100;
    if (Number.isFinite(percentage)) percentChange = percentage;
  }
  const elapsedMs = Math.abs(
    businessDateMillis(second.time, timeDomain) - businessDateMillis(first.time, timeDomain),
  );
  if (!Number.isFinite(elapsedMs)) fail('INVALID_TIME', 'Elapsed time is not finite');
  return { priceChange, percentChange, elapsedMs };
}
