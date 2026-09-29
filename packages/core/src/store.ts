import {
  ChartError,
  type BandPoint,
  type BandRangeStats,
  type CandlePoint,
  type ChartTime,
  type RangeStats,
  type SeriesPoint,
  type SeriesType,
  type TimeDomain,
  type ValuePoint,
  type WhitespacePoint,
} from './types';
import { lowerBound as findLowerBound, timeKey } from './time';

const INITIAL_CAPACITY = 16;
const SCALAR_BLOCK_WIDTH = 16;
const ownedStudyIngest = Symbol('owned-study-ingest');
const deriveOwnedVolume = Symbol('derive-owned-volume');

/** @internal Operation-owned stage; never retained by a SeriesStore. */
export interface ScalarColumns {
  values: Float64Array;
  present: Uint8Array;
}

/** @internal Scalar and Bollinger fill transport for the built-in terminal. */
export type OwnedStudyColumnInput =
  | { kind: 'scalar'; column: ScalarColumns }
  | { kind: 'band'; upper: ScalarColumns; lower: ScalarColumns };

function assertOwnedColumn(column: ScalarColumns, length: number): void {
  if (
    !column ||
    !(column.values instanceof Float64Array) ||
    !(column.present instanceof Uint8Array) ||
    column.values.length !== length ||
    column.present.length !== length
  )
    throw new ChartError('INVALID_DATA', 'Owned study column length/type mismatch');
}

interface ValidatedPoint {
  time: ChartTime;
  key: number;
  present: boolean;
  value: number;
  upper: number;
  lower: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  hasVolume: boolean;
}

interface Columns {
  times: ChartTime[] | null;
  keys: Float64Array;
  values: Float64Array;
  uppers: Float64Array | null;
  lowers: Float64Array | null;
  opens: Float64Array | null;
  highs: Float64Array | null;
  lows: Float64Array | null;
  closes: Float64Array | null;
  volumes: Float64Array | null;
  present: Uint8Array;
  hasVolume: Uint8Array | null;
}

interface RangeTree {
  capacity: number;
  mins: Float64Array;
  maxes: Float64Array;
  volumes: Float64Array | null;
  prefixCounts: Uint32Array;
}

interface ScalarRangeTree {
  rowCapacity: number;
  blockCapacity: number;
  blockWidth: number;
  mins: Float64Array;
  maxes: Float64Array;
  minIndices: Float64Array;
  maxIndices: Float64Array;
  prefixCounts: Uint32Array;
}

interface BandRangeTree {
  capacity: number;
  lowerMaxIndices: Int32Array;
  upperMinIndices: Int32Array;
}

function isCandleType(type: SeriesType): boolean {
  return type === 'candlestick' || type === 'ohlc';
}

function isBandType(type: SeriesType): boolean {
  return type === 'band';
}

function assertSeriesType(type: SeriesType): void {
  if (!['candlestick', 'ohlc', 'line', 'area', 'histogram', 'band'].includes(type)) {
    throw new ChartError('INVALID_SERIES_TYPE', `Unknown series type: ${String(type)}`);
  }
}

function assertDomain(domain: TimeDomain): void {
  if (domain !== 'utc-ms' && domain !== 'business-date') {
    throw new ChartError('INVALID_TIME_DOMAIN', `Unknown time domain: ${String(domain)}`);
  }
}

function createValidatedPoint(): ValidatedPoint {
  return {
    time: 0,
    key: 0,
    present: false,
    value: Number.NaN,
    upper: Number.NaN,
    lower: Number.NaN,
    open: Number.NaN,
    high: Number.NaN,
    low: Number.NaN,
    close: Number.NaN,
    volume: 0,
    hasVolume: false,
  };
}

function writeValidatedTarget(
  output: ValidatedPoint | Columns,
  index: number | null,
  time: ChartTime,
  key: number,
  present: boolean,
  value: number,
  upper: number,
  lower: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  hasVolume: boolean,
): void {
  if (index === null) {
    const point = output as ValidatedPoint;
    point.time = time;
    point.key = key;
    point.present = present;
    point.value = value;
    point.upper = upper;
    point.lower = lower;
    point.open = open;
    point.high = high;
    point.low = low;
    point.close = close;
    point.volume = volume;
    point.hasVolume = hasVolume;
    return;
  }
  const columns = output as Columns;
  if (columns.times) columns.times[index] = time;
  columns.keys[index] = key;
  columns.values[index] = value;
  if (columns.uppers) columns.uppers[index] = upper;
  if (columns.lowers) columns.lowers[index] = lower;
  if (columns.opens) {
    columns.opens[index] = open;
    columns.highs![index] = high;
    columns.lows![index] = low;
    columns.closes![index] = close;
    columns.volumes![index] = volume;
    columns.hasVolume![index] = hasVolume ? 1 : 0;
  }
  columns.present[index] = present ? 1 : 0;
}

function finiteField(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ChartError('INVALID_DATA', `${name} must be a finite number`);
  }
  return value;
}
function checkedVolumeSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isFinite(total)) {
    throw new ChartError('VOLUME_OVERFLOW', 'Aggregate candle volume must remain finite');
  }
  return total;
}

