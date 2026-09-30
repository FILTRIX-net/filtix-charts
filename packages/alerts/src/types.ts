import type { MarketQuery } from '@filtrix.net/datafeed';

export type PriceAlertCondition = 'crosses-up' | 'crosses-down' | 'crosses';
export type PriceAlertFrequency = 'once' | 'repeat';
export type PriceAlertStatus = 'armed' | 'paused' | 'triggered';

export interface PriceAlertInput {
  query: MarketQuery;
  price: number;
  condition: PriceAlertCondition;
  frequency: PriceAlertFrequency;
  label?: string;
}

export interface PriceAlertEvent {
  id: string;
  scopeId: string;
  alertId: string;
  providerId: string;
  query: MarketQuery;
  condition: PriceAlertCondition;
  threshold: number;
  previousPrice: number;
  price: number;
  barTime: number;
  observedAt: number;
  occurrence: number;
}

export interface PriceAlert extends PriceAlertInput {
  id: string;
  status: PriceAlertStatus;
  triggerCount: number;
  lastTrigger: PriceAlertEvent | null;
}

export interface PriceAlertDocument {
  schema: 'filtix-price-alerts';
  version: 1;
  scopeId: string;
  providerId: string;
  nextRuleId: number;
  alerts: readonly PriceAlert[];
}

export interface PriceAlertStore {
  add(input: PriceAlertInput): string;
  update(id: string, patch: Partial<PriceAlertInput>): void;
  remove(id: string): boolean;
  pause(id: string): void;
  rearm(id: string): void;
  list(): readonly PriceAlert[];
  subscribe(listener: () => void): () => void;
  subscribeEvents(listener: (event: PriceAlertEvent) => void): () => void;
  toJSON(): PriceAlertDocument;
  restore(value: unknown): void;
  destroy(): void;
}
