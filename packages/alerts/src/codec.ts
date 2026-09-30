import type { MarketQuery } from '@filtrix.net/datafeed';
import type {
  PriceAlert,
  PriceAlertCondition,
  PriceAlertDocument,
  PriceAlertEvent,
  PriceAlertFrequency,
  PriceAlertInput,
  PriceAlertStatus,
} from './types';

const OWN = Object.prototype.hasOwnProperty;
const INPUT_FIELDS = ['query', 'price', 'condition', 'frequency', 'label'] as const;
const RULE_FIELDS = [...INPUT_FIELDS, 'id', 'status', 'triggerCount', 'lastTrigger'] as const;
const EVENT_FIELDS = [
  'id',
  'scopeId',
  'alertId',
  'providerId',
  'query',
  'condition',
  'threshold',
  'previousPrice',
  'price',
  'barTime',
  'observedAt',
  'occurrence',
] as const;
const DOCUMENT_FIELDS = ['schema', 'version', 'scopeId', 'providerId', 'nextRuleId', 'alerts'] as const;

function fail(message: string): never {
  throw new TypeError(`INVALID_PRICE_ALERT: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${label} has a symbol field`);
    result[key] = (value as Record<string, unknown>)[key];
  }
  return result;
}

function fields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const names = new Set(allowed);
  for (const key of Object.keys(value)) if (!names.has(key)) fail(`Unknown ${label} field: ${key}`);
  for (const key of required) if (!OWN.call(value, key)) fail(`${label} field is required: ${key}`);
}

export function alertIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    fail(`${label} must be a nonblank string without surrounding whitespace`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    fail(`${label} must be a safe integer at least ${minimum}`);
  return value;
}

export function alertQuery(value: unknown): MarketQuery {
  const query = record(value, 'query');
  fields(query, ['symbol', 'interval'], ['symbol', 'interval'], 'query');
  return {
    symbol: alertIdentity(query.symbol, 'symbol'),
    interval: alertIdentity(query.interval, 'interval'),
  };
}

function condition(value: unknown): PriceAlertCondition {
  if (value !== 'crosses-up' && value !== 'crosses-down' && value !== 'crosses') fail('Unknown condition');
  return value;
}

function frequency(value: unknown): PriceAlertFrequency {
  if (value !== 'once' && value !== 'repeat') fail('Unknown frequency');
  return value;
}

function status(value: unknown): PriceAlertStatus {
  if (value !== 'armed' && value !== 'paused' && value !== 'triggered') fail('Unknown status');
  return value;
}

function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > 120)
    fail('label must be a string of at most 120 characters');
  return value;
}

export function normalizePriceAlertInput(value: unknown): PriceAlertInput {
  const input = record(value, 'alert input');
  fields(input, INPUT_FIELDS, ['query', 'price', 'condition', 'frequency'], 'alert input');
  const result: PriceAlertInput = {
    query: alertQuery(input.query),
    price: finite(input.price, 'price'),
    condition: condition(input.condition),
    frequency: frequency(input.frequency),
  };
  if (OWN.call(input, 'label')) result.label = label(input.label);
  return result;
}

export function normalizePriceAlertPatch(value: unknown): Partial<PriceAlertInput> {
  const patch = record(value, 'alert patch');
  fields(patch, INPUT_FIELDS, [], 'alert patch');
  const result: Partial<PriceAlertInput> = {};
  if (OWN.call(patch, 'query')) result.query = alertQuery(patch.query);
  if (OWN.call(patch, 'price')) result.price = finite(patch.price, 'price');
  if (OWN.call(patch, 'condition')) result.condition = condition(patch.condition);
  if (OWN.call(patch, 'frequency')) result.frequency = frequency(patch.frequency);
  if (OWN.call(patch, 'label')) result.label = label(patch.label);
  return result;
}

export function alertEventId(scopeId: string, alertId: string, occurrence: number): string {
  return JSON.stringify([scopeId, alertId, occurrence]);
}

export function normalizePriceAlertEvent(
  value: unknown,
  scopeId: string,
  providerId: string,
  alertId: string,
): PriceAlertEvent {
  const event = record(value, 'lastTrigger');
  fields(event, EVENT_FIELDS, EVENT_FIELDS, 'lastTrigger');
  const occurrence = safeInteger(event.occurrence, 'occurrence', 1);
  if (
    event.scopeId !== scopeId ||
    event.providerId !== providerId ||
    event.alertId !== alertId ||
    event.id !== alertEventId(scopeId, alertId, occurrence)
  )
    fail('lastTrigger identity does not match alert');
  return {
    id: event.id as string,
    scopeId,
    alertId,
    providerId,
    query: alertQuery(event.query),
    condition: condition(event.condition),
    threshold: finite(event.threshold, 'threshold'),
    previousPrice: finite(event.previousPrice, 'previousPrice'),
    price: finite(event.price, 'event price'),
    barTime: safeInteger(event.barTime, 'barTime', Number.MIN_SAFE_INTEGER),
    observedAt: finite(event.observedAt, 'observedAt'),
    occurrence,
  };
}