function validatePoint(
  point: SeriesPoint,
  type: SeriesType,
  domain: TimeDomain,
  output: ValidatedPoint | Columns,
  index: number | null,
): void {
  if (point === null || typeof point !== 'object') {
    throw new ChartError('INVALID_DATA', 'Series points must be objects');
  }
  const record = point as unknown as Record<string, unknown>;
  const time = record.time as ChartTime;
  const key = timeKey(time, domain);
  const candleFieldsPresent =
    record.open !== undefined ||
    record.high !== undefined ||
    record.low !== undefined ||
    record.close !== undefined;
  const valuePresent = record.value !== undefined;
  const volumePresent = record.volume !== undefined;
  const lowerInput = record.lower;
  const upperInput = record.upper;
  const lowerPresent = lowerInput !== undefined;
  const upperPresent = upperInput !== undefined;
  const bandFieldsPresent = lowerPresent || upperPresent;
  let present = false;
  let value = Number.NaN;
  let upper = Number.NaN;
  let lower = Number.NaN;
  let open = Number.NaN;
  let high = Number.NaN;
  let low = Number.NaN;
  let close = Number.NaN;
  let volume = 0;
  let hasVolume = false;

  if (isBandType(type)) {
    if (lowerPresent || upperPresent || candleFieldsPresent || valuePresent || volumePresent) {
      if (!lowerPresent || !upperPresent || candleFieldsPresent || valuePresent || volumePresent) {
        throw new ChartError('INVALID_DATA', 'band series require both bounds or whitespace');
      }
      if (
        typeof lowerInput !== 'number' ||
        !Number.isFinite(lowerInput) ||
        typeof upperInput !== 'number' ||
        !Number.isFinite(upperInput)
      ) {
        throw new ChartError('INVALID_DATA', 'band bounds must be finite numbers');
      }
      if (lowerInput > upperInput)
        throw new ChartError('INVALID_DATA', 'band bounds must satisfy lower <= upper');
      present = true;
      upper = upperInput;
      lower = lowerInput;
    }
  } else if (isCandleType(type)) {
    if (bandFieldsPresent) {
      throw new ChartError('INVALID_DATA', `${type} series require OHLC points or whitespace`);
    }
    if (candleFieldsPresent || valuePresent || volumePresent) {
      if (valuePresent) {
        throw new ChartError('INVALID_DATA', `${type} series require OHLC points or whitespace`);
      }
      open = finiteField(record, 'open');
      high = finiteField(record, 'high');
      low = finiteField(record, 'low');
      close = finiteField(record, 'close');
      if (low > Math.min(open, close) || Math.max(open, close) > high) {
        throw new ChartError('INVALID_DATA', 'OHLC values must satisfy low <= open/close <= high');
      }
      if (volumePresent) {
        volume = finiteField(record, 'volume');
        if (volume < 0) throw new ChartError('INVALID_DATA', 'volume must be nonnegative');
      }
      present = true;
      value = close;
      hasVolume = volumePresent;
    }
  } else if (valuePresent || candleFieldsPresent || volumePresent || bandFieldsPresent) {
    if (candleFieldsPresent || volumePresent || bandFieldsPresent) {
      throw new ChartError('INVALID_DATA', `${type} series require value points or whitespace`);
    }
    value = finiteField(record, 'value');
    present = true;
  }
  writeValidatedTarget(
    output,
    index,
    time,
    key,
    present,
    value,
    upper,
    lower,
    open,
    high,
    low,
    close,
    volume,
    hasVolume,
  );
}

// Bulk scalar ingestion keeps the generic input-read contract, but writes only
// the scalar columns. update() and candle/band ingestion retain validatePoint.
function validateScalarBulkPoint(
  point: SeriesPoint,
  type: SeriesType,
  domain: TimeDomain,
  output: ValidatedPoint | Columns,
  index: number | null,
): void {
  if (point === null || typeof point !== 'object') {
    throw new ChartError('INVALID_DATA', 'Series points must be objects');
  }
  const record = point as unknown as Record<string, unknown>;
  const time = record.time as ChartTime;
  const key = timeKey(time, domain);
  const candleFieldsPresent =
    record.open !== undefined ||
    record.high !== undefined ||
    record.low !== undefined ||
    record.close !== undefined;
  const valuePresent = record.value !== undefined;
  const volumePresent = record.volume !== undefined;
  const lowerInput = record.lower;
  const upperInput = record.upper;
  if (candleFieldsPresent || volumePresent || lowerInput !== undefined || upperInput !== undefined) {
    throw new ChartError('INVALID_DATA', `${type} series require value points or whitespace`);
  }
  const value = valuePresent ? finiteField(record, 'value') : Number.NaN;
  if (index === null) {
    const target = output as ValidatedPoint;
    target.time = time;
    target.key = key;
    target.present = valuePresent;
    target.value = value;
  } else {
    const columns = output as Columns;
    if (columns.times) columns.times[index] = time;
    columns.keys[index] = key;
    columns.values[index] = value;
    columns.present[index] = valuePresent ? 1 : 0;
  }
}

function capacityFor(length: number): number {
  let capacity = INITIAL_CAPACITY;
  while (capacity < length) capacity *= 2;
  return capacity;
}

function createColumns(capacity: number, candleType: boolean, bandType: boolean, rawTimes: boolean): Columns {
  return {
    times: rawTimes ? new Array<ChartTime>(capacity) : null,
    keys: new Float64Array(capacity),
    values: new Float64Array(capacity),
    uppers: bandType ? new Float64Array(capacity) : null,
    lowers: bandType ? new Float64Array(capacity) : null,
    opens: candleType ? new Float64Array(capacity) : null,
    highs: candleType ? new Float64Array(capacity) : null,
    lows: candleType ? new Float64Array(capacity) : null,
    closes: candleType ? new Float64Array(capacity) : null,
    volumes: candleType ? new Float64Array(capacity) : null,
    present: new Uint8Array(capacity),
    hasVolume: candleType ? new Uint8Array(capacity) : null,
  };
}

function writePoint(columns: Columns, index: number, point: ValidatedPoint): void {
  if (columns.times) columns.times[index] = point.time;
  columns.keys[index] = point.key;
  columns.values[index] = point.value;
  if (columns.uppers) columns.uppers[index] = point.upper;
  if (columns.lowers) columns.lowers[index] = point.lower;
  if (columns.opens) {
    columns.opens[index] = point.open;
    columns.highs![index] = point.high;
    columns.lows![index] = point.low;
    columns.closes![index] = point.close;
    columns.volumes![index] = point.volume;
    columns.hasVolume![index] = point.hasVolume ? 1 : 0;
  }
  columns.present[index] = point.present ? 1 : 0;
}

