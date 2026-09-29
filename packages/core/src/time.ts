import { ChartError, type ChartTime, type TimeDomain, type UtcMillis } from './types';

const MIN_UTC_MILLIS = -8_640_000_000_000_000;
const MAX_UTC_MILLIS = 8_640_000_000_000_000;
const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function utcMillis(value: number): UtcMillis {
  if (!Number.isSafeInteger(value) || value < MIN_UTC_MILLIS || value > MAX_UTC_MILLIS) {
    throw new ChartError(
      'INVALID_TIME',
      'UTC time must be an integer millisecond value in the JavaScript Date range',
    );
  }
  return value as UtcMillis;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function parseBusinessDate(value: string): { year: number; month: number; day: number } {
  const match = BUSINESS_DATE.exec(value);
  if (match === null) {
    throw new ChartError('INVALID_TIME', 'Business dates must use YYYY-MM-DD');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ChartError('INVALID_TIME', 'Business date is not a valid calendar date');
  }
  return { year, month, day };
}

export function timeKey(time: ChartTime, domain: TimeDomain): number {
  if (domain === 'utc-ms') {
    if (typeof time !== 'number') {
      throw new ChartError('INVALID_TIME_DOMAIN', 'UTC millisecond charts require numeric times');
    }
    return utcMillis(time);
  }
  if (domain !== 'business-date') {
    throw new ChartError('INVALID_TIME_DOMAIN', `Unknown time domain: ${String(domain)}`);
  }
  if (typeof time !== 'string') {
    throw new ChartError('INVALID_TIME_DOMAIN', 'Business-date charts require YYYY-MM-DD string times');
  }

  const { year, month, day } = parseBusinessDate(time);
  return year * 10_000 + month * 100 + day;
}

export function timeFromKey(key: number, domain: TimeDomain): ChartTime {
  if (domain === 'utc-ms') {
    return utcMillis(key);
  }
  if (domain !== 'business-date' || !Number.isInteger(key) || key < 101 || key > 99_991_231) {
    throw new ChartError('INVALID_TIME', 'Invalid normalized business-date key');
  }

  const year = Math.floor(key / 10_000);
  const month = Math.floor((key % 10_000) / 100);
  const day = key % 100;
  const value = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  parseBusinessDate(value);
  return value;
}

export function lowerBound(values: ArrayLike<number>, key: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value !== undefined && value < key) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