export function copyPriceAlertEvent(event: PriceAlertEvent): PriceAlertEvent {
  return { ...event, query: { ...event.query } };
}

export function copyPriceAlert(alert: PriceAlert): PriceAlert {
  return {
    ...alert,
    query: { ...alert.query },
    lastTrigger: alert.lastTrigger ? copyPriceAlertEvent(alert.lastTrigger) : null,
  };
}

function decodeAlert(value: unknown, scopeId: string, providerId: string, nextRuleId: number): PriceAlert {
  const rule = record(value, 'alert');
  fields(
    rule,
    RULE_FIELDS,
    RULE_FIELDS.filter((key) => key !== 'label'),
    'alert',
  );
  const id = rule.id;
  if (typeof id !== 'string' || !id.startsWith(`${scopeId}:`)) fail('Alert ID has wrong scope');
  const suffix = id.slice(scopeId.length + 1);
  if (!/^[1-9][0-9]*$/.test(suffix)) fail('Alert ID counter is not canonical');
  const number = Number(suffix);
  if (!Number.isSafeInteger(number) || number >= nextRuleId)
    fail('Alert ID counter is outside document history');
  const normalized = normalizePriceAlertInput({
    query: rule.query,
    price: rule.price,
    condition: rule.condition,
    frequency: rule.frequency,
    ...(OWN.call(rule, 'label') ? { label: rule.label } : {}),
  });
  const triggerCount = safeInteger(rule.triggerCount, 'triggerCount', 0);
  const lastTrigger =
    rule.lastTrigger === null ? null : normalizePriceAlertEvent(rule.lastTrigger, scopeId, providerId, id);
  if (
    (lastTrigger === null && triggerCount !== 0) ||
    (lastTrigger !== null && lastTrigger.occurrence !== triggerCount)
  )
    fail('triggerCount and lastTrigger disagree');
  return { ...normalized, id, status: status(rule.status), triggerCount, lastTrigger };
}

export function createEmptyPriceAlertDocument(context: {
  providerId: string;
  scopeId: string;
}): PriceAlertDocument {
  const value = record(context, 'context');
  fields(value, ['providerId', 'scopeId'], ['providerId', 'scopeId'], 'context');
  return {
    schema: 'filtix-price-alerts',
    version: 1,
    scopeId: alertIdentity(value.scopeId, 'scopeId'),
    providerId: alertIdentity(value.providerId, 'providerId'),
    nextRuleId: 1,
    alerts: [],
  };
}

export function decodePriceAlertDocument(
  value: unknown,
  context: { providerId: string; scopeId?: string },
): PriceAlertDocument {
  const expected = record(context, 'context');
  fields(expected, ['providerId', 'scopeId'], ['providerId'], 'context');
  const expectedProvider = alertIdentity(expected.providerId, 'providerId');
  const expectedScope =
    expected.scopeId !== undefined ? alertIdentity(expected.scopeId, 'scopeId') : undefined;
  const document = record(value, 'document');
  fields(document, DOCUMENT_FIELDS, DOCUMENT_FIELDS, 'document');
  if (document.schema !== 'filtix-price-alerts' || document.version !== 1) fail('Unsupported alert document');
  const scopeId = alertIdentity(document.scopeId, 'scopeId');
  const providerId = alertIdentity(document.providerId, 'providerId');
  if (providerId !== expectedProvider || (expectedScope !== undefined && scopeId !== expectedScope))
    fail('Alert document identity does not match context');
  const nextRuleId = safeInteger(document.nextRuleId, 'nextRuleId', 1);
  const sourceAlerts = document.alerts;
  if (!Array.isArray(sourceAlerts)) fail('alerts must be an array');
  const length = sourceAlerts.length;
  if (length > 100) fail('alerts must contain at most 100 rules');
  const entries: unknown[] = [];
  for (let index = 0; index < length; index++) {
    if (!OWN.call(sourceAlerts, index)) fail(`Missing alert at ${index}`);
    entries.push(sourceAlerts[index]);
    if (sourceAlerts.length !== length) fail('alerts length changed during validation');
  }
  const requireStableLength = (): void => {
    if (sourceAlerts.length !== length) fail('alerts length changed during validation');
  };
  const seen = new Set<string>();
  const alerts: PriceAlert[] = [];
  for (const entry of entries) {
    const rule = decodeAlert(entry, scopeId, providerId, nextRuleId);
    requireStableLength();
    if (seen.has(rule.id)) fail('Duplicate alert ID');
    seen.add(rule.id);
    alerts.push(rule);
  }
  requireStableLength();
  for (let index = 0; index < length; index++)
    if (!OWN.call(sourceAlerts, index)) fail(`Missing alert at ${index}`);
  return { schema: 'filtix-price-alerts', version: 1, scopeId, providerId, nextRuleId, alerts };
}

export function copyPriceAlertDocument(document: PriceAlertDocument): PriceAlertDocument {
  return decodePriceAlertDocument(document, { providerId: document.providerId, scopeId: document.scopeId });
}