function growColumns(columns: Columns, length: number, capacity: number): Columns {
  const grown = createColumns(
    capacity,
    columns.opens !== null,
    columns.uppers !== null,
    columns.times !== null,
  );
  if (grown.times && columns.times) {
    for (let index = 0; index < length; index += 1) grown.times[index] = columns.times[index]!;
  }
  grown.keys.set(columns.keys.subarray(0, length));
  grown.values.set(columns.values.subarray(0, length));
  if (grown.uppers && columns.uppers) grown.uppers.set(columns.uppers.subarray(0, length));
  if (grown.lowers && columns.lowers) grown.lowers.set(columns.lowers.subarray(0, length));
  if (grown.opens && columns.opens) grown.opens.set(columns.opens.subarray(0, length));
  if (grown.highs && columns.highs) grown.highs.set(columns.highs.subarray(0, length));
  if (grown.lows && columns.lows) grown.lows.set(columns.lows.subarray(0, length));
  if (grown.closes && columns.closes) grown.closes.set(columns.closes.subarray(0, length));
  if (grown.volumes && columns.volumes) grown.volumes.set(columns.volumes.subarray(0, length));
  grown.present.set(columns.present.subarray(0, length));
  if (grown.hasVolume && columns.hasVolume) grown.hasVolume.set(columns.hasVolume.subarray(0, length));
  return grown;
}

function createRangeTree(capacity: number, length: number, candleType: boolean): RangeTree {
  const size = capacity * 2;
  const mins = new Float64Array(size);
  const maxes = new Float64Array(size);
  const firstEmptyLeaf = capacity + length;
  mins.fill(Number.POSITIVE_INFINITY, firstEmptyLeaf);
  maxes.fill(Number.NEGATIVE_INFINITY, firstEmptyLeaf);
  return {
    capacity,
    mins,
    maxes,
    volumes: candleType ? new Float64Array(size) : null,
    prefixCounts: new Uint32Array(capacity + 1),
  };
}

function combineNode(tree: RangeTree, node: number): void {
  const left = node * 2;
  const right = left + 1;
  const volumes = tree.volumes;
  if (volumes) volumes[node] = checkedVolumeSum(volumes[left]!, volumes[right]!);

  const leftMin = tree.mins[left]!;
  const rightMin = tree.mins[right]!;
  if (leftMin <= rightMin) {
    tree.mins[node] = leftMin;
  } else {
    tree.mins[node] = rightMin;
  }

  const leftMax = tree.maxes[left]!;
  const rightMax = tree.maxes[right]!;
  if (leftMax >= rightMax) {
    tree.maxes[node] = leftMax;
  } else {
    tree.maxes[node] = rightMax;
  }
}

function setLeaf(
  tree: RangeTree,
  columns: Columns,
  index: number,
  candleType: boolean,
  bandType: boolean,
): void {
  const leaf = tree.capacity + index;
  const present = columns.present[index] === 1;
  if (present) {
    tree.mins[leaf] = candleType
      ? columns.lows![index]!
      : bandType
        ? columns.lowers![index]!
        : columns.values[index]!;
    tree.maxes[leaf] = candleType
      ? columns.highs![index]!
      : bandType
        ? columns.uppers![index]!
        : columns.values[index]!;
    if (tree.volumes) tree.volumes[leaf] = columns.volumes![index]!;
  } else {
    tree.mins[leaf] = Number.POSITIVE_INFINITY;
    tree.maxes[leaf] = Number.NEGATIVE_INFINITY;
    if (tree.volumes) tree.volumes[leaf] = 0;
  }
  tree.prefixCounts[index + 1] = tree.prefixCounts[index]! + (present ? 1 : 0);
}

function buildRangeTree(
  columns: Columns,
  length: number,
  capacity: number,
  candleType: boolean,
  bandType: boolean,
): RangeTree {
  const tree = createRangeTree(capacity, length, candleType);
  const { mins, maxes, volumes, prefixCounts } = tree;
  const minValues = candleType ? columns.lows! : bandType ? columns.lowers! : columns.values;
  const maxValues = candleType ? columns.highs! : bandType ? columns.uppers! : columns.values;
  const present = columns.present;
  const pointVolumes = columns.volumes;

  // This duplicates setLeaf/combineNode for bulk builds with the same sentinels, leftmost ties, and volume order.
  mins.set(minValues.subarray(0, length), capacity);
  maxes.set(maxValues.subarray(0, length), capacity);
  if (volumes) volumes.set(pointVolumes!.subarray(0, length), capacity);
  for (let index = 0; index < length; index += 1) {
    const leaf = capacity + index;
    const hasPoint = present[index] === 1;
    prefixCounts[index + 1] = prefixCounts[index]! + (hasPoint ? 1 : 0);
    if (!hasPoint) {
      mins[leaf] = Number.POSITIVE_INFINITY;
      maxes[leaf] = Number.NEGATIVE_INFINITY;
      if (volumes) volumes[leaf] = 0;
    }
  }
  let levelStart = capacity / 2;
  let active = Math.ceil(length / 2);
  while (levelStart >= 1) {
    // Untouched suffix subtrees need the same sentinels that combineNode would produce.
    const firstSkipped = levelStart + active;
    const levelEnd = levelStart * 2;
    if (firstSkipped < levelEnd) {
      mins.fill(Number.POSITIVE_INFINITY, firstSkipped, levelEnd);
      maxes.fill(Number.NEGATIVE_INFINITY, firstSkipped, levelEnd);
    }
    for (let node = firstSkipped - 1; node >= levelStart; node -= 1) {
      const left = node * 2;
      const right = left + 1;
      if (volumes) volumes[node] = checkedVolumeSum(volumes[left]!, volumes[right]!);

      const leftMin = mins[left]!;
      const rightMin = mins[right]!;
      if (leftMin <= rightMin) {
        mins[node] = leftMin;
      } else {
        mins[node] = rightMin;
      }

      const leftMax = maxes[left]!;
      const rightMax = maxes[right]!;
      if (leftMax >= rightMax) {
        maxes[node] = leftMax;
      } else {
        maxes[node] = rightMax;
      }
    }
    active = Math.ceil(active / 2);
    levelStart = Math.floor(levelStart / 2);
  }
  return tree;
}

function updateRangeTree(
  tree: RangeTree,
  columns: Columns,
  index: number,
  candleType: boolean,
  bandType: boolean,
): void {
  setLeaf(tree, columns, index, candleType, bandType);
  let node = Math.floor((tree.capacity + index) / 2);
  while (node > 0) {
    combineNode(tree, node);
    node = Math.floor(node / 2);
  }
}

function createScalarRangeTree(rowCapacity: number): ScalarRangeTree {
  const blockCapacity = Math.max(1, Math.ceil(rowCapacity / SCALAR_BLOCK_WIDTH));
  const size = blockCapacity * 2;
  const tree: ScalarRangeTree = {
    rowCapacity,
    blockCapacity,
    blockWidth: SCALAR_BLOCK_WIDTH,
    mins: new Float64Array(size),
    maxes: new Float64Array(size),
    minIndices: new Float64Array(size),
    maxIndices: new Float64Array(size),
    prefixCounts: new Uint32Array(rowCapacity + 1),
  };
  tree.mins.fill(Number.POSITIVE_INFINITY);
  tree.maxes.fill(Number.NEGATIVE_INFINITY);
  tree.minIndices.fill(-1);
  tree.maxIndices.fill(-1);
  return tree;
}

function combineScalarNode(tree: ScalarRangeTree, node: number): void {
  const left = node * 2;
  const right = left + 1;
  const leftMinIndex = tree.minIndices[left]!;
  const rightMinIndex = tree.minIndices[right]!;
  let minIndex = leftMinIndex;
  if (
    leftMinIndex < 0 ||
    (rightMinIndex >= 0 &&
      (tree.mins[right]! < tree.mins[left]! ||
        (tree.mins[right] === tree.mins[left] && rightMinIndex < leftMinIndex)))
  )
    minIndex = rightMinIndex;
  tree.minIndices[node] = minIndex;
  tree.mins[node] =
    minIndex < 0
      ? Number.POSITIVE_INFINITY
      : minIndex === leftMinIndex
        ? tree.mins[left]!
        : tree.mins[right]!;

  const leftMaxIndex = tree.maxIndices[left]!;
  const rightMaxIndex = tree.maxIndices[right]!;
  let maxIndex = leftMaxIndex;
  if (
    leftMaxIndex < 0 ||
    (rightMaxIndex >= 0 &&
      (tree.maxes[right]! > tree.maxes[left]! ||
        (tree.maxes[right] === tree.maxes[left] && rightMaxIndex < leftMaxIndex)))
  )
    maxIndex = rightMaxIndex;
  tree.maxIndices[node] = maxIndex;
  tree.maxes[node] =
    maxIndex < 0
      ? Number.NEGATIVE_INFINITY
      : maxIndex === leftMaxIndex
        ? tree.maxes[left]!
        : tree.maxes[right]!;
}

function scanScalarBlock(tree: ScalarRangeTree, columns: Columns, block: number, length: number): void {
  const leaf = tree.blockCapacity + block;
  let minIndex = -1;
  let maxIndex = -1;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const end = Math.min(length, (block + 1) * tree.blockWidth);
  for (let row = block * tree.blockWidth; row < end; row += 1) {
    if (columns.present[row] !== 1) continue;
    const value = columns.values[row]!;
    if (minIndex < 0 || value < min || (value === min && row < minIndex)) {
      min = value;
      minIndex = row;
    }
    if (maxIndex < 0 || value > max || (value === max && row < maxIndex)) {
      max = value;
      maxIndex = row;
    }
  }
  tree.mins[leaf] = min;
  tree.maxes[leaf] = max;
  tree.minIndices[leaf] = minIndex;
  tree.maxIndices[leaf] = maxIndex;
}

function buildScalarRangeTree(columns: Columns, length: number, rowCapacity: number): ScalarRangeTree {
  const tree = createScalarRangeTree(rowCapacity);
  for (let row = 0; row < length; row += 1) {
    tree.prefixCounts[row + 1] = tree.prefixCounts[row]! + (columns.present[row] === 1 ? 1 : 0);
  }
  const blocks = Math.ceil(length / tree.blockWidth);
  for (let block = 0; block < blocks; block += 1) scanScalarBlock(tree, columns, block, length);
  for (let node = tree.blockCapacity - 1; node > 0; node -= 1) combineScalarNode(tree, node);
  return tree;
}

function updateScalarRangeTree(tree: ScalarRangeTree, columns: Columns, index: number, length: number): void {
  tree.prefixCounts[index + 1] = tree.prefixCounts[index]! + (columns.present[index] === 1 ? 1 : 0);
  const block = Math.floor(index / tree.blockWidth);
  scanScalarBlock(tree, columns, block, length);
  let node = Math.floor((tree.blockCapacity + block) / 2);
  while (node > 0) {
    combineScalarNode(tree, node);
    node = Math.floor(node / 2);
  }
}

function extremaLeafIndex(tree: RangeTree, winningNode: number, minimum: boolean): number {
  // Called only for a nonempty winning node; original child ties favor the leftmost leaf.
  let node = winningNode;
  const values = minimum ? tree.mins : tree.maxes;
  while (node < tree.capacity) {
    const left = node * 2;
    const right = left + 1;
    node = minimum
      ? values[left]! <= values[right]!
        ? left
        : right
      : values[left]! >= values[right]!
        ? left
        : right;
  }
  return node - tree.capacity;
}

function createBandRangeTree(capacity: number): BandRangeTree {
  const size = capacity * 2;
  const tree: BandRangeTree = {
    capacity,
    lowerMaxIndices: new Int32Array(size),
    upperMinIndices: new Int32Array(size),
  };
  tree.lowerMaxIndices.fill(-1);
  tree.upperMinIndices.fill(-1);
  return tree;
}

function selectBoundaryIndex(
  indices: Int32Array,
  values: Float64Array,
  node: number,
  left: number,
  right: number,
  minimum: boolean,
): void {
  const leftIndex = indices[left]!;
  const rightIndex = indices[right]!;
  if (leftIndex < 0 || rightIndex < 0) {
    indices[node] = leftIndex < 0 ? rightIndex : leftIndex;
    return;
  }
  const leftValue = values[leftIndex]!;
  const rightValue = values[rightIndex]!;
  indices[node] = minimum
    ? leftValue < rightValue || (leftValue === rightValue && leftIndex <= rightIndex)
      ? leftIndex
      : rightIndex
    : leftValue > rightValue || (leftValue === rightValue && leftIndex <= rightIndex)
      ? leftIndex
      : rightIndex;
}

function combineBandNode(tree: BandRangeTree, columns: Columns, node: number): void {
  const left = node * 2;
  const right = left + 1;
  selectBoundaryIndex(tree.lowerMaxIndices, columns.lowers!, node, left, right, false);
  selectBoundaryIndex(tree.upperMinIndices, columns.uppers!, node, left, right, true);
}

function setBandLeaf(tree: BandRangeTree, columns: Columns, index: number): void {
  const leaf = tree.capacity + index;
  const value = columns.present[index] === 1 ? index : -1;
  tree.lowerMaxIndices[leaf] = value;
  tree.upperMinIndices[leaf] = value;
}

function buildBandRangeTree(columns: Columns, length: number, capacity: number): BandRangeTree {
  const tree = createBandRangeTree(capacity);
  for (let index = 0; index < length; index += 1) setBandLeaf(tree, columns, index);
  for (let node = capacity - 1; node > 0; node -= 1) combineBandNode(tree, columns, node);
  return tree;
}

function updateBandRangeTree(tree: BandRangeTree, columns: Columns, index: number): void {
  setBandLeaf(tree, columns, index);
  let node = Math.floor((tree.capacity + index) / 2);
  while (node > 0) {
    combineBandNode(tree, columns, node);
    node = Math.floor(node / 2);
  }
}

function assertTreeVolumeUpdate(tree: RangeTree, index: number, volume: number): void {
  const volumes = tree.volumes;
  if (!volumes) return;
  let node = tree.capacity + index;
  let aggregate = volume;
  while (node > 1) {
    aggregate = checkedVolumeSum(aggregate, volumes[node ^ 1]!);
    node = Math.floor(node / 2);
  }
}

function clippedIndices(from: number, to: number, length: number): [number, number] | null {
  if (length === 0 || Number.isNaN(from) || Number.isNaN(to) || from > to) return null;
  const start = Math.max(0, Math.ceil(from));
  const end = Math.min(length - 1, Math.floor(to));
  return start <= end ? [start, end] : null;
}

export class SeriesStore {
  readonly type: SeriesType;
  readonly domain: TimeDomain;
  private columns: Columns;
  private tree: RangeTree | null;
  private scalarTree: ScalarRangeTree | null;
  private bandTree: BandRangeTree | null;
  private _length = 0;
  private _revision = 0;

  constructor(type: SeriesType, domain: TimeDomain = 'utc-ms') {
    assertSeriesType(type);
    assertDomain(domain);
    this.type = type;
    this.domain = domain;
    this.columns = createColumns(
      INITIAL_CAPACITY,
      isCandleType(type),
      isBandType(type),
      domain === 'business-date',
    );
    this.tree =
      isCandleType(type) || isBandType(type)
        ? buildRangeTree(this.columns, 0, INITIAL_CAPACITY, isCandleType(type), isBandType(type))
        : null;
    this.scalarTree = this.tree ? null : buildScalarRangeTree(this.columns, 0, INITIAL_CAPACITY);
    this.bandTree = isBandType(type) ? buildBandRangeTree(this.columns, 0, INITIAL_CAPACITY) : null;
  }

  get length(): number {
    return this._length;
  }

  get revision(): number {
    return this._revision;
  }

  setData(points: readonly SeriesPoint[]): void {
    if (!Array.isArray(points)) {
      throw new ChartError('INVALID_DATA', 'setData requires an array of series points');
    }
    const initialLength = points.length;
    const candleType = isCandleType(this.type);
    const validate = candleType || isBandType(this.type) ? validatePoint : validateScalarBulkPoint;
    let columns = createColumns(
      capacityFor(initialLength),
      candleType,
      isBandType(this.type),
      this.domain === 'business-date',
    );
    const validated = createValidatedPoint();
    let length = 0;
    let previousKey = Number.NEGATIVE_INFINITY;
    let aggregateVolume = 0;
    for (let index = 0; index < points.length; index += 1) {
      const needsGrowth = length === columns.keys.length;
      validate(
        points[index]!,
        this.type,
        this.domain,
        needsGrowth ? validated : columns,
        needsGrowth ? null : index,
      );
      const key = needsGrowth ? validated.key : columns.keys[index]!;
      if (index > 0 && key <= previousKey) {
        throw new ChartError('OUT_OF_ORDER', 'setData times must be strictly increasing');
      }
      if (candleType) {
        const volume = needsGrowth ? validated.volume : columns.volumes![index]!;
        aggregateVolume = checkedVolumeSum(aggregateVolume, volume);
      }
      if (needsGrowth) {
        columns = growColumns(columns, length, columns.keys.length * 2);
        writePoint(columns, index, validated);
      }
      length += 1;
      previousKey = key;
    }
    if (length < initialLength) {
      throw new ChartError('INVALID_DATA', 'setData input length changed during validation');
    }

    const capacity = columns.keys.length;
    const tree =
      candleType || isBandType(this.type)
        ? buildRangeTree(columns, length, capacity, candleType, isBandType(this.type))
        : null;
    const scalarTree = tree ? null : buildScalarRangeTree(columns, length, capacity);

    const bandTree = isBandType(this.type) ? buildBandRangeTree(columns, length, capacity) : null;

    this.columns = columns;
    this.tree = tree;
    this.scalarTree = scalarTree;
    this.bandTree = bandTree;
    this._length = length;
    this._revision += 1;
  }

  [deriveOwnedVolume](): SeriesStore {
    // Only the fresh, unexposed candlestick candidate in the synchronous
    // built-in chart operation may reach this method. Instance/type checks do
    // not certify arbitrary externally mutable SeriesStore objects.
    const length = this._length;
    const columns = createColumns(capacityFor(length), false, false, false);
    for (let index = 0; index < length; index += 1) {
      columns.keys[index] = this.columns.keys[index]!;
      const present = this.columns.present[index] === 1 && this.columns.hasVolume![index] === 1;
      columns.values[index] = present ? this.columns.volumes![index]! : Number.NaN;
      columns.present[index] = present ? 1 : 0;
    }
    const result = new SeriesStore('histogram', this.domain);
    result.columns = columns;
    result.tree = null;
    result.scalarTree = buildScalarRangeTree(columns, length, columns.keys.length);
    result.bandTree = null;
    result._length = length;
    result._revision += 1;
    return result;
  }

  [ownedStudyIngest](points: readonly { time: number }[], input: OwnedStudyColumnInput): void {
    if (!Array.isArray(points))
      throw new ChartError('INVALID_DATA', 'Owned study columns require an array of time points');
    if (this.domain !== 'utc-ms')
      throw new ChartError('INVALID_TIME_DOMAIN', 'Owned study columns require UTC millisecond times');
    const bandType = isBandType(this.type);
    if (isCandleType(this.type) || !input || input.kind !== (bandType ? 'band' : 'scalar'))
      throw new ChartError('INVALID_DATA', 'Owned study columns require a matching scalar/band series');
    const initialLength = points.length;
    if (input.kind === 'band') {
      assertOwnedColumn(input.upper, initialLength);
      assertOwnedColumn(input.lower, initialLength);
    } else {
      assertOwnedColumn(input.column, initialLength);
    }
    const columns = createColumns(capacityFor(initialLength), false, bandType, false);
    const whitespace: { time: number } = { time: 0 };
    const scalar: { time: number; value: number } = { time: 0, value: 0 };
    const band: { time: number; upper: number; lower: number } = {
      time: 0,
      upper: 0,
      lower: 0,
    };
    let previousKey = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < initialLength; index += 1) {
      const point = points[index];
      if (point === null || typeof point !== 'object')
        throw new ChartError('INVALID_DATA', 'Series points must be objects');
      const time = point.time;
      whitespace.time = time;
      if (input.kind === 'band') {
        const upperPresent = input.upper.present[index];
        const lowerPresent = input.lower.present[index];
        if (
          (upperPresent !== 0 && upperPresent !== 1) ||
          (lowerPresent !== 0 && lowerPresent !== 1) ||
          upperPresent !== lowerPresent
        ) {
          timeKey(time, this.domain);
          throw new ChartError('INVALID_DATA', 'band series require both bounds or whitespace');
        }
        band.time = time;
        if (upperPresent === 1) {
          band.upper = input.upper.values[index]!;
          band.lower = input.lower.values[index]!;
        }
        validatePoint(upperPresent === 1 ? band : whitespace, this.type, this.domain, columns, index);
      } else {
        const present = input.column.present[index];
        if (present !== 0 && present !== 1) {
          timeKey(time, this.domain);
          throw new ChartError('INVALID_DATA', 'Owned study presence must be 0 or 1');
        }
        scalar.time = time;
        if (present === 1) scalar.value = input.column.values[index]!;
        validateScalarBulkPoint(present === 1 ? scalar : whitespace, this.type, this.domain, columns, index);
      }
      const key = columns.keys[index]!;
      if (index > 0 && key <= previousKey)
        throw new ChartError('OUT_OF_ORDER', 'setData times must be strictly increasing');
      previousKey = key;
    }
    if (points.length !== initialLength)
      throw new ChartError('INVALID_DATA', 'setData input length changed during validation');

    const capacity = columns.keys.length;
    const tree = bandType ? buildRangeTree(columns, initialLength, capacity, false, true) : null;
    const scalarTree = tree ? null : buildScalarRangeTree(columns, initialLength, capacity);
    const bandTree = bandType ? buildBandRangeTree(columns, initialLength, capacity) : null;
    this.columns = columns;
    this.tree = tree;
    this.scalarTree = scalarTree;
    this.bandTree = bandTree;
    this._length = initialLength;
    this._revision += 1;
  }

  update(point: SeriesPoint): 'append' | 'replace' {
    const validated = createValidatedPoint();
    validatePoint(point, this.type, this.domain, validated, null);
    if (this._length > 0) {
      const newestKey = this.columns.keys[this._length - 1]!;
      if (validated.key < newestKey) {
        throw new ChartError(
          'OUT_OF_ORDER',
          'update may only replace the newest point or append a later point',
        );
      }
      if (validated.key === newestKey) {
        const index = this._length - 1;
        if (this.tree) assertTreeVolumeUpdate(this.tree, index, validated.volume);
        writePoint(this.columns, index, validated);
        if (this.tree)
          updateRangeTree(this.tree, this.columns, index, isCandleType(this.type), isBandType(this.type));
        else updateScalarRangeTree(this.scalarTree!, this.columns, index, this._length);
        if (this.bandTree) updateBandRangeTree(this.bandTree, this.columns, index);
        this._revision += 1;
        return 'replace';
      }
    }

    const index = this._length;
    if (this.tree) {
      if (index < this.tree.capacity) {
        assertTreeVolumeUpdate(this.tree, index, validated.volume);
      } else if (this.tree.volumes) {
        checkedVolumeSum(this.tree.volumes[1]!, validated.volume);
      }
    }
    if (this._length === this.columns.keys.length) {
      const length = this._length + 1;
      const columns = growColumns(this.columns, this._length, this.columns.keys.length * 2);
      writePoint(columns, index, validated);
      const tree = this.tree
        ? buildRangeTree(columns, length, columns.keys.length, isCandleType(this.type), isBandType(this.type))
        : null;
      const scalarTree = tree ? null : buildScalarRangeTree(columns, length, columns.keys.length);
      const bandTree = this.bandTree ? buildBandRangeTree(columns, length, columns.keys.length) : null;
      this.columns = columns;
      this.tree = tree;
      this.scalarTree = scalarTree;
      this.bandTree = bandTree;
      this._length = length;
      this._revision += 1;
      return 'append';
    }
    writePoint(this.columns, index, validated);
    this._length += 1;
    if (this.tree)
      updateRangeTree(this.tree, this.columns, index, isCandleType(this.type), isBandType(this.type));
    else updateScalarRangeTree(this.scalarTree!, this.columns, index, this._length);
    if (this.bandTree) updateBandRangeTree(this.bandTree, this.columns, index);
    this._revision += 1;
    return 'append';
  }

  pointAt(index: number): SeriesPoint | null {
    if (!Number.isInteger(index) || index < 0 || index >= this._length) return null;
    const time = this.columns.times ? this.columns.times[index]! : this.columns.keys[index]!;
    if (this.columns.present[index] !== 1) return { time } satisfies WhitespacePoint;
    if (isBandType(this.type)) {
      return {
        time,
        upper: this.columns.uppers![index]!,
        lower: this.columns.lowers![index]!,
      } satisfies BandPoint;
    }
    if (isCandleType(this.type)) {
      const result: CandlePoint = {
        time,
        open: this.columns.opens![index]!,
        high: this.columns.highs![index]!,
        low: this.columns.lows![index]!,
        close: this.columns.closes![index]!,
      };
      if (this.columns.hasVolume![index] === 1) result.volume = this.columns.volumes![index]!;
      return result;
    }
    return { time, value: this.columns.values[index]! } satisfies ValuePoint;
  }

  keyAt(index: number): number {
    return Number.isInteger(index) && index >= 0 && index < this._length
      ? this.columns.keys[index]!
      : Number.NaN;
  }

  valueAt(index: number): number {
    if (!this.hasValueAt(index)) return Number.NaN;
    return this.columns.values[index]!;
  }

  lowerAt(index: number): number {
    return this.readBandColumn(this.columns.lowers, index);
  }

  upperAt(index: number): number {
    return this.readBandColumn(this.columns.uppers, index);
  }

  hasDataAt(index: number): boolean {
    return this.hasValueAt(index);
  }

  openAt(index: number): number {
    return this.readCandleColumn(this.columns.opens, index);
  }

  highAt(index: number): number {
    return this.readCandleColumn(this.columns.highs, index);
  }

  lowAt(index: number): number {
    return this.readCandleColumn(this.columns.lows, index);
  }

  closeAt(index: number): number {
    return this.readCandleColumn(this.columns.closes, index);
  }

  volumeAt(index: number): number {
    return this.hasValueAt(index) && isCandleType(this.type) ? this.columns.volumes![index]! : Number.NaN;
  }

  lowerBound(key: number): number {
    return findLowerBound(this.columns.keys.subarray(0, this._length), key);
  }

  range(from: number, to: number): RangeStats | null {
    const clipped = clippedIndices(from, to, this._length);
    if (clipped === null) return null;
    const tree = this.scalarTree ?? this.tree!;
    const count = tree.prefixCounts[clipped[1] + 1]! - tree.prefixCounts[clipped[0]]!;
    if (count === 0) return null;
    if (this.scalarTree) return this.scalarRange(clipped[0], clipped[1], count);
    const rowTree = this.tree!;
    let left = rowTree.capacity + clipped[0];
    let right = rowTree.capacity + clipped[1];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let minNode = -1;
    let maxNode = -1;
    let minLeft = Number.POSITIVE_INFINITY;
    let maxLeft = Number.POSITIVE_INFINITY;
    let span = 1;
    let volume = 0;

    const consume = (node: number): void => {
      const nodeMin = rowTree.mins[node]!;
      if (nodeMin === Number.POSITIVE_INFINITY) return;
      const nodeLeft = node * span - rowTree.capacity;
      if (nodeMin < min || (nodeMin === min && nodeLeft < minLeft)) {
        min = nodeMin;
        minNode = node;
        minLeft = nodeLeft;
      }
      const nodeMax = rowTree.maxes[node]!;
      if (nodeMax > max || (nodeMax === max && nodeLeft < maxLeft)) {
        max = nodeMax;
        maxNode = node;
        maxLeft = nodeLeft;
      }
      if (rowTree.volumes) volume += rowTree.volumes[node]!;
    };

    while (left <= right) {
      if ((left & 1) === 1) consume(left++);
      if ((right & 1) === 0) consume(right--);
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
      span *= 2;
    }
    return {
      min,
      max,
      minIndex: extremaLeafIndex(rowTree, minNode, true),
      maxIndex: extremaLeafIndex(rowTree, maxNode, false),
      volume,
      count,
    };
  }

  private scalarRange(start: number, end: number, count: number): RangeStats {
    const tree = this.scalarTree!;
    const columns = this.columns;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let minIndex = -1;
    let maxIndex = -1;
    const consume = (index: number, value: number): void => {
      if (minIndex < 0 || value < min || (value === min && index < minIndex)) {
        min = value;
        minIndex = index;
      }
      if (maxIndex < 0 || value > max || (value === max && index < maxIndex)) {
        max = value;
        maxIndex = index;
      }
    };
    const scan = (first: number, last: number): void => {
      for (let row = first; row <= last; row += 1) {
        if (columns.present[row] === 1) consume(row, columns.values[row]!);
      }
    };
    const firstBlock = Math.ceil(start / tree.blockWidth);
    const lastBlock = Math.floor((end + 1) / tree.blockWidth) - 1;
    if (firstBlock > lastBlock) {
      scan(start, end);
    } else {
      scan(start, firstBlock * tree.blockWidth - 1);
      scan((lastBlock + 1) * tree.blockWidth, end);
      let left = tree.blockCapacity + firstBlock;
      let right = tree.blockCapacity + lastBlock;
      while (left <= right) {
        if ((left & 1) === 1) {
          const index = tree.minIndices[left]!;
          if (index >= 0) consume(index, tree.mins[left]!);
          const maxRow = tree.maxIndices[left]!;
          if (maxRow >= 0) consume(maxRow, tree.maxes[left]!);
          left += 1;
        }
        if ((right & 1) === 0) {
          const index = tree.minIndices[right]!;
          if (index >= 0) consume(index, tree.mins[right]!);
          const maxRow = tree.maxIndices[right]!;
          if (maxRow >= 0) consume(maxRow, tree.maxes[right]!);
          right -= 1;
        }
        left = Math.floor(left / 2);
        right = Math.floor(right / 2);
      }
    }
    return {
      min: columns.values[minIndex]!,
      max: columns.values[maxIndex]!,
      minIndex,
      maxIndex,
      volume: 0,
      count,
    };
  }

  bandRange(from: number, to: number): BandRangeStats | null {
    if (!this.bandTree) return null;
    const clipped = clippedIndices(from, to, this._length);
    if (clipped === null) return null;
    const rowTree = this.tree!;
    const count = rowTree.prefixCounts[clipped[1] + 1]! - rowTree.prefixCounts[clipped[0]]!;
    if (count === 0) return null;
    let left = this.bandTree.capacity + clipped[0];
    let right = this.bandTree.capacity + clipped[1];
    let lowerMin = Number.POSITIVE_INFINITY;
    let lowerMax = Number.NEGATIVE_INFINITY;
    let upperMin = Number.POSITIVE_INFINITY;
    let upperMax = Number.NEGATIVE_INFINITY;
    let lowerMinNode = -1;
    let lowerMinLeft = Number.POSITIVE_INFINITY;
    let lowerMaxIndex = -1;
    let upperMinIndex = -1;
    let upperMaxNode = -1;
    let upperMaxLeft = Number.POSITIVE_INFINITY;
    let span = 1;

    const takeMin = (value: number, index: number, current: number, currentIndex: number) =>
      value < current || (value === current && (currentIndex < 0 || index < currentIndex));
    const takeMax = (value: number, index: number, current: number, currentIndex: number) =>
      value > current || (value === current && (currentIndex < 0 || index < currentIndex));
    const consume = (node: number): void => {
      const nodeLowerMin = rowTree.mins[node]!;
      if (nodeLowerMin === Number.POSITIVE_INFINITY) return;
      const nodeLeft = node * span - rowTree.capacity;
      const tree = this.bandTree!;
      const nodeUpperMax = rowTree.maxes[node]!;
      const nodeLowerMaxIndex = tree.lowerMaxIndices[node]!;
      const nodeLowerMax = this.columns.lowers![nodeLowerMaxIndex]!;
      const nodeUpperMinIndex = tree.upperMinIndices[node]!;
      const nodeUpperMin = this.columns.uppers![nodeUpperMinIndex]!;
      if (nodeLowerMin < lowerMin || (nodeLowerMin === lowerMin && nodeLeft < lowerMinLeft)) {
        lowerMin = nodeLowerMin;
        lowerMinNode = node;
        lowerMinLeft = nodeLeft;
      }
      if (takeMax(nodeLowerMax, nodeLowerMaxIndex, lowerMax, lowerMaxIndex)) {
        lowerMax = nodeLowerMax;
        lowerMaxIndex = nodeLowerMaxIndex;
      }
      if (takeMin(nodeUpperMin, nodeUpperMinIndex, upperMin, upperMinIndex)) {
        upperMin = nodeUpperMin;
        upperMinIndex = nodeUpperMinIndex;
      }
      if (nodeUpperMax > upperMax || (nodeUpperMax === upperMax && nodeLeft < upperMaxLeft)) {
        upperMax = nodeUpperMax;
        upperMaxNode = node;
        upperMaxLeft = nodeLeft;
      }
    };

    while (left <= right) {
      if ((left & 1) === 1) consume(left++);
      if ((right & 1) === 0) consume(right--);
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
      span *= 2;
    }
    return {
      lowerMin,
      lowerMax,
      upperMin,
      upperMax,
      lowerMinIndex: extremaLeafIndex(rowTree, lowerMinNode, true),
      lowerMaxIndex,
      upperMinIndex,
      upperMaxIndex: extremaLeafIndex(rowTree, upperMaxNode, false),
      count,
    };
  }

  segments(from: number, to: number): Array<{ from: number; to: number }> {
    const clipped = clippedIndices(from, to, this._length);
    if (clipped === null) return [];
    const result: Array<{ from: number; to: number }> = [];
    let start = -1;
    for (let index = clipped[0]; index <= clipped[1]; index += 1) {
      if (this.columns.present[index] === 1) {
        if (start < 0) start = index;
      } else if (start >= 0) {
        result.push({ from: start, to: index - 1 });
        start = -1;
      }
    }
    if (start >= 0) result.push({ from: start, to: clipped[1] });
    return result;
  }

  private hasValueAt(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this._length && this.columns.present[index] === 1;
  }

  private readBandColumn(column: Float64Array | null, index: number): number {
    return this.hasValueAt(index) && isBandType(this.type) ? column![index]! : Number.NaN;
  }

  private readCandleColumn(column: Float64Array | null, index: number): number {
    return this.hasValueAt(index) && isCandleType(this.type) ? column![index]! : Number.NaN;
  }
}

/** @internal Creates a fresh store only after all owned-column checks and indexes succeed. */
export function createOwnedStudyStore(
  type: SeriesType,
  domain: TimeDomain,
  points: readonly { time: number }[],
  input: OwnedStudyColumnInput,
): SeriesStore {
  const store = new SeriesStore(type, domain);
  store[ownedStudyIngest](points, input);
  return store;
}

/** @internal Only accepts the operation-owned fresh candle candidate of the built-in chart bridge. */
export function createOwnedVolumeStoreFromPrice(source: SeriesStore): SeriesStore {
  if (!(source instanceof SeriesStore) || source.type !== 'candlestick' || source.domain !== 'utc-ms')
    throw new ChartError('INVALID_DATA', 'Owned volume requires a fresh UTC candlestick source');
  return source[deriveOwnedVolume]();
}
