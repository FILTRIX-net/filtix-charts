// Independent validator for installed v0.11 terminal-grid evidence.
import { createHash } from 'node:crypto';
import { verifyGridDrawingPaint } from './grid-drawing-oracle.mjs';
import { assessEndpoint, expectationForEndpoint } from './grid-resource-readiness.mjs';
import {
  GRID_DRAWING_MIX,
  GRID_SEED,
  buildGridScene,
  GRID_PROVIDER_ID,
  compareFinite,
  expectedCheckpoint,
  replayGridRows,
  fillSeriesId,
  sha256Rows,
  studySeriesId,
} from './grid-oracle.mjs';

const ARCHIVE_NAMES = Object.freeze([
  '@filtix/analysis',
  '@filtix/alerts',
  '@filtix/charts',
  '@filtix/core',
  '@filtix/datafeed',
  '@filtix/drawings',
  '@filtix/indicators',
  '@filtix/react',
  '@filtix/terminal',
]);
const INTERNAL_NAMES = new Set(['@filtix/alerts', '@filtix/charts', '@filtix/indicators']);
const CELL_IDS = Object.freeze(['cell-1', 'cell-2', 'cell-3', 'cell-4']);
const MAXIMUM_IDS = Object.freeze([
  'max-construction-1',
  'max-construction-2',
  'max-construction-3',
  'max-restore-1',
  'max-restore-2',
  'max-restore-3',
  'max-replacements',
  'max-append-replacements',
  'max-interactions',
  'max-sync-exact',
  'max-sync-nearest',
  'max-soak',
]);
const MAXIMUM_WITHOUT_SOAK = MAXIMUM_IDS.slice(0, -1);
const FULL_IDS = Object.freeze([
  'full-initial-setup',
  'full-tail-replacement',
  'full-append-255-to-256',
  'full-drawing-edit',
  'full-study-parameter-edit',
  'full-pane-edit',
  'full-market-switch',
  'full-interval-switch',
  'full-parked-once-crossing-remount',
  'full-save-restore',
  'full-zero-size-recovery',
  'full-final-mounted',
]);
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value) => finite(value) && value >= 0;
const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const archiveMemberPaths = (name) => {
  const base = [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/index.d.ts',
  ];
  if (INTERNAL_NAMES.has(name))
    base.push('package/dist/internal.js', 'package/dist/internal.js.map', 'package/dist/internal.d.ts');
  return base.sort();
};
const queryKey = (query) => JSON.stringify([query?.symbol, query?.interval]);
const checkpointPrefix = (checkpoint) =>
  checkpoint?.mutationPrefix ?? checkpoint?.expected?.cells?.[0]?.source?.mutationPrefix;

function nearestRank(values, q) {
  if (!Array.isArray(values) || values.length === 0 || !values.every(nonnegative)) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
}
function meetsPercentile(values, p95, p99, { strict95 = false } = {}) {
  const p95Value = nearestRank(values, 0.95);
  const p99Value = p99 === null ? null : nearestRank(values, 0.99);
  return (
    p95Value !== null &&
    (strict95 ? p95Value < p95 : p95Value <= p95) &&
    (p99 === null || (p99Value !== null && p99Value <= p99))
  );
}
function expect(condition, errors, message) {
  if (!condition) errors.push(message);
}
function validQuery(query) {
  return (
    typeof query?.symbol === 'string' &&
    query.symbol.length > 0 &&
    typeof query?.interval === 'string' &&
    query.interval.length > 0
  );
}

function trustedIdentityErrors(identity, trusted) {
  const errors = [];
  if (!trusted || !trusted.source || !trusted.installRecord || !trusted.installed) {
    errors.push(
      'trusted expectedIdentity from sourceIdentity/installRecord/verifyConsumerIdentity is required',
    );
    return errors;
  }
  const source = trusted.source;
  const installRecord = trusted.installRecord;
  const installed = trusted.installed;
  const reportedInstallRecord = identity?.installRecord ?? identity?.installRecordRecord;
  expect(SHA40.test(source.commit ?? ''), errors, 'trusted source commit is invalid');
  expect(Array.isArray(source.dirty) && source.dirty.length === 0, errors, 'trusted source is not clean');
  expect(
    Array.isArray(source.files) &&
      source.files.length > 0 &&
      source.files.every((item) => SHA64.test(item.sha256 ?? '')),
    errors,
    'trusted source file identities are incomplete',
  );
  expect(identity?.sourceCommit === source.commit, errors, 'source commit differs from trusted identity');
  expect(
    identity?.sourceSha256 === digest(JSON.stringify(source)),
    errors,
    'source identity hash differs from trusted identity',
  );
  expect(
    same(identity?.sourceFiles, source.files),
    errors,
    'source file identities differ from trusted identity',
  );
  const trustedIdentityFiles = new Map(
    (installed.identities ?? []).map((item) => [item.path.replaceAll('\\', '/'), item.sha256]),
  );
  const installPointer = 'benchmark-results/v0.11/consumer-install.json';
  expect(
    identity?.installRecordSha256 === trustedIdentityFiles.get(installPointer),
    errors,
    'install record bytes differ from trusted installed identity',
  );
  expect(
    same(reportedInstallRecord, installRecord),
    errors,
    'parsed install record provenance differs from trusted identity',
  );
  expect(
    identity?.installRecordPath === installPointer,
    errors,
    'install record path differs from accepted v0.11 pointer',
  );
  expect(identity?.installed === true, errors, 'installed consumer provenance is missing');
  expect(identity?.sourceAliases === false, errors, 'source alias exclusion is missing');
  expect(
    identity?.consumerRoot === 'examples/react-terminal',
    errors,
    'installed consumer root is incorrect',
  );
  expect(
    installed?.sourceCommit === source.commit,
    errors,
    'verified installed commit differs from trusted source',
  );
  expect(
    installed?.archives === 9 && installed?.members === 45,
    errors,
    'trusted installed cohort is not nine archives and 45 members',
  );
  const expectedArchives = installRecord.archives;
  expect(
    Array.isArray(expectedArchives) && expectedArchives.length === 9,
    errors,
    'trusted install record must contain nine archives',
  );
  if (
    !Array.isArray(identity?.archives) ||
    identity.archives.length !== 9 ||
    !Array.isArray(expectedArchives)
  ) {
    errors.push('evidence archive identities are incomplete');
  } else {
    const byName = new Map(identity.archives.map((archive) => [archive.name, archive]));
    const expectedByName = new Map(expectedArchives.map((archive) => [archive.name, archive]));
    expect(
      same([...byName.keys()].sort(), [...expectedByName.keys()].sort()),
      errors,
      'archive names differ from trusted install record',
    );
    expect(
      same([...byName.keys()].sort(), [...ARCHIVE_NAMES].sort()),
      errors,
      'archive inventory is not the exact nine-package cohort',
    );
    const verifiedFiles = trustedIdentityFiles;
    let memberTotal = 0;
    for (const name of ARCHIVE_NAMES) {
      const got = byName.get(name);
      const expected = expectedByName.get(name);
      if (!got || !expected) continue;
      expect(
        got.sha256 === expected.sha256 && SHA64.test(got.sha256 ?? ''),
        errors,
        `${name} archive hash differs from trusted install record`,
      );
      const expectedRelativePath = String(expected.path ?? '')
        .replaceAll('\\', '/')
        .split('/')
        .slice(-3)
        .join('/');
      expect(
        got.path === expectedRelativePath,
        errors,
        `${name} archive path differs from trusted install record`,
      );
      const required = archiveMemberPaths(name);
      const expectedMembers = expected.members;
      expect(
        Array.isArray(expectedMembers) && expectedMembers.length === required.length,
        errors,
        `${name} trusted archive member inventory is incomplete`,
      );
      expect(
        Array.isArray(got.members) && got.members.length === required.length,
        errors,
        `${name} archive evidence member inventory is incomplete`,
      );
      const members = new Map((got.members ?? []).map((item) => [item.path, item]));
      const trustedMembers = new Map((expectedMembers ?? []).map((item) => [item.path, item]));
      for (const memberPath of required) {
        const item = members.get(memberPath);
        const trustedMember = trustedMembers.get(memberPath);
        memberTotal++;
        expect(item && trustedMember, errors, `${name} missing member ${memberPath}`);
        if (!item || !trustedMember) continue;
        expect(
          item.archiveSha256 === trustedMember.sha256 && SHA64.test(item.archiveSha256 ?? ''),
          errors,
          `${name}/${memberPath} archive member hash differs from trusted bytes`,
        );
        const installedPath = `examples/react-terminal/node_modules/${name}/${memberPath.slice('package/'.length)}`;
        expect(
          item.installedSha256 === item.archiveSha256 &&
            item.installedSha256 === verifiedFiles.get(installedPath),
          errors,
          `${name}/${memberPath} installed bytes differ from trusted consumer identity`,
        );
      }
    }
    expect(memberTotal === 45, errors, 'exact 45 archive/installed member identities are required');
  }
  const verifications = identity?.verifications;
  expect(
    Array.isArray(verifications) && verifications.length >= 2,
    errors,
    'before/after source and install identity verification records are required',
  );
  if (Array.isArray(verifications)) {
    const before = verifications.find((item) => item.phase === 'before');
    const after = verifications.find((item) => item.phase === 'after');
    expect(Boolean(before && after), errors, 'before and after identity verification phases are required');
    for (const item of [before, after].filter(Boolean)) {
      expect(
        item.sourceCommit === source.commit && item.sourceSha256 === digest(JSON.stringify(source)),
        errors,
        `${item.phase} identity verification does not match trusted source`,
      );
      expect(
        item.archivesSha256 === digest(JSON.stringify(identity.archives)) && finite(item.at),
        errors,
        `${item.phase} verification timestamp/archive hash missing`,
      );
    }
    if (before && after)
      expect(
        after.at >= before.at &&
          after.sourceCommit === before.sourceCommit &&
          after.sourceSha256 === before.sourceSha256 &&
          after.archivesSha256 === before.archivesSha256,
        errors,
        'source/install identity changed during collection',
      );
  }
  return errors;
}

function sameOracleState(actual, expected) {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => sameOracleState(actual[index], item))
    );
  if (!expected || typeof expected !== 'object') return same(actual, expected);
  if (!actual || typeof actual !== 'object') return false;
  const candidate = { ...actual };
  if (expected.occurrence && !own(expected, 'observedAt')) delete candidate.observedAt;
  return (
    same(
      Object.keys(candidate)
        .filter((key) => candidate[key] !== undefined)
        .sort(),
      Object.keys(expected)
        .filter((key) => expected[key] !== undefined)
        .sort(),
    ) && Object.entries(expected).every(([key, value]) => sameOracleState(candidate[key], value))
  );
}

function stripEventClocks(value) {
  if (Array.isArray(value)) return value.map(stripEventClocks);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'observedAt')
      .map(([key, item]) => [key, stripEventClocks(item)]),
  );
}

function validateScene(record, errors, modes) {
  const scene = record.scene;
  expect(scene?.providerId === GRID_PROVIDER_ID, errors, 'fixed workload provider identity is missing');
  expect(
    scene?.host?.width === 1600 && scene?.host?.height === 1000 && scene?.layout === 4,
    errors,
    'maximum scene must use 1600x1000 host and layout4',
  );
  expect(scene?.monitorQueryCount === 8, errors, 'scene must retain eight exact monitor query feeds');
  for (const [mode, count] of [
    ['maximum', 100_000],
    ['full', 256],
  ]) {
    if (!modes.has(mode)) continue;
    const scope = scene?.scopes?.[mode];
    expect(scope?.seed === GRID_SEED, errors, `${mode} fixed deterministic seed must be 20260922`);
    const reference = buildGridScene({ rowsPerCell: count });
    expect(
      Array.isArray(scope?.cells) && scope.cells.length === 4,
      errors,
      `${mode} scene must contain four cell definitions`,
    );
    expect(
      Array.isArray(scope?.sourceRows) && scope.sourceRows.length === 4,
      errors,
      `${mode} complete source row arrays are missing`,
    );
    expect(
      Array.isArray(scope?.monitorSources) && scope.monitorSources.length === 8,
      errors,
      `${mode} eight monitor source baselines are missing`,
    );
    const cells = scope?.cells ?? [];
    const ids = cells.map((cell) => cell.id);
    expect(same(ids, CELL_IDS), errors, `${mode} cell identity/order must be cell-1 through cell-4`);
    expect(
      new Set(cells.map((cell) => queryKey(cell.query))).size === 4 &&
        cells.every((cell) => validQuery(cell.query)),
      errors,
      `${mode} requires four distinct exact chart queries`,
    );
    for (const cell of cells) {
      const referenceCell = reference.cells.find((item) => item.id === cell.id);
      expect(
        referenceCell &&
          same(cell.query, referenceCell.query) &&
          same(cell.studies, referenceCell.studies) &&
          same(cell.drawings, referenceCell.drawings) &&
          same(cell.alerts, referenceCell.alerts) &&
          same(cell.workspace, referenceCell.workspace),
        errors,
        `${mode} ${cell.id} fixed initial query/studies/drawings/alerts/workspace differs`,
      );
      expect(cell.rowsPerCell === count, errors, `${mode} ${cell.id} row count must be ${count}`);
      expect(
        cell.seriesCount === 12 && cell.paneCount === 4,
        errors,
        `${mode} ${cell.id} must contain 12 series/four panes`,
      );
      expect(
        Array.isArray(cell.studies) && cell.studies.length === 5,
        errors,
        `${mode} ${cell.id} must contain the five fixed studies`,
      );
      const kinds = (cell.studies ?? []).map((study) => study.kind).sort();
      expect(
        same(kinds, ['bollinger', 'ema', 'macd', 'rsi', 'sma']),
        errors,
        `${mode} ${cell.id} study kinds are incomplete`,
      );
      expect(
        cell.drawingCount === 50 && cell.drawings?.drawings?.length === 50,
        errors,
        `${mode} ${cell.id} must retain 50 drawing documents`,
      );
      const mix = Object.fromEntries(
        Object.entries(GRID_DRAWING_MIX).map(([type]) => [
          type,
          cell.drawings?.drawings?.filter((drawing) => drawing.type === type).length,
        ]),
      );
      expect(same(mix, GRID_DRAWING_MIX), errors, `${mode} ${cell.id} drawing type composition is incorrect`);
      expect(
        cell.alertCount === 25 && cell.alerts?.alerts?.length === 25,
        errors,
        `${mode} ${cell.id} must retain one 25-rule alert document`,
      );
      const alerts = cell.alerts?.alerts ?? [];
      expect(
        alerts.filter((item) => item.status === 'armed' && item.frequency === 'repeat').length === 16,
        errors,
        `${mode} ${cell.id} requires16 armed repeat rules`,
      );
      expect(
        alerts.filter((item) => item.status === 'armed' && item.frequency === 'once').length === 4,
        errors,
        `${mode} ${cell.id} requires4 armed once rules`,
      );
      expect(
        alerts.filter((item) => item.status === 'paused').length === 3,
        errors,
        `${mode} ${cell.id} requires3 paused rules`,
      );
      expect(
        alerts.filter((item) => item.status === 'triggered' && item.frequency === 'once').length === 2,
        errors,
        `${mode} ${cell.id} requires2 prior triggered once rules`,
      );
      expect(
        cell.workspace?.alerts?.alerts?.length === 25 && same(cell.workspace.alerts, cell.alerts),
        errors,
        `${mode} ${cell.id} saved workspace alerts must match the actual alert document`,
      );
      expect(
        same(cell.workspace?.studies, cell.studies),
        errors,
        `${mode} ${cell.id} workspace studies differ from scene studies`,
      );
    }
    const sourceRows = scope?.sourceRows ?? [];
    for (const cell of cells) {
      const source = sourceRows.find((item) => item.cellId === cell.id);
      expect(
        Array.isArray(source?.rows) && source.rows.length === count,
        errors,
        `${mode} ${cell.id} full deterministic source rows are missing`,
      );
      if (Array.isArray(source?.rows)) {
        const bars = source.rows;
        expect(
          sha256Rows(bars) === sha256Rows(reference.cells.find((item) => item.id === cell.id)?.rows ?? []),
          errors,
          `${mode} ${cell.id} full source differs from fixed deterministic generator`,
        );
        expect(
          bars.every((bar) =>
            ['time', 'open', 'high', 'low', 'close', 'volume'].every((field) => finite(bar[field])),
          ),
          errors,
          `${mode} ${cell.id} source has missing/nonfinite OHLCV values`,
        );
        expect(
          bars.every((bar, index) => index === 0 || bar.time > bars[index - 1].time),
          errors,
          `${mode} ${cell.id} source times must be strictly increasing`,
        );
      }
    }
    expect(Array.isArray(scope?.mutations), errors, `${mode} ordered source mutation log is missing`);
    if (Array.isArray(scope?.mutations)) {
      expect(
        scope.mutations.every(
          (item, index) =>
            item.sequence === index &&
            typeof item.checkpointId === 'string' &&
            typeof item.operation === 'string',
        ),
        errors,
        `${mode} mutation log ordering/identity is invalid`,
      );
      for (const item of scope.mutations) {
        if (item.operation === 'replace' || item.operation === 'append')
          expect(
            CELL_IDS.includes(item.cellId) &&
              item.bar &&
              ['time', 'open', 'high', 'low', 'close', 'volume'].every((field) => finite(item.bar[field])),
            errors,
            `${mode} ordered ${item.operation} mutation must carry finite bar and cell identity`,
          );
        if (item.operation === 'source-reset')
          expect(
            CELL_IDS.includes(item.cellId) &&
              Number.isInteger(item.rowCount) &&
              item.rowCount > 0 &&
              item.rowCount <= count,
            errors,
            `${mode} source reset must record an explicit row count`,
          );
      }
    }
    expect(
      same(scope?.monitorSources, reference.monitorSources) &&
        same(scope?.alternateSources ?? [], reference.alternateSources),
      errors,
      `${mode} independent monitor/alternate source fixtures differ`,
    );
    expect(
      scope?.monitorSources?.every(
        (source) =>
          validQuery(source.query) &&
          Array.isArray(source.rows) &&
          source.rows.length >= 1 &&
          source.rows.every((bar) => finite(bar.time) && finite(bar.close)),
      ),
      errors,
      `${mode} monitor source baselines are invalid`,
    );
    const keys = new Set((scope?.monitorSources ?? []).map((source) => queryKey(source.query)));
    expect(keys.size === 8, errors, `${mode} monitor source query keys must be unique`);
    if (mode === 'full') {
      const alternatives = scope?.alternateSources;
      expect(
        Array.isArray(alternatives) && alternatives.length >= 2,
        errors,
        'full pass market/interval switch destination source fixtures are missing',
      );
      for (const item of alternatives ?? [])
        expect(
          Array.isArray(item.rows) &&
            item.rows.length === 256 &&
            item.drawings?.drawings?.length === 50 &&
            item.alerts?.alerts?.length === 25 &&
            item.workspace?.query?.symbol === item.query?.symbol &&
            item.workspace?.query?.interval === item.query?.interval,
          errors,
          'full alternate query fixture must have256 rows,50 drawings,25 alerts and matching workspace',
        );
    }
  }
}

function reconstructScene(scene, mode) {
  const scope = scene.scopes[mode];
  const sources = new Map(scope.sourceRows.map((item) => [item.cellId, item.rows]));
  return {
    rowsPerCell: mode === 'maximum' ? 100_000 : 256,
    seed: scope.seed,
    cells: scope.cells.map((cell) => ({ ...cell, rows: sources.get(cell.id) })),
    sourceRows: scope.sourceRows,
    monitorSources: scope.monitorSources,
    alternateSources: scope.alternateSources ?? [],
    mutations: scope.mutations,
    gridWorkspace: scene.gridWorkspace,
  };
}

function projectionPoint(observation, drawingId, pointIndex) {
  return observation?.projection?.anchors?.find(
    (item) => item.sourceId === drawingId && item.pointIndex === pointIndex,
  );
}
function projectedPriceY(observation, paneId, price) {
  const basis = observation?.projection?.priceBasis?.[paneId];
  if (
    !Array.isArray(basis) ||
    basis.length < 2 ||
    !basis.every((point) => finite(point.price) && finite(point.y)) ||
    !finite(price)
  )
    return null;
  const [first, second] = basis;
  if (first.price === second.price) return null;
  const pane = observation.projection.panes?.find((item) => item.id === paneId);
  const ratio =
    pane?.scale === 'log' && first.price > 0 && second.price > 0 && price > 0
      ? (Math.log(price) - Math.log(first.price)) / (Math.log(second.price) - Math.log(first.price))
      : (price - first.price) / (second.price - first.price);
  return first.y + ratio * (second.y - first.y);
}
function validateDrawingCell(expected, observed, errors, label) {
  const document = observed?.drawings?.document;
  const geometry = observed?.drawings?.geometry;
  const observation = observed?.drawingObservation;
  expect(
    same(document, expected.drawings.document),
    errors,
    `${label} drawing document differs from independently expected state`,
  );
  expect(
    Array.isArray(geometry) && geometry.length === 50,
    errors,
    `${label} drawing geometry must cover all50 objects`,
  );
  expect(
    Array.isArray(observation?.groups) && observation.groups.length === 50,
    errors,
    `${label} actual Canvas commands must cover all50 objects`,
  );
  expect(
    Array.isArray(observation?.projection?.panes) && observation.projection.panes.length >= 1,
    errors,
    `${label} actual drawing projection panes are missing`,
  );
  try {
    verifyGridDrawingPaint(expected.drawings.document, observation);
  } catch (failure) {
    errors.push(`${label} actual Canvas paint differs: ${failure.message}`);
  }
  const expectedRows = expected.drawings.geometry;
  expect(
    same(
      observation?.projection?.panes?.map((item) => item.id),
      expected.workspace.layout.panes.map((item) => item.id),
    ),
    errors,
    `${label} actual pane identities differ from saved topology`,
  );
  const actualRows = new Map((geometry ?? []).map((item) => [item.id, item]));
  const actualGroups = new Map((observation?.groups ?? []).map((item) => [item.sourceId, item]));
  expect(
    actualRows.size === 50 && actualGroups.size === 50,
    errors,
    `${label} unique drawing geometry/paint identities missing`,
  );
  for (const exp of expectedRows) {
    const got = actualRows.get(exp.id);
    const group = actualGroups.get(exp.id);
    expect(Boolean(got && group), errors, `${label} drawing geometry/Canvas group missing: ${exp.id}`);
    if (!got || !group) continue;
    expect(
      got.type === exp.type && got.paneId === exp.paneId && got.visible === exp.visible,
      errors,
      `${label} drawing identity differs: ${exp.id}`,
    );
    expect(
      group.sourceIndex === expectedRows.findIndex((item) => item.id === exp.id),
      errors,
      `${label} Canvas source index differs: ${exp.id}`,
    );
    expect(
      Array.isArray(group.calls) && (exp.visible ? group.calls.length > 0 : group.calls.length === 0),
      errors,
      `${label} visible drawing Canvas commands missing: ${exp.id}`,
    );
    expect(
      (group.calls ?? []).every(
        (call) =>
          ['stroke', 'fill', 'strokeRect', 'fillRect', 'fillText', 'arc'].includes(call.method) &&
          Array.isArray(call.args) &&
          call.args.every((value) => typeof value !== 'number' || finite(value)) &&
          (!call.path || call.path.every((step) => Array.isArray(step) && step.slice(1).every(finite))),
      ),
      errors,
      `${label} invalid/nonfinite Canvas command evidence: ${exp.id}`,
    );
    expect(
      Array.isArray(got.anchors) && got.anchors.length === exp.anchors.length,
      errors,
      `${label} drawing anchor count differs: ${exp.id}`,
    );
    for (let index = 0; index < exp.anchors.length; index++) {
      const want = exp.anchors[index];
      const actual = got.anchors?.[index];
      const projected = projectionPoint(observation, exp.id, index);
      expect(
        actual?.time === want.time && actual?.price === want.price && finite(actual?.x) && finite(actual?.y),
        errors,
        `${label} drawing anchor source/coordinates invalid: ${exp.id}/${index}`,
      );
      expect(
        Boolean(projected) &&
          actual?.x === projected?.x &&
          actual?.y === projected?.y &&
          projected?.time === want.time &&
          projected?.price === want.price,
        errors,
        `${label} drawing anchor disagrees with actual chart projection: ${exp.id}/${index}`,
      );
    }
    expect(
      Array.isArray(got.fibLevels) && got.fibLevels.length === exp.fibLevels.length,
      errors,
      `${label} Fibonacci levels missing: ${exp.id}`,
    );
    for (let index = 0; index < exp.fibLevels.length; index++) {
      const want = exp.fibLevels[index];
      const actual = got.fibLevels?.[index];
      expect(
        actual?.ratio === want.ratio && compareFinite(actual?.price, want.price),
        errors,
        `${label} Fibonacci level ratio/price differs: ${exp.id}/${index}`,
      );
      const y = projectedPriceY(observation, exp.paneId, want.price);
      expect(
        y !== null && compareFinite(actual?.y, y),
        errors,
        `${label} Fibonacci level projection differs: ${exp.id}/${index}`,
      );
    }
    if (exp.text) {
      expect(
        got.text?.content === exp.text.content &&
          got.text?.lineCount === exp.text.lineCount &&
          got.text?.fontSize === exp.text.fontSize,
        errors,
        `${label} text note content/line/font evidence differs: ${exp.id}`,
      );
      const anchor = got.anchors?.[0];
      const metrics = observation?.projection?.textMetrics?.[exp.id];
      expect(
        anchor &&
          got.text.anchorX === anchor.x &&
          got.text.anchorY === anchor.y &&
          Array.isArray(metrics) &&
          metrics.length === exp.text.lineCount &&
          metrics.every(nonnegative),
        errors,
        `${label} text note measured bounds evidence missing: ${exp.id}`,
      );
      const expectedBounds =
        anchor && Array.isArray(metrics)
          ? {
              left: anchor.x,
              top: anchor.y,
              right: anchor.x + Math.max(12, ...metrics) + 12,
              bottom: anchor.y + exp.text.lineCount * exp.text.fontSize * 1.25 + 12,
            }
          : null;
      expect(
        expectedBounds && same(got.text.bounds, expectedBounds),
        errors,
        `${label} text note bounds differ from measured text: ${exp.id}`,
      );
      expect(
        got.text.bounds &&
          ['left', 'top', 'right', 'bottom'].every((key) => finite(got.text.bounds[key])) &&
          got.text.bounds.right >= got.text.bounds.left &&
          got.text.bounds.bottom >= got.text.bounds.top,
        errors,
        `${label} text note bounds are invalid: ${exp.id}`,
      );
    } else expect(got.text === null, errors, `${label} non-text drawing contains text geometry: ${exp.id}`);
  }
}

function checkRendered(expected, observed, errors, label) {
  const points = observed?.rendered;
  expect(
    Array.isArray(points) && points.length === expected.rendered.length,
    errors,
    `${label} rendered observation count incomplete`,
  );
  if (!Array.isArray(points)) return;
  expect(
    same(
      points.map((point) => point.index),
      expected.rendered.map((point) => point.index),
    ),
    errors,
    `${label} rendered indices differ from fixed scope`,
  );
  const byStudy = new Map(expected.studies.map((study) => [study.kind, study]));
  for (let n = 0; n < expected.rendered.length; n++) {
    const want = expected.rendered[n];
    const got = points[n];
    if (!got) continue;
    expect(
      got.index === want.index && got.time === want.time,
      errors,
      `${label} rendered sample index/time mismatch`,
    );
    const price = got.points?.['terminal-price'];
    expect(
      price &&
        price.time === want.time &&
        ['open', 'high', 'low', 'close', 'volume'].every((field) =>
          compareFinite(price[field], want.ohlcv[field]),
        ),
      errors,
      `${label} rendered OHLCV differs at ${want.index}`,
    );
    const volume = got.points?.['terminal-volume'];
    expect(
      volume && volume.time === want.time && compareFinite(volume.value, want.ohlcv.volume),
      errors,
      `${label} rendered volume series differs at ${want.index}`,
    );
    for (const kind of ['sma', 'ema', 'rsi']) {
      const study = byStudy.get(kind);
      const point = got.points?.[studySeriesId(study, 'value')];
      const value = want.studies[kind];
      const valid =
        value === null
          ? point == null || point.value === undefined
          : point && point.time === want.time && compareFinite(point.value, value);
      expect(valid, errors, `${label} ${kind} output/missingness differs at ${want.index}`);
    }
    const macd = byStudy.get('macd');
    for (const [key, output] of [
      ['line', 'macd'],
      ['signal', 'signal'],
      ['histogram', 'histogram'],
    ]) {
      const point = got.points?.[studySeriesId(macd, key === 'line' ? 'macd' : output)];
      const value = want.studies.macd[key];
      const valid =
        value === null
          ? point == null || point.value === undefined
          : point && point.time === want.time && compareFinite(point.value, value);
      expect(valid, errors, `${label} MACD ${key} output/missingness differs at ${want.index}`);
    }
    const bollinger = byStudy.get('bollinger');
    for (const output of ['middle', 'upper', 'lower']) {
      const point = got.points?.[studySeriesId(bollinger, output)];
      const value = want.studies.bollinger[output];
      const valid =
        value === null
          ? point == null || point.value === undefined
          : point && point.time === want.time && compareFinite(point.value, value);
      expect(valid, errors, `${label} Bollinger ${output} output/missingness differs at ${want.index}`);
    }
    const fill = got.points?.[fillSeriesId(bollinger)];
    if (want.fill.upper === null || want.fill.lower === null)
      expect(
        fill == null || (fill.upper === undefined && fill.lower === undefined),
        errors,
        `${label} native Bollinger fill warmup mismatch at ${want.index}`,
      );
    else
      expect(
        fill &&
          fill.time === want.time &&
          compareFinite(fill.upper, want.fill.upper) &&
          compareFinite(fill.lower, want.fill.lower),
        errors,
        `${label} native Bollinger fill boundaries differ at ${want.index}`,
      );
    const ids = Object.keys(got.points ?? {}).sort();
    const expectedIds = [
      'terminal-price',
      'terminal-volume',
      studySeriesId(byStudy.get('sma'), 'value'),
      studySeriesId(byStudy.get('ema'), 'value'),
      studySeriesId(byStudy.get('rsi'), 'value'),
      ...['macd', 'signal', 'histogram'].map((name) => studySeriesId(macd, name)),
      ...['middle', 'upper', 'lower'].map((name) => studySeriesId(bollinger, name)),
      fillSeriesId(bollinger),
    ].sort();
    expect(same(ids, expectedIds), errors, `${label} actual series IDs do not include all12 outputs`);
  }
}

function validateCheckpoints(record, errors, modes, requestedMode) {
  const receipts = new Map();
  const collectReceipt = (item) => {
    if (item?.id && finite(item.dispatchedAt)) receipts.set(item.id, item);
    for (const field of ['one', 'four', 'receipt', 'parked', 'remounted', 'setup'])
      if (item?.[field]) collectReceipt(item[field]);
  };
  for (const items of Object.values(record.actions ?? {}))
    if (Array.isArray(items)) items.forEach(collectReceipt);
  const cps = record.checkpoints;
  expect(Array.isArray(cps), errors, 'checkpoint array is required');
  if (!Array.isArray(cps)) return;
  const ids = cps.map((item) => item.id);
  expect(new Set(ids).size === ids.length, errors, 'checkpoint IDs must be unique');
  const expectedIds = [];
  if (modes.has('maximum'))
    expectedIds.push(...(requestedMode === 'max' ? MAXIMUM_WITHOUT_SOAK : MAXIMUM_IDS));
  if (modes.has('full')) expectedIds.push(...FULL_IDS);
  expect(same(ids, expectedIds), errors, 'named checkpoints must follow the exact collection order');
  for (const id of expectedIds) expect(ids.includes(id), errors, `required named checkpoint missing: ${id}`);
  for (const id of ids)
    expect(
      expectedIds.includes(id) || requestedMode === 'soak' || requestedMode === 'capacity',
      errors,
      `unsupported checkpoint scope/ID: ${id}`,
    );
  const observedCells = cps.flatMap((checkpoint) => checkpoint.observed?.cells ?? []);
  if (cps.length) {
    expect(
      record.coverage?.drawingsVerified ===
        observedCells.reduce((sum, cell) => sum + (cell.drawings?.geometry?.length ?? 0), 0) &&
        record.coverage?.alertsVerified ===
          observedCells.reduce((sum, cell) => sum + (cell.alerts?.document?.alerts?.length ?? 0), 0),
      errors,
      'drawing/alert coverage summary differs from actual observations',
    );
    const hashes = cps.flatMap((checkpoint) =>
      (checkpoint.observed?.cells ?? []).map((cell) => ({
        checkpointId: checkpoint.id,
        cellId: cell.id,
        expectedSha256: checkpoint.expected?.cells?.find((item) => item.id === cell.id)?.source
          ?.expectedSha256,
        terminalDataSha256: cell.source?.terminalDataSha256,
      })),
    );
    expect(
      same(record.coverage?.sourceHashes, hashes),
      errors,
      'source hash coverage differs from actual checkpoint identities',
    );
  }
  const expectedRendered = { maximum: 0, full: 0 };
  for (const checkpoint of cps) {
    const scopeName =
      checkpoint.scope === 'maximum-sampled' ? 'maximum' : checkpoint.scope === 'full-256' ? 'full' : '';
    expect(scopeName && modes.has(scopeName), errors, `${checkpoint.id} has wrong scope label`);
    if (!scopeName || !modes.has(scopeName)) continue;
    const rowsPerCell = scopeName === 'maximum' ? 100_000 : 256;
    expect(
      Number.isSafeInteger(checkpoint.observed?.wallClockAt) && checkpoint.observed.wallClockAt >= 0,
      errors,
      `${checkpoint.id} actual Date.now checkpoint wall-clock capture missing`,
    );
    expect(
      checkpoint.rowsPerCell === rowsPerCell,
      errors,
      `${checkpoint.id} row count label must be ${rowsPerCell}`,
    );
    if (!record.scene?.scopes?.[scopeName]?.sourceRows || !record.scene.scopes[scopeName].cells) continue;
    const normalized = reconstructScene(record.scene, scopeName);
    const sampleIndices =
      scopeName === 'maximum' ? undefined : Array.from({ length: 256 }, (_, index) => index);
    let truth;
    try {
      const mutationPrefix = checkpointPrefix(checkpoint);
      expect(
        Number.isInteger(mutationPrefix) &&
          mutationPrefix >= 0 &&
          mutationPrefix <= normalized.mutations.length,
        errors,
        `${checkpoint.id} mutation prefix/revision missing`,
      );
      truth = expectedCheckpoint(normalized, normalized.mutations, {
        id: checkpoint.id,
        scope: checkpoint.scope,
        indices: sampleIndices,
        mutationPrefix,
      });
    } catch (failure) {
      errors.push(`${checkpoint.id} independent expected source replay failed: ${String(failure)}`);
      continue;
    }
    expect(
      Array.isArray(checkpoint.expected?.cells) && checkpoint.expected.cells.length === 4,
      errors,
      `${checkpoint.id} expected per-cell evidence missing`,
    );
    expect(
      Array.isArray(checkpoint.observed?.cells) && checkpoint.observed.cells.length === 4,
      errors,
      `${checkpoint.id} observed per-cell evidence missing`,
    );
    for (const expectedCell of truth.cells) {
      const suppliedExpected = checkpoint.expected?.cells?.find((item) => item.id === expectedCell.id);
      const observed = checkpoint.observed?.cells?.find((item) => item.id === expectedCell.id);
      const label = `${checkpoint.id}/${expectedCell.id}`;
      expect(
        Boolean(suppliedExpected && observed),
        errors,
        `${label} expected/observed cell identity missing`,
      );
      if (!suppliedExpected || !observed) continue;
      expect(
        same(suppliedExpected.source, expectedCell.source),
        errors,
        `${label} checkpoint source revision/count/hash differs from independent replay`,
      );
      expect(
        observed.source?.rows === expectedCell.source.rows &&
          observed.source?.firstTime === expectedCell.source.firstTime &&
          observed.source?.lastTime === expectedCell.source.lastTime,
        errors,
        `${label} observed full data count/boundary timestamps differ`,
      );
      expect(
        SHA64.test(observed.source?.terminalDataSha256 ?? '') &&
          observed.source.terminalDataSha256 === expectedCell.source.expectedSha256,
        errors,
        `${label} actual terminal full OHLCV hash differs from independently replayed source`,
      );
      expect(
        same(observed.query, expectedCell.query),
        errors,
        `${label} actual query differs from ordered mutation replay`,
      );
      expect(
        sameOracleState(observed.alerts?.document, expectedCell.alerts.document),
        errors,
        `${label} all25 alert records/statuses/occurrences differ`,
      );
      expect(
        same(stripEventClocks(observed.alerts?.events), expectedCell.alerts.expected),
        errors,
        `${label} observed alert events differ from independent crossings`,
      );
      expect(
        sameOracleState(observed.workspace, expectedCell.workspace),
        errors,
        `${label} saved grid/workspace state differs`,
      );
      expect(
        observed.seriesCount === 12 && observed.paneCount === 4,
        errors,
        `${label} actual series/pane topology differs`,
      );
      for (const event of observed.alerts?.events ?? []) {
        const delivery = normalized.mutations
          .slice(0, checkpointPrefix(checkpoint))
          .find(
            (item) =>
              item.operation === 'monitor-update' &&
              same(item.query, event.query) &&
              item.bar?.time === event.barTime &&
              item.bar?.close === event.price &&
              item.previousPrice === event.previousPrice,
          );
        const receipt = receipts.get(delivery?.deliveryId?.replace(/:\d+$/, ''));
        expect(
          delivery &&
            receipt &&
            Number.isSafeInteger(event.observedAt) &&
            Number.isSafeInteger(receipt.wallClock?.dispatchedAt) &&
            Number.isSafeInteger(checkpoint.observed.wallClockAt) &&
            event.observedAt >= receipt.wallClock.dispatchedAt &&
            event.observedAt <= checkpoint.observed.wallClockAt,
          errors,
          `${label} alert observedAt outside actual delivery/checkpoint wall-clock bounds`,
        );
      }
      checkRendered(expectedCell, observed, errors, label);
      validateDrawingCell(expectedCell, observed, errors, label);
      expectedRendered[scopeName] += expectedCell.rendered.length;
    }
  }
  if (modes.has('maximum')) {
    const maximumCps = cps.filter((item) => item.scope === 'maximum-sampled');
    expect(
      maximumCps.length === (requestedMode === 'max' ? 11 : 12),
      errors,
      'maximum checkpoint count is incomplete',
    );
    expect(
      expectedRendered.maximum === (requestedMode === 'max' ? 11 : 12) * 4 * 16,
      errors,
      'maximum sampled rendered observation count differs from exact checkpoint coverage',
    );
    expect(
      record.coverage?.maxCheckpoints === maximumCps.length &&
        record.coverage?.maxRenderedObservations === expectedRendered.maximum,
      errors,
      'maximum coverage summary differs from collected checkpoints',
    );
    const labels = Object.values(record.coverage?.renderedCoverageLabels ?? {});
    const label = labels.find((item) => item.scope === 'maximum-sampled');
    expect(
      label?.exhaustive === false &&
        /sampled/i.test(label?.label ?? label?.scope ?? '') &&
        !/exhaustive/i.test(label?.label ?? label?.scope ?? ''),
      errors,
      '100k rendered coverage must be labeled sampled, never exhaustive',
    );
  }
  if (modes.has('full')) {
    const fullCps = cps.filter((item) => item.scope === 'full-256');
    expect(fullCps.length === 12, errors, 'full256 pass must contain exactly12 checkpoints');
    expect(
      expectedRendered.full === 12 * 4 * 256,
      errors,
      'full256 pass must contain exactly12,288 row observations',
    );
    expect(
      record.coverage?.fullCheckpoints === 12 && record.coverage?.fullRenderedObservations === 12 * 4 * 256,
      errors,
      'full256 coverage summary differs from observed checkpoint rows',
    );
    const labels = Object.values(record.coverage?.renderedCoverageLabels ?? {});
    const label = labels.find((item) => item.scope === 'full-256');
    expect(
      label?.exhaustive === true && /256/i.test(label?.label ?? label?.scope ?? ''),
      errors,
      'full render coverage must be explicitly labeled full256',
    );
  }
}

function monitorOnlyDelivery(action) {
  if (action?.kind !== 'deliver' || !action.deliveries?.length) return false;
  const before = action.chartCohortBefore,
    after = action.chartCohortAfter;
  if (
    !Array.isArray(before) ||
    before.length === 0 ||
    before.length > 4 ||
    !same(before, after) ||
    !same(after, action.chartCohort) ||
    new Set(before.map((cell) => cell.cellId)).size !== before.length ||
    !before.every(
      (cell) =>
        CELL_IDS.includes(cell.cellId) &&
        validQuery(cell.query) &&
        cell.chartGeneration === action.chartGeneration,
    )
  )
    return false;
  for (const provider of [action.providerBefore, action.providerAfter]) {
    const monitor = provider?.monitor;
    const runtimes = monitor?.runtimes?.filter((runtime) => runtime.active);
    if (
      !monitor ||
      monitor.destroyed !== false ||
      !Array.isArray(runtimes) ||
      provider.historyFeeds !== before.length ||
      provider.latestFeeds !== runtimes.length ||
      monitor.activeRuntimeEntries !== runtimes.length ||
      provider.activeSubscriptions !== before.length + runtimes.length ||
      provider.subscriptions?.length !== provider.activeSubscriptions
    )
      return false;
    if (
      !provider.subscriptions.every(
        (entry) =>
          validQuery(entry.query) &&
          entry.key === queryKey(entry.query) &&
          entry.releasedAt === null &&
          finite(entry.openedAt),
      )
    )
      return false;
    const ownedKeys = [
      ...before.map((cell) => queryKey(cell.query)),
      ...runtimes.map((runtime) => queryKey(runtime.query)),
    ].sort();
    if (!same(ownedKeys, provider.subscriptions.map((entry) => entry.key).sort())) return false;
    for (const delivery of action.deliveries) {
      const matches = runtimes.filter((runtime) => queryKey(runtime.query) === delivery.key);
      if (
        before.some((cell) => queryKey(cell.query) === delivery.key) ||
        delivery.handlers !== 1 ||
        matches.length !== 1 ||
        !matches[0].feed?.activeConnection ||
        matches[0].feed.destroyed !== false ||
        matches[0].feed.mode !== 'latest' ||
        matches[0].feed.status !== 'live' ||
        queryKey(matches[0].feed.query) !== delivery.key
      )
        return false;
    }
  }
  return Number.isSafeInteger(action.chartGeneration) && action.chartGeneration >= 0;
}

function actionTargetCell(action) {
  return CELL_IDS.includes(action?.targetCellId) && action.targetCellId === action.requested?.cellId
    ? action.targetCellId
    : undefined;
}

function validateActionReceipt(action, errors, name, seenFrames, { wheel = false } = {}) {
  expect(
    action && typeof action.id === 'string' && action.id.length > 0,
    errors,
    `${name} action identity missing`,
  );
  expect(
    ['dispatchedAt', 'returnedAt', 'settledAt'].every(
      (field) => Number.isSafeInteger(action?.wallClock?.[field]) && action.wallClock[field] >= 0,
    ) &&
      action.wallClock.returnedAt >= action.wallClock.dispatchedAt &&
      action.wallClock.settledAt >= action.wallClock.returnedAt,
    errors,
    `${name} actual Date.now wall-clock brackets missing or out of order`,
  );
  const requiredFinite = [
    'dispatchedAt',
    'returnedAt',
    'settledAt',
    'synchronousMs',
    'settledMs',
    'renderWorkMs',
    'libraryWorkMs',
  ];
  if (action?.targetAt !== undefined) requiredFinite.push('targetAt');
  if (action?.restoreFulfilledAt !== undefined)
    requiredFinite.push('restoreFulfilledAt', 'restoreFulfilledMs');
  if (action?.hydratedAt !== undefined) requiredFinite.push('hydratedAt', 'hydratedMs');
  expect(
    requiredFinite.every((field) => nonnegative(action?.[field])),
    errors,
    `${name} raw timing values must be finite and nonnegative`,
  );
  const eqDuration = (field, endpoint) =>
    expect(
      finite(action?.[endpoint]) &&
        Math.abs(action[field] - (action[endpoint] - action.dispatchedAt)) <= 0.001,
      errors,
      `${name} raw duration differs: ${field}`,
    );
  eqDuration('synchronousMs', 'returnedAt');
  eqDuration('settledMs', 'settledAt');
  let lastAt = action?.returnedAt;
  for (const [endpoint, duration] of [
    ['restoreFulfilledAt', 'restoreFulfilledMs'],
    ['hydratedAt', 'hydratedMs'],
  ]) {
    if (action?.[endpoint] !== undefined) {
      eqDuration(duration, endpoint);
      expect(action[endpoint] >= lastAt, errors, `${name} fulfillment/hydration timestamps are out of order`);
      lastAt = action[endpoint];
    }
  }
  expect(
    action?.returnedAt >= action?.dispatchedAt && action?.settledAt >= lastAt,
    errors,
    `${name} action timestamps are out of order`,
  );
  expect(
    Array.isArray(action?.affectedCellIds) &&
      action.affectedCellIds.length > 0 &&
      action.affectedCellIds.every((id) => CELL_IDS.includes(id)),
    errors,
    `${name} affected chart attribution missing`,
  );
  expect(Array.isArray(action?.frames), errors, `${name} actual rendered callback evidence missing`);
  const nativeInteraction = wheel || name === 'interaction';
  const currentCohort = (cohort) =>
    Array.isArray(cohort) &&
    cohort.length === CELL_IDS.length &&
    CELL_IDS.every((id) => cohort.filter((entry) => entry.cellId === id).length === 1) &&
    cohort.every((entry) => entry.chartGeneration === action.chartGeneration);
  if (nativeInteraction) {
    expect(actionTargetCell(action), errors, `${name} requested/observed operation target differs`);
    expect(
      currentCohort(action.chartCohortBefore) &&
        currentCohort(action.chartCohortAfter) &&
        same(
          action.affectedCellIds,
          action.chartCohortBefore.map((entry) => entry.cellId),
        ),
      errors,
      `${name} current chart settlement cohort missing or stale`,
    );
  }
  if (
    [
      'construct',
      'restore',
      'deliver',
      'gesture',
      'drawing',
      'pane',
      'range',
      'cursor',
      'wheel',
      'study',
      'market',
    ].includes(action?.kind)
  )
    expect(
      action.frames?.length > 0 || monitorOnlyDelivery(action),
      errors,
      `${name} effective rendered action has no actual RAF work`,
    );
  let frameWork = 0;
  for (const frame of action?.frames ?? []) {
    expect(
      typeof frame.receiptId === 'string' && frame.receiptId.length > 0 && !seenFrames.has(frame.receiptId),
      errors,
      `${name} duplicate/missing RAF receipt ID`,
    );
    if (frame.receiptId) seenFrames.add(frame.receiptId);
    expect(
      (Number.isSafeInteger(frame.chartGeneration) ||
        (typeof frame.chartGeneration === 'string' && frame.chartGeneration.length > 0)) &&
        frame.chartGeneration === action.chartGeneration &&
        finite(frame.at) &&
        nonnegative(frame.callbackMs),
      errors,
      `${name} frame generation/timing invalid`,
    );
    expect(
      frame.at >= action.dispatchedAt && frame.at + frame.callbackMs <= action.settledAt + 0.001,
      errors,
      `${name} RAF callback interval outside its action`,
    );
    expect(
      Array.isArray(frame.affectedCharts) && frame.affectedCharts.length > 0,
      errors,
      `${name} frame affected chart evidence missing`,
    );
    for (const chart of frame.affectedCharts ?? []) {
      expect(
        chart.chartGeneration === frame.chartGeneration,
        errors,
        `${name} frame chart generation differs from current action`,
      );
      expect(
        action.affectedCellIds.includes(chart.cellId),
        errors,
        `${name} frame attributed to an unaffected/retired chart`,
      );
      const countKeys = ['sceneDraws', 'overlayDraws', 'primitiveDraws'];
      expect(
        countKeys.some((key) => chart.after?.[key] > chart.before?.[key]),
        errors,
        `${name} RAF callback has no actual draw-counter advance`,
      );
      expect(
        countKeys.every(
          (key) =>
            Number.isSafeInteger(chart.before?.[key]) &&
            Number.isSafeInteger(chart.after?.[key]) &&
            chart.after[key] >= chart.before[key],
        ),
        errors,
        `${name} chart draw-counter delta invalid`,
      );
    }
    frameWork += frame.callbackMs;
  }
  expect(
    Math.abs(action?.renderWorkMs - frameWork) <= 1e-6,
    errors,
    `${name} render-work duration differs from unique RAF callbacks`,
  );
  expect(
    Math.abs(action?.libraryWorkMs - action?.synchronousMs - frameWork) <= 1e-6,
    errors,
    `${name} library work must count each RAF callback once`,
  );
  if (action?.kind === 'deliver') {
    const requested = action.requested?.deliveries,
      actual = action.deliveries;
    expect(
      Array.isArray(requested) && requested.length > 0 && requested.length === actual?.length,
      errors,
      `${name} original requested/actual delivery array missing`,
    );
    for (let index = 0; index < (actual?.length ?? 0); index++) {
      const wanted = requested?.[index],
        got = actual[index];
      const subscribers = action.providerBefore?.subscriptions?.filter((item) => item.key === got.key).length;
      expect(
        wanted &&
          got.key === queryKey(wanted.query) &&
          same(got.bar, wanted.bar) &&
          Number.isInteger(got.handlers) &&
          got.handlers > 0 &&
          got.handlers === subscribers,
        errors,
        `${name} original delivery order/bar/subscription count differs`,
      );
    }
  }
  if (wheel) {
    const preparation = action.pointerPreparation;
    expect(
      preparation &&
        ['startedAt', 'initialSettledAt', 'pointerSetupCompletedAt', 'settledAt', 'renderWorkMs'].every(
          (key) => nonnegative(preparation[key]),
        ) &&
        preparation.startedAt <= preparation.initialSettledAt &&
        preparation.initialSettledAt <= preparation.pointerSetupCompletedAt &&
        preparation.pointerSetupCompletedAt <= preparation.settledAt &&
        preparation.settledAt <= action.armedAt &&
        action.armedAt <= action.dispatchedAt &&
        preparation.chartGeneration === action.chartGeneration &&
        currentCohort(preparation.chartCohortBefore) &&
        currentCohort(preparation.chartCohortAfter) &&
        same(preparation.chartCohortAfter, action.chartCohortBefore) &&
        Array.isArray(preparation.frames),
      errors,
      `${name} pointer preparation chronology/current cohort missing or invalid`,
    );
    let preparationWork = 0;
    for (const frame of preparation?.frames ?? []) {
      expect(
        typeof frame.receiptId === 'string' && frame.receiptId.length > 0 && !seenFrames.has(frame.receiptId),
        errors,
        `${name} preparation duplicate/missing RAF receipt ID`,
      );
      if (frame.receiptId) seenFrames.add(frame.receiptId);
      expect(
        frame.chartGeneration === action.chartGeneration &&
          nonnegative(frame.callbackMs) &&
          frame.at >= preparation.startedAt &&
          frame.at + frame.callbackMs <= preparation.settledAt + 0.001,
        errors,
        `${name} preparation RAF generation/interval invalid`,
      );
      expect(
        Array.isArray(frame.affectedCharts) && frame.affectedCharts.length > 0,
        errors,
        `${name} preparation affected chart evidence missing`,
      );
      for (const chart of frame.affectedCharts ?? []) {
        const keys = ['sceneDraws', 'overlayDraws', 'primitiveDraws'];
        expect(
          chart.chartGeneration === action.chartGeneration &&
            preparation.chartCohortBefore?.some(
              (entry) => entry.cellId === chart.cellId && entry.chartGeneration === chart.chartGeneration,
            ) &&
            preparation.chartCohortAfter?.some(
              (entry) => entry.cellId === chart.cellId && entry.chartGeneration === chart.chartGeneration,
            ) &&
            keys.every(
              (key) =>
                Number.isSafeInteger(chart.before?.[key]) &&
                Number.isSafeInteger(chart.after?.[key]) &&
                chart.after[key] >= chart.before[key],
            ) &&
            keys.some((key) => chart.after?.[key] > chart.before?.[key]),
          errors,
          `${name} preparation stale chart or invalid draw-counter advance`,
        );
      }
      preparationWork += frame.callbackMs;
    }
    expect(
      Math.abs(preparation?.renderWorkMs - preparationWork) <= 1e-6,
      errors,
      `${name} preparation render-work differs from unique RAF callbacks`,
    );
    expect(
      finite(action?.automationStarted) &&
        finite(action?.automationCompleted) &&
        nonnegative(action?.automationInclusiveMs),
      errors,
      `${name} automation-inclusive clock is missing/nonfinite`,
    );
    expect(
      Math.abs(action.automationInclusiveMs - (action.automationCompleted - action.automationStarted)) <= 1,
      errors,
      `${name} paired-clock elapsed does not equal automation timestamps`,
    );
    expect(
      action.automationStarted <= preparation?.startedAt &&
        action.automationCompleted >= action.settledAt &&
        !same(action.effectiveObservation?.beforeRange, action.effectiveObservation?.afterRange) &&
        finite(action.effectiveObservation?.beforeRange?.from) &&
        finite(action.effectiveObservation?.afterRange?.from) &&
        action.effectiveObservation.beforeRange.from !== action.effectiveObservation.afterRange.from,
      errors,
      `${name} native wheel input did not produce an effective viewport change`,
    );
  }
}

function validateActions(record, errors, modes, mode) {
  const actions = Object.fromEntries(
    [
      'warmup',
      'constructions',
      'restores',
      'tailReplace',
      'tailAppendReplace',
      'interaction',
      'wheel',
      'syncExact',
      'syncNearest',
      'soak',
      'lifecycle',
    ].map((key) => [key, record.actions?.[key] ?? []]),
  );
  const seenFrames = new Set();
  const actionIds = new Map();
  const inspect = (item, name) => {
    if (item?.id && finite(item.dispatchedAt)) {
      if (actionIds.has(item.id)) {
        expect(same(item, actionIds.get(item.id)), errors, `duplicate inconsistent action ${item.id}`);
        return;
      }
      actionIds.set(item.id, item);
      validateActionReceipt(item, errors, name, seenFrames, { wheel: name === 'wheel' });
    } else
      for (const key of ['one', 'four', 'receipt', 'parked', 'remounted', 'setup'])
        if (item?.[key]) inspect(item[key], name);
  };
  for (const name of [
    'warmup',
    'constructions',
    'restores',
    'tailReplace',
    'tailAppendReplace',
    'interaction',
    'wheel',
    'syncExact',
    'syncNearest',
    'soak',
    'lifecycle',
  ]) {
    expect(Array.isArray(actions[name]), errors, `raw ${name} action array is missing`);
    for (const item of actions[name] ?? []) inspect(item, name);
  }
  if (modes.has('maximum')) {
    expect(actions.warmup?.length === 1, errors, 'one unmeasured warmup action is required');
    expect(actions.constructions?.length === 3, errors, 'exactly3 measured constructions are required');
    expect(actions.restores?.length === 3, errors, 'exactly3 measured restores are required');
    expect(
      actions.tailReplace?.length === 100,
      errors,
      '100 same-time tail replacement batches are required',
    );
    expect(actions.tailAppendReplace?.length === 100, errors, '100 append/replacement batches are required');
    expect(actions.interaction?.length === 240, errors, '240 real interaction samples are required');
    expect(actions.wheel?.length === 24, errors, '24 separate native wheel samples are required');
    expect(
      actions.syncExact?.length === 24 && actions.syncNearest?.length === 24,
      errors,
      'exact and nearest sync each require24 semantic samples',
    );
    expect(
      record.coverage?.constructionSamples === 3 && record.coverage?.restoreSamples === 3,
      errors,
      'construction/restore sample summary differs',
    );
    expect(
      record.coverage?.tailSamples === 200 &&
        record.coverage?.interactionSamples === 240 &&
        record.coverage?.wheelSamples === 24 &&
        record.coverage?.syncSamples === 48,
      errors,
      'raw action sample summary differs from fixed workload',
    );
    const constructionUpper = actions.constructions.map((item) => item.hydratedMs);
    const restoreUpper = actions.restores.map((item) => item.hydratedMs);
    const settled = [...actions.constructions, ...actions.restores].map((item) => item.settledMs);
    expect(
      constructionUpper.every(nonnegative) && meetsPercentile(constructionUpper, 4000, null),
      errors,
      'construction hydration elapsed p95 must be <=4000ms',
    );
    expect(
      restoreUpper.every(nonnegative) && meetsPercentile(restoreUpper, 4000, null),
      errors,
      'restore readiness elapsed p95 must be <=4000ms',
    );
    expect(meetsPercentile(settled, 6000, null), errors, 'construction/restore settled p95 must be <=6000ms');
    for (const [name, values] of [
      ['tail replacement', actions.tailReplace.map((item) => item.libraryWorkMs)],
      ['tail append/replacement', actions.tailAppendReplace.map((item) => item.libraryWorkMs)],
      ['interaction', actions.interaction.map((item) => item.libraryWorkMs)],
      ['exact sync', actions.syncExact.map((item) => item.libraryWorkMs)],
      ['nearest sync', actions.syncNearest.map((item) => item.libraryWorkMs)],
    ])
      expect(meetsPercentile(values, 32, 64), errors, `${name} library work p95/p99 exceeds32/64ms`);
    for (const [name, values] of [
      ['tail replacement', actions.tailReplace.map((item) => item.settledMs)],
      ['tail append/replacement', actions.tailAppendReplace.map((item) => item.settledMs)],
      ['interaction', actions.interaction.map((item) => item.settledMs)],
      ['exact sync', actions.syncExact.map((item) => item.settledMs)],
      ['nearest sync', actions.syncNearest.map((item) => item.settledMs)],
    ])
      expect(meetsPercentile(values, 100, 200), errors, `${name} settled p95/p99 exceeds100/200ms`);
    expect(
      meetsPercentile(
        actions.wheel.map((item) => item.automationInclusiveMs),
        200,
        null,
        { strict95: true },
      ),
      errors,
      'automation-inclusive native wheel p95 must be <200ms',
    );
  }
  if (modes.has('soak')) {
    expect(record.coverage?.soakElapsedMs >= 120_000, errors, 'soak must run for at least120 seconds');
    expect(
      Array.isArray(record.coverage?.soakCadence) && record.coverage.soakCadence.length > 0,
      errors,
      'soak cadence evidence is omitted',
    );
    for (const delivery of record.coverage?.soakCadence ?? [])
      expect(
        finite(delivery.targetAt) &&
          finite(delivery.dispatchedAt) &&
          finite(delivery.completedAt) &&
          delivery.dispatchedAt >= delivery.targetAt &&
          delivery.completedAt >= delivery.dispatchedAt,
        errors,
        'soak cadence delivery timestamps must be finite and ordered',
      );
    const lifecycle = record.coverage?.lifecycleCounts;
    expect(
      lifecycle?.parkCycles === 10 &&
        lifecycle?.activeChanges === 20 &&
        lifecycle?.restores === 10 &&
        lifecycle?.destroyRecreates === 6,
      errors,
      'soak lifecycle counts must be10 park cycles,20 active changes,10 restores and6 destroy/recreates',
    );
    expect(
      Array.isArray(actions.soak) && actions.soak.length > 0,
      errors,
      'raw soak action records are missing',
    );
  }
  if (mode === 'all')
    expect(
      Array.isArray(actions.lifecycle) && actions.lifecycle.length > 0,
      errors,
      'all-mode lifecycle records are missing',
    );
}

const monitorCounts = [
  'members',
  'leaseEntries',
  'observerListeners',
  'retainedMemberDisposers',
  'cachedRuleEntries',
  'baselineEntries',
  'runtimeEntries',
  'activeRuntimeEntries',
  'reconcileTimers',
];
function checkMonitor(monitor, errors, label, { empty = false } = {}) {
  expect(
    monitor && Array.isArray(monitor.runtimes),
    errors,
    `${label} actual monitor runtime snapshot missing`,
  );
  if (!monitor) return;
  for (const field of monitorCounts)
    expect(
      Number.isSafeInteger(monitor[field]) && monitor[field] >= 0 && (!empty || monitor[field] === 0),
      errors,
      `${label} private monitor ${field} invalid/nonzero`,
    );
  expect(
    monitor.runtimeEntries === monitor.runtimes?.length &&
      monitor.activeRuntimeEntries === monitor.runtimes?.filter((item) => item.active).length,
    errors,
    `${label} runtime summary differs from actual runtimes`,
  );
  if (empty)
    expect(
      monitor.reservationPending === false && monitor.activationPending === false,
      errors,
      `${label} retained private work after cleanup`,
    );
  for (const runtime of monitor.runtimes ?? []) {
    const feed = runtime.feed;
    expect(
      feed?.mode === 'latest' &&
        (same(feed.query, runtime.query) || (!runtime.active && feed.query === null)),
      errors,
      `${label} latest feed mode/query ownership mismatch`,
    );
    for (const field of ['retainedBars', 'bufferedBars', 'correctionBars', 'pendingBarEntries'])
      expect(
        Number.isSafeInteger(feed?.[field]) && feed[field] >= 0 && feed[field] <= 1,
        errors,
        `${label} latest ${field} exceeds one`,
      );
    expect(
      feed?.pendingBarEntries === feed?.bufferedBars + feed?.correctionBars,
      errors,
      `${label} actual pending map sum differs`,
    );
    if (!runtime.active)
      expect(
        feed?.destroyed &&
          !feed.activeConnection &&
          !feed.pendingRequest &&
          !feed.staleTimer &&
          !feed.retryTimer &&
          !feed.requestTimer,
        errors,
        `${label} inactive runtime retains resources`,
      );
  }
}
function checkProvider(provider, errors, label, { empty = false } = {}) {
  expect(
    provider && Array.isArray(provider.subscriptions),
    errors,
    `${label} provider subscription ledger missing`,
  );
  if (!provider) return;
  expect(
    provider.activeSubscriptions === provider.subscriptions?.length,
    errors,
    `${label} provider active summary differs from raw subscriptions`,
  );
  for (const field of ['activeSubscriptions', 'pendingRequests', 'historyFeeds', 'latestFeeds'])
    expect(
      Number.isSafeInteger(provider[field]) && provider[field] >= 0 && (!empty || provider[field] === 0),
      errors,
      `${label} actual provider ${field} invalid/nonzero`,
    );
  expect(
    provider.activeSubscriptions === provider.historyFeeds + provider.latestFeeds,
    errors,
    `${label} history/latest subscription ownership differs`,
  );
  for (const item of provider.subscriptions ?? [])
    expect(
      validQuery(item.query) &&
        finite(item.openedAt) &&
        item.releasedAt === null &&
        item.key === queryKey(item.query),
      errors,
      `${label} invalid live subscription identity`,
    );
}
function validateEndpointReadiness(record, endpoint, errors) {
  const label = endpoint.label;
  let expected;
  try {
    const scene = label.startsWith('full-') ? record.scene?.scopes?.full : record.scene?.scopes?.maximum;
    expected = expectationForEndpoint(label, scene);
  } catch (error) {
    errors.push(`${label} unknown/missing resource endpoint expectation: ${String(error)}`);
    return;
  }
  const proof = endpoint.readiness;
  const attempts = proof?.gcAttempts;
  const last = attempts?.at(-1);
  expect(
    proof?.label === label &&
      proof?.accepted === true &&
      same(proof.clockDomains, {
        collector: 'node-performance-epoch-ms',
        snapshots: 'browser-performance-epoch-ms',
      }) &&
      finite(proof.startedAt) &&
      finite(proof.completedAt) &&
      proof.completedAt >= proof.startedAt &&
      proof.completedAt - proof.startedAt < 30000 &&
      Array.isArray(proof.polls) &&
      proof.polls.length > 0 &&
      Array.isArray(attempts) &&
      attempts.length >= 1 &&
      attempts.length <= 3 &&
      last?.accepted === true,
    errors,
    `${label} raw bounded readiness receipt missing`,
  );
  if (!last) return;
  const nodeRequests = [];
  const browserSnapshots = [];
  for (const poll of proof.polls ?? []) {
    const actual = assessEndpoint(poll.snapshot, expected);
    expect(poll.ready === actual.ready, errors, `${label} readiness poll differs from raw state`);
    expect(
      finite(poll.requestStartedAt) &&
        finite(poll.responseReceivedAt) &&
        poll.requestStartedAt >= proof.startedAt &&
        poll.responseReceivedAt >= poll.requestStartedAt &&
        poll.responseReceivedAt <= proof.completedAt &&
        poll.at === poll.responseReceivedAt,
      errors,
      `${label} Node readiness chronology differs`,
    );
    nodeRequests.push({ start: poll.requestStartedAt, end: poll.responseReceivedAt });
    browserSnapshots.push({ requestStartedAt: poll.requestStartedAt, at: poll.snapshot?.at });
  }
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    const before = assessEndpoint(attempt.pre, expected);
    const after = assessEndpoint(attempt.post, expected);
    const physicalSame = same(before.identities, after.identities);
    const accepted = before.ready && after.ready && physicalSame;
    expect(
      attempt.accepted === accepted && (index === attempts.length - 1 ? accepted : !accepted),
      errors,
      `${label} physical pre/post-GC ownership identity differs`,
    );
    expect(
      finite(attempt.preRequestStartedAt) &&
        finite(attempt.preResponseReceivedAt) &&
        finite(attempt.postRequestStartedAt) &&
        finite(attempt.postResponseReceivedAt) &&
        attempt.preRequestStartedAt >= proof.startedAt &&
        attempt.preResponseReceivedAt >= attempt.preRequestStartedAt &&
        attempt.preObservedAt === attempt.preResponseReceivedAt &&
        attempt.postRequestStartedAt >= attempt.preResponseReceivedAt &&
        (index === 0 || attempt.preRequestStartedAt >= attempts[index - 1].postResponseReceivedAt) &&
        attempt.postResponseReceivedAt >= attempt.postRequestStartedAt &&
        attempt.postObservedAt === attempt.postResponseReceivedAt &&
        attempt.postResponseReceivedAt <= proof.completedAt,
      errors,
      `${label} Node readiness chronology differs`,
    );
    nodeRequests.push(
      { start: attempt.preRequestStartedAt, end: attempt.preResponseReceivedAt },
      { start: attempt.postRequestStartedAt, end: attempt.postResponseReceivedAt },
    );
    browserSnapshots.push(
      { requestStartedAt: attempt.preRequestStartedAt, at: attempt.pre?.at },
      { requestStartedAt: attempt.postRequestStartedAt, at: attempt.post?.at },
    );
    const measured = attempt.measurements;
    const turns = measured?.gcTurnReceipts;
    expect(
      measured?.gcTurns === 3 &&
        finite(measured.preparedAt) &&
        Array.isArray(turns) &&
        turns.length === 3 &&
        turns.every(
          (turn, turnIndex) =>
            turn.turn === turnIndex + 1 &&
            finite(turn.at) &&
            turn.at >= (turnIndex ? turns[turnIndex - 1].at : measured.preparedAt),
        ) &&
        finite(measured.countersAt) &&
        finite(measured.heapAt) &&
        finite(measured.domOwnedAt) &&
        finite(measured.resourceTrackerAt) &&
        attempt.preResponseReceivedAt <= measured.preparedAt &&
        measured.countersAt >= turns[2].at &&
        measured.heapAt >= measured.countersAt &&
        measured.domOwnedAt >= measured.heapAt &&
        measured.resourceTrackerAt >= measured.domOwnedAt &&
        attempt.postRequestStartedAt >= measured.resourceTrackerAt,
      errors,
      `${label} raw three-GC measurement timestamps missing/out of order`,
    );
  }
  nodeRequests.sort((a, b) => a.start - b.start);
  expect(
    nodeRequests.every(
      (item, index) =>
        !index ||
        (finite(item.start) &&
          finite(nodeRequests[index - 1].end) &&
          item.start >= nodeRequests[index - 1].end),
    ),
    errors,
    `${label} Node readiness chronology differs`,
  );
  expect(
    attempts.every((attempt) =>
      nodeRequests.every(
        (request) =>
          request.end <= attempt.preResponseReceivedAt ||
          request.start >= attempt.postResponseReceivedAt ||
          (request.start === attempt.postRequestStartedAt && request.end === attempt.postResponseReceivedAt),
      ),
    ),
    errors,
    `${label} Node readiness chronology differs`,
  );
  browserSnapshots.sort((a, b) => a.requestStartedAt - b.requestStartedAt);
  expect(
    browserSnapshots.every(
      (item, index) => finite(item.at) && (!index || item.at >= browserSnapshots[index - 1].at),
    ),
    errors,
    `${label} browser snapshot chronology differs`,
  );
  if (!last.post || !last.measurements) {
    errors.push(`${label} final post-GC resource observation missing`);
    return;
  }
  expect(
    assessEndpoint(endpoint, expected).ready &&
      same(endpoint.provider, last.post.provider) &&
      same(endpoint.monitor, last.post.monitor) &&
      same(endpoint.cells, last.post.cells) &&
      same(endpoint.gridState, last.post.gridState) &&
      endpoint.at === last.post.at &&
      endpoint.owned?.feeds === last.post.provider.activeSubscriptions,
    errors,
    `${label} accepted endpoint differs from post-GC physical snapshot`,
  );
  expect(
    same(endpoint.measuredAt, {
      prepared: last.measurements.preparedAt,
      gcTurns: last.measurements.gcTurnReceipts,
      domCounters: last.measurements.countersAt,
      heap: last.measurements.heapAt,
      ownedDom: last.measurements.domOwnedAt,
      resourceTracker: last.measurements.resourceTrackerAt,
      providerAndMonitor: last.post.at,
    }),
    errors,
    `${label} endpoint measurement timestamps differ from raw collection`,
  );
  const { counters, heap, domOwned, resourceTracker, prepared } = last.measurements;
  const rawDetachedPresent = Object.hasOwn(counters ?? {}, 'detachedNodes');
  const projectedDetachedPresent = Object.hasOwn(endpoint.dom ?? {}, 'cdpDetached');
  expect(
    counters &&
      heap &&
      domOwned &&
      resourceTracker &&
      prepared &&
      nonnegative(counters.nodes) &&
      nonnegative(counters.jsEventListeners) &&
      nonnegative(heap.usedSize) &&
      nonnegative(domOwned.consumer?.detached) &&
      nonnegative(domOwned.terminal?.detached) &&
      nonnegative(resourceTracker.timers) &&
      nonnegative(resourceTracker.observers) &&
      endpoint.heapUsedBytes === heap.usedSize &&
      endpoint.dom?.nodes === counters.nodes &&
      rawDetachedPresent === projectedDetachedPresent &&
      (!rawDetachedPresent ||
        (nonnegative(counters.detachedNodes) && endpoint.dom?.cdpDetached === counters.detachedNodes)) &&
      endpoint.dom?.detached === domOwned.consumer.detached + domOwned.terminal.detached &&
      endpoint.dom?.disposed === domOwned.terminal.detached &&
      endpoint.listeners === counters.jsEventListeners &&
      endpoint.timers === resourceTracker.timers &&
      endpoint.observers === resourceTracker.observers &&
      same(endpoint.domOwned, domOwned) &&
      same(endpoint.resourceTracker, resourceTracker) &&
      same(endpoint.prepared, prepared),
    errors,
    `${label} accepted endpoint differs from raw three-GC measurements`,
  );
}
function validateResources(record, errors, modes, mode) {
  const snapshots = record.resources;
  expect(Array.isArray(snapshots), errors, 'resource evidence array is required');
  if (!Array.isArray(snapshots)) return;
  const endpoints = snapshots.filter((item) => item.sampleKind === 'three-gc-endpoint');
  for (const endpoint of endpoints) validateEndpointReadiness(record, endpoint, errors);
  const emptyBaseline = endpoints.find((item) => item.label.endsWith('empty-baseline'));
  const automationPreparation = record.environment?.automationPreparation;
  expect(
    automationPreparation?.kind === 'selector-geometry' &&
      automationPreparation.selector === 'body' &&
      nonnegative(automationPreparation.startedAt) &&
      nonnegative(automationPreparation.completedAt) &&
      automationPreparation.startedAt <= automationPreparation.completedAt &&
      automationPreparation.completedAt <= emptyBaseline?.readiness?.startedAt &&
      Object.hasOwn(automationPreparation, 'boundingBox') &&
      (automationPreparation.boundingBox === null ||
        ['x', 'y', 'width', 'height'].every((key) => finite(automationPreparation.boundingBox?.[key]))),
    errors,
    'actual selector automation preparation must precede the first empty resource baseline',
  );
  const transient = snapshots.filter((item) => item.sampleKind === 'transient-feed');
  for (const snapshot of snapshots) {
    if (snapshot.provider) checkProvider(snapshot.provider, errors, snapshot.label);
    if (snapshot.monitor) {
      checkMonitor(snapshot.monitor, errors, snapshot.label);
      const subscribed = new Map();
      for (const entry of snapshot.provider?.subscriptions ?? [])
        subscribed.set(queryKey(entry.query), (subscribed.get(queryKey(entry.query)) ?? 0) + 1);
      for (const runtime of snapshot.monitor.runtimes ?? [])
        if (runtime.active && runtime.feed.activeConnection)
          subscribed.set(queryKey(runtime.query), (subscribed.get(queryKey(runtime.query)) ?? 0) - 1);
      for (const cell of snapshot.cells ?? [])
        if (cell.feed?.status === 'live')
          subscribed.set(queryKey(cell.query), (subscribed.get(queryKey(cell.query)) ?? 0) - 1);
      if (snapshot.cells)
        expect(
          [...subscribed.values()].every((value) => value === 0),
          errors,
          `${snapshot.label} actual query subscription ownership cannot be reconciled`,
        );
    }
    for (const cell of snapshot.cells ?? [])
      if (cell.feed) {
        if (/^soak-/.test(snapshot.label ?? ''))
          expect(cell.rows === 100000, errors, `${snapshot.label} current soak history must remain100000`);
        expect(
          CELL_IDS.includes(cell.cellId) &&
            same(cell.query, cell.feed.query) &&
            Number.isSafeInteger(cell.rows) &&
            cell.rows <= 100000,
          errors,
          `${snapshot.label} history query/retention invalid`,
        );
      }
  }
  for (const snapshot of endpoints) {
    expect(
      snapshot.gcTurns === 3 && nonnegative(snapshot.heapUsedBytes) && finite(snapshot.at),
      errors,
      `${snapshot.label} actual three-GC endpoint missing`,
    );
    expect(
      snapshot.dom?.detached === 0 && snapshot.dom?.disposed === 0,
      errors,
      `${snapshot.label} detached/disposed resources must be zero`,
    );
  }
  for (const scope of ['max', 'full']) {
    if (!modes.has(scope === 'max' ? 'maximum' : 'full')) continue;
    const get = (suffix) => endpoints.find((item) => item.label === `${scope}-${suffix}`);
    const [empty, initial, final, cleared] = [
      'empty-baseline',
      'mounted-initial',
      'mounted-final',
      'empty-final',
    ].map(get);
    expect(
      empty && initial && final && cleared,
      errors,
      `${scope} distinct empty and equivalent mounted initial/final endpoints required`,
    );
    if (!empty || !initial || !final || !cleared) continue;
    const composition = (item) => ({
      layout: item.gridState?.layout,
      cells: item.cells
        ?.filter((cell) => cell.feed)
        .map((cell) => ({ id: cell.cellId, query: cell.query, rows: cell.rows })),
      latest: item.monitor?.runtimes
        .map((runtime) => runtime.query)
        .sort((a, b) => queryKey(a).localeCompare(queryKey(b))),
    });
    expect(
      same(composition(initial), composition(final)),
      errors,
      `${scope} mounted endpoint composition differs`,
    );
    expect(final.dom.nodes <= initial.dom.nodes, errors, 'structural DOM growth must be <=0');
    expect(final.listeners <= initial.listeners, errors, 'listener growth must be <=0');
    expect(
      final.heapUsedBytes - initial.heapUsedBytes <= 32 * 1024 * 1024,
      errors,
      'retained heap growth exceeds32MiB',
    );
    for (const item of [initial, final]) {
      expect(
        item.gridState?.layout === 4 &&
          item.cells?.filter((cell) => cell.feed).length === 4 &&
          item.cells?.every((cell) => cell.rows === (scope === 'max' ? 100000 : 256)),
        errors,
        `${scope} mounted endpoint must retain four exact current histories`,
      );
      expect(
        item.provider.historyFeeds === 4 &&
          item.provider.latestFeeds === 8 &&
          item.monitor?.activeRuntimeEntries === 8,
        errors,
        `${scope} four history/eight latest ownership missing`,
      );
    }
    checkProvider(cleared.provider, errors, cleared.label, { empty: true });
    if (cleared.monitor) checkMonitor(cleared.monitor, errors, cleared.label, { empty: true });
    expect(
      cleared.cells?.every((cell) => cell.feed === null) && cleared.gridState === null,
      errors,
      `${scope} final live grid/history handle retained`,
    );
    for (const field of ['listeners', 'timers', 'observers'])
      expect(
        cleared[field] <= empty[field] && cleared.owned?.[field] === 0,
        errors,
        `${scope} raw final ${field} leak hidden by cleanup summary`,
      );
    expect(
      cleared.domOwned?.consumer?.detached === 0 &&
        cleared.domOwned?.terminal?.detached === 0 &&
        cleared.domOwned?.totalOwned?.consumer <= empty.domOwned?.totalOwned?.consumer,
      errors,
      `${scope} retained detached host or owned DOM`,
    );
  }
  if (modes.has('soak')) {
    const one = endpoints.filter((item) => /^soak-layout-1-/.test(item.label));
    expect(
      one.length === 10 &&
        one.every(
          (item) =>
            item.provider.historyFeeds === 1 &&
            item.provider.latestFeeds === 8 &&
            item.cells.filter((cell) => cell.feed).length === 1,
        ),
      errors,
      'soak parked endpoints must prove one history/eight latest feeds',
    );
  }
  if (mode !== 'capacity')
    for (const stage of ['initial', 'reconnect']) {
      const held = transient.find((item) => item.label === `transient-${stage}-held-after-delivery`);
      const runtime = held?.monitor?.runtimes?.find((item) => item.active);
      expect(
        held &&
          held.provider.pendingRequests > 0 &&
          runtime?.feed.pendingRequest &&
          runtime.feed.buffering &&
          runtime.feed.pendingBarEntries === 1 &&
          runtime.feed.laneKind === (stage === 'initial' ? 'initial' : 'recovery'),
        errors,
        `${stage} unresolved latest buffer observation missing`,
      );
      const reconciled = transient.find((item) => item.label === `transient-${stage}-reconciled`);
      expect(
        reconciled?.monitor?.runtimes?.some(
          (item) =>
            item.active &&
            item.feed.status === 'live' &&
            item.feed.retainedBars === 1 &&
            item.feed.pendingBarEntries === 0 &&
            !item.feed.pendingRequest,
        ),
        errors,
        `${stage} reconciled latest observation missing`,
      );
    }
  const cleanup = record.cleanup;
  expect(
    cleanup?.portClosed === true && cleanup?.browserClosed === true,
    errors,
    'benchmark port/browser cleanup evidence missing',
  );
  const last = endpoints.find((item) => item.label === cleanup?.finalResourceLabel);
  expect(last, errors, 'cleanup final label must reference an actual three-GC resource observation');
  for (const field of ['feeds', 'listeners', 'timers', 'observers', 'dom'])
    expect(
      last?.owned?.[field] === 0 && cleanup?.ownedZeroCounts?.[field] === last?.owned?.[field],
      errors,
      `final raw grid-owned ${field} count must be zero`,
    );
  if (last) {
    checkProvider(last.provider, errors, last.label, { empty: true });
    if (last.monitor) checkMonitor(last.monitor, errors, last.label, { empty: true });
    expect(
      last.gridState === null && last.cells?.every((cell) => cell.feed === null),
      errors,
      'selected final endpoint retains a live grid/history handle',
    );
    // The runner derives ownership from the first captured empty baseline,
    // including controls endpoints captured after the phase's empty-final.
    const baseline = endpoints.find((item) => item.label.endsWith('empty-baseline'));
    expect(
      baseline && endpoints.indexOf(baseline) < endpoints.indexOf(last),
      errors,
      'selected final endpoint requires an earlier empty resource baseline',
    );
    if (baseline) {
      for (const field of ['listeners', 'timers', 'observers'])
        expect(
          nonnegative(last[field]) &&
            nonnegative(baseline[field]) &&
            last[field] <= baseline[field] &&
            last.owned?.[field] === Math.max(0, last[field] - baseline[field]) &&
            (field === 'listeners' || last.resourceTracker?.[field] === last[field]),
          errors,
          `selected final raw ${field} leak or inconsistent ownership summary`,
        );
      const rawDom = last.domOwned;
      const baselineDom = baseline.domOwned?.totalOwned?.consumer;
      expect(
        nonnegative(rawDom?.totalOwned?.consumer) &&
          nonnegative(baselineDom) &&
          rawDom.totalOwned.consumer <= baselineDom &&
          rawDom.consumer?.detached === 0 &&
          rawDom.terminal?.detached === 0 &&
          last.dom?.detached === rawDom.consumer.detached + rawDom.terminal.detached &&
          last.dom?.disposed === rawDom.terminal.detached &&
          last.owned?.dom === Math.max(0, rawDom.totalOwned.consumer - baselineDom),
        errors,
        'selected final raw DOM leak or inconsistent ownership summary',
      );
    }
    expect(
      last.owned?.feeds === last.provider?.activeSubscriptions,
      errors,
      'selected final raw feeds differ from ownership summary',
    );
  }
  const borrowed = cleanup?.borrowedUsabilityObservations;
  expect(Array.isArray(borrowed) && borrowed.length > 0, errors, 'borrowed usability observations missing');
  for (const item of borrowed ?? []) {
    expect(
      item.borrowedUsable === true &&
        item.borrowedUse?.attached === true &&
        item.borrowedUse.membersWhileAttached === 1 &&
        item.borrowedUse.membersAfterRelease === 0,
      errors,
      'borrowed monitor attach/release proof missing',
    );
    checkMonitor(item.borrowedAfterGrid, errors, 'borrowed monitor after grid', { empty: true });
    expect(
      item.borrowedAfterGrid?.destroyed === false && item.destroyedMonitor?.destroyed === true,
      errors,
      'borrowed monitor ownership lifecycle differs',
    );
    checkMonitor(item.destroyedMonitor, errors, 'destroyed harness monitor', { empty: true });
    checkProvider(item.after?.provider, errors, 'borrowed final provider', { empty: true });
  }
  const rawControls = record.ownershipControls ?? cleanup?.ownershipControls;
  const controls = Array.isArray(rawControls) ? rawControls : rawControls ? [rawControls] : [];
  expect(
    Array.isArray(controls) && controls.length > 0,
    errors,
    'default-owned and supplied-store installed controls missing',
  );
  for (const control of controls ?? []) {
    expect(
      control.defaultOwned?.populated > 0 && control.defaultOwned.store?.destroyed === true,
      errors,
      'default-owned populated store destruction missing',
    );
    checkProvider(control.defaultOwned?.provider, errors, 'default-owned provider', { empty: true });
    expect(
      control.supplied?.suppliedUsable === true &&
        control.supplied.monitorUsable === true &&
        control.supplied.afterDestroy?.length === 4 &&
        control.supplied.afterDestroy.every(
          (store) =>
            store.destroyed === false &&
            ['changeListeners', 'eventListeners', 'admissionListeners', 'lifecycleListeners'].every(
              (key) => store[key] === 0,
            ),
        ),
      errors,
      'supplied stores actual post-destroy usability missing',
    );
  }
}

function validateCapacity(record, errors, mode) {
  if (mode !== 'all' && mode !== 'capacity') return;
  const capacity = record.capacity;
  expect(
    capacity?.rules === 400 && capacity?.armedQueries === 32,
    errors,
    'separate capacity evidence must use exactly400 rules and32 queries',
  );
  for (const field of ['restoreObservations', 'failedAtomicity', 'leaseObservations'])
    expect(
      Array.isArray(capacity?.[field]) && capacity[field].length > 0,
      errors,
      `400/32 ${field} actual observations missing`,
    );
  for (const observation of capacity?.restoreObservations ?? []) {
    expect(
      observation.scope === 'capacity-400-rules-32-queries',
      errors,
      'capacity observations need separate correctness scope',
    );
    const docs = observation.documents;
    const rules = docs?.flatMap((item) => item.alerts ?? []) ?? [];
    expect(
      docs?.length === 4 &&
        docs.every((item) => item.alerts?.length === 100) &&
        rules.length === 400 &&
        new Set(rules.map((rule) => queryKey(rule.query))).size === 32 &&
        rules.every((rule) => rule.status === 'armed'),
      errors,
      'capacity actual documents must contain400 armed rules/32 exact queries',
    );
    validateActionReceipt(observation.restored, errors, 'capacity restore', new Set());
    checkMonitor(observation.admitted?.monitor, errors, 'capacity admitted');
    checkProvider(observation.admitted?.provider, errors, 'capacity admitted');
    expect(
      observation.admitted?.monitor?.members === 4 &&
        observation.admitted.monitor.activeRuntimeEntries === 32 &&
        observation.admitted.provider?.historyFeeds === 4 &&
        observation.admitted.provider?.latestFeeds === 32,
      errors,
      'capacity actual admitted feeds/members differ',
    );
    expect(
      same(
        new Set(observation.admitted?.monitor?.runtimes?.map((runtime) => queryKey(runtime.query)))?.size,
        32,
      ),
      errors,
      'capacity runtime query identities missing',
    );
  }
  expect(
    ['catalog-boundary', 'rule-overflow', 'external-same-scope-lease'].every((kind) =>
      capacity?.failedAtomicity?.some((item) => item.kind === kind),
    ),
    errors,
    'capacity catalog/rule/lease failure controls incomplete',
  );
  for (const observation of capacity?.failedAtomicity ?? []) {
    expect(
      observation.scope === 'capacity-400-rules-32-queries' &&
        typeof observation.error === 'string' &&
        observation.error.length > 0,
      errors,
      'capacity concrete rejected restore error missing',
    );
    const attemptedRules =
      observation.attempted?.cells?.flatMap((cell) => cell.workspace.alerts.alerts) ?? [];
    const attemptedQueries = new Set(
      attemptedRules.filter((rule) => rule.status === 'armed').map((rule) => queryKey(rule.query)),
    );
    expect(
      observation.kind === 'catalog-boundary'
        ? attemptedQueries.size === 33
        : observation.kind === 'rule-overflow'
          ? attemptedRules.length === 401
          : observation.kind === 'external-same-scope-lease' &&
            attemptedRules.length === 400 &&
            observation.before?.provider?.monitor?.leaseEntries > 4,
      errors,
      'capacity concrete rejected operation missing',
    );
    expect(
      observation.before &&
        observation.after &&
        same(observation.before.workspace, observation.after.workspace) &&
        same(observation.before.state, observation.after.state) &&
        same(observation.before.provider, observation.after.provider),
      errors,
      'capacity failed restore changed workspace/state/transport',
    );
  }
  for (const observation of capacity?.leaseObservations ?? []) {
    expect(
      observation.scope === 'capacity-400-rules-32-queries' &&
        observation.before?.leaseEntries > 0 &&
        same(observation.before, observation.after?.monitor),
      errors,
      'capacity actual leases changed across rejected restore',
    );
  }
}

function validateSync(record, errors) {
  const scope = record.scene?.scopes?.maximum;
  if (!scope) return;
  const scene = reconstructScene(record.scene, 'maximum');
  const prefix = checkpointPrefix(record.checkpoints?.find((item) => item.id === 'max-interactions'));
  if (!Number.isInteger(prefix)) return;
  const data = new Map(
    CELL_IDS.map((id) => [id, replayGridRows(scene, id, scope.mutations.slice(0, prefix))]),
  );
  for (const category of ['syncExact', 'syncNearest'])
    for (const action of record.actions?.[category] ?? []) {
      const observation = action.syncObservation;
      const requested = observation?.requested;
      const match = category === 'syncExact' ? 'exact' : 'nearest';
      expect(
        observation &&
          requested?.match === match &&
          requested.kind === action.kind &&
          CELL_IDS.includes(requested.sourceCellId) &&
          observation.after?.length === 4 &&
          observation.before?.length === 4,
        errors,
        `${action.id} actual semantic sync observation missing`,
      );
      if (!observation || !requested) continue;
      if (action.kind === 'range') {
        const sourceRows = data.get(requested.sourceCellId)?.rows ?? [];
        const picked = sourceRows.filter(
          (bar) => bar.time >= requested.range?.from && bar.time <= requested.range?.to,
        );
        const sourceRange = picked.length ? { from: picked[0].time, to: picked.at(-1).time } : null;
        expect(
          sourceRange &&
            !same(
              observation.before.find((item) => item.cellId === requested.sourceCellId)?.timeRange,
              sourceRange,
            ),
          errors,
          `${action.id} effective source range missing`,
        );
        for (const id of CELL_IDS) {
          const after = observation.after.find((item) => item.cellId === id);
          const before = observation.before.find((item) => item.cellId === id);
          const rows = data.get(id).rows;
          let matches = sourceRange
            ? rows.filter((bar) => bar.time >= sourceRange.from && bar.time <= sourceRange.to)
            : [];
          if (matches.length === 1) {
            const index = rows.indexOf(matches[0]);
            matches =
              index + 1 < rows.length ? [rows[index], rows[index + 1]] : [rows[index - 1], rows[index]];
          }
          const expected = matches.length
            ? { from: matches[0].time, to: matches.at(-1).time }
            : before?.timeRange;
          expect(
            after && same(after.query, data.get(id).query) && same(after.timeRange, expected),
            errors,
            `${action.id}/${id} synchronized range differs from own target timeline`,
          );
          if (after && !same(before?.timeRange, after.timeRange)) {
            const event = observation.rangeEvents?.findLast((item) => item.cellId === id);
            const first = event && Math.max(0, Math.ceil(event.range?.from)),
              last = event && Math.min(rows.length - 1, Math.floor(event.range?.to));
            expect(
              event &&
                finite(event.at) &&
                event.at >= action.dispatchedAt &&
                event.at <= action.settledAt &&
                event.meta?.hasOrigin === (id !== requested.sourceCellId) &&
                same(after.timeRange, { from: rows[first]?.time, to: rows[last]?.time }),
              errors,
              `${action.id}/${id} range change lacks matching raw event/time/origin`,
            );
          }
        }
      } else if (action.kind === 'cursor') {
        expect(
          observation.afterCrosshair?.length === 4 && Array.isArray(observation.crosshairEvents),
          errors,
          `${action.id} actual source/receiver cursor outputs missing`,
        );
        for (const id of CELL_IDS) {
          const target = data.get(id),
            rows = target.rows;
          let bar = rows.find((bar) => bar.time === requested.time);
          if (!bar && match === 'nearest') {
            // Nearest clamps to endpoint rows; ties use the earlier row.
            bar = rows.reduce(
              (best, item) =>
                Math.abs(item.time - requested.time) < Math.abs(best.time - requested.time) ? item : best,
              rows[0],
            );
          }
          const actual = observation.afterCrosshair?.find((item) => item.cellId === id);
          const visible = observation.after?.find((item) => item.cellId === id)?.timeRange;
          if (bar && (!visible || bar.time < visible.from || bar.time > visible.to)) bar = undefined;
          expect(
            actual && same(actual.query, target.query) && actual.time === (bar?.time ?? null),
            errors,
            `${action.id}/${id} synchronized cursor exact/nearest resolution differs`,
          );
          const event = observation.crosshairEvents?.findLast((item) => item.cellId === id);
          expect(
            event &&
              event.time === (bar?.time ?? null) &&
              same(event.points, actual?.points) &&
              finite(event.at) &&
              event.at >= action.dispatchedAt &&
              event.at <= action.settledAt &&
              event.meta?.cause === 'api' &&
              Number.isInteger(event.meta?.revision) &&
              event.meta.revision > 0 &&
              event.meta.hasOrigin === (id !== requested.sourceCellId),
            errors,
            `${action.id}/${id} cursor state not backed by actual event/time/origin`,
          );
          if (bar) {
            const point = actual?.points?.['terminal-price'];
            expect(
              point &&
                ['time', 'open', 'high', 'low', 'close', 'volume'].every((field) =>
                  compareFinite(point[field], bar[field]),
                ),
              errors,
              `${action.id}/${id} cursor values must come from receiver's own OHLCV`,
            );
          } else {
            const points = actual?.points;
            expect(
              points &&
                typeof points === 'object' &&
                Object.hasOwn(points, 'terminal-price') &&
                Object.values(points).every((point) => point === null),
              errors,
              `${action.id}/${id} cleared cursor must have only null series points`,
            );
          }
        }
      }
    }
}

function validateProviderRequests(record, errors, modes) {
  const requests = record.providerRequests;
  expect(
    Array.isArray(requests) && requests.length > 0,
    errors,
    'actual cumulative provider request lifecycle ledger missing',
  );
  if (!Array.isArray(requests)) return;
  for (const [scope, label] of [
    ['maximum', 'maximum'],
    ['full', 'bounded-full-256'],
    ['capacity', 'capacity-400-rules-32-queries'],
  ])
    if (modes.has(scope))
      expect(
        requests.some((item) => item.scope === label),
        errors,
        `${label} provider request scope omitted`,
      );
  const finalResource = record.resources?.find((item) => item.label === record.cleanup?.finalResourceLabel);
  expect(
    finalResource?.provider?.requests === requests.length,
    errors,
    'final provider cumulative request count differs from actual request ledger',
  );
  expect(
    new Set(requests.map((item) => item.id)).size === requests.length,
    errors,
    'provider request lifecycle IDs must be unique',
  );
  for (const item of requests) {
    expect(
      typeof item.id === 'string' &&
        Number.isInteger(item.providerGeneration) &&
        item.providerGeneration > 0 &&
        typeof item.scope === 'string' &&
        validQuery(item.query) &&
        item.key === queryKey(item.query),
      errors,
      'provider request identity/generation/scope invalid',
    );
    expect(
      Number.isInteger(item.limit) &&
        item.limit > 0 &&
        item.limit <= 10000 &&
        item.requestKind === (item.limit === 1 ? 'latest-protocol' : 'history-protocol'),
      errors,
      'public request page limit/mode invalid',
    );
    expect(
      finite(item.startedAt) &&
        finite(item.finishedAt) &&
        item.finishedAt >= item.startedAt &&
        ['fulfilled', 'rejected'].includes(item.status),
      errors,
      'provider request remains unresolved or has invalid settlement timestamps',
    );
    if (item.status === 'fulfilled')
      expect(
        Number.isInteger(item.returned) &&
          item.returned >= 0 &&
          item.returned <= item.limit &&
          typeof item.exhausted === 'boolean',
        errors,
        'actual fulfilled history page length/exhaustion missing',
      );
    if (item.status === 'rejected')
      expect(
        typeof item.error === 'string' &&
          item.error.length > 0 &&
          item.rejectedAfterObservedAbort === (item.abortObservedAt !== null),
        errors,
        'actual rejected request error/abort lifecycle inconsistent',
      );
    if (item.abortObservedAt !== null)
      expect(
        finite(item.abortObservedAt) &&
          item.abortObservedAt >= item.startedAt &&
          item.abortObservedAt <= item.finishedAt &&
          typeof item.abortReason === 'string',
        errors,
        'observed pending request abort outside request lifetime',
      );
    if (item.abortObservedAfterFulfillmentAt != null)
      expect(
        item.status === 'fulfilled' &&
          finite(item.abortObservedAfterFulfillmentAt) &&
          item.abortObservedAfterFulfillmentAt >= item.startedAt &&
          item.abortObservedAfterFulfillmentAt <= item.finishedAt,
        errors,
        'post-fulfillment abort observation invalid',
      );
  }
  if (modes.has('maximum'))
    for (const action of [...(record.actions?.constructions ?? []), ...(record.actions?.restores ?? [])]) {
      const first = action.providerBefore?.requests,
        last = action.providerAfter?.requests;
      expect(
        Number.isInteger(first) && Number.isInteger(last) && last > first && last <= requests.length,
        errors,
        `${action.id} actual hydration request ledger span missing`,
      );
      if (!Number.isInteger(first) || !Number.isInteger(last)) continue;
      const pages = requests.slice(first, last);
      expect(
        pages.every((item) => item.startedAt >= action.dispatchedAt && item.finishedAt <= action.hydratedAt),
        errors,
        `${action.id} request span falls outside measured hydration`,
      );
      for (const cell of record.scene.scopes.maximum.cells)
        expect(
          pages
            .filter(
              (item) =>
                item.status === 'fulfilled' &&
                item.requestKind === 'history-protocol' &&
                same(item.query, cell.query),
            )
            .reduce((sum, item) => sum + item.returned, 0) >= 100000,
          errors,
          `${action.id}/${cell.id} full100000 hydration lacks actual paged responses`,
        );
      const expectedKeys = record.scene.scopes.maximum.monitorSources
        .map((item) => queryKey(item.query))
        .sort();
      expect(
        same(
          action.hydration?.monitor?.runtimes
            ?.filter((item) => item.active)
            .map((item) => queryKey(item.query))
            .sort(),
          expectedKeys,
        ),
        errors,
        `${action.id} hydrated latest query ownership differs from fixed8keys`,
      );
    }
}

function validateEnvironment(record, errors) {
  const environment = record.environment;
  expect(
    environment?.deviceScaleFactor === 1 &&
      environment.viewport?.width === 1600 &&
      environment.viewport?.height === 1000,
    errors,
    'actual viewport/DPR metadata missing',
  );
  for (const key of ['browser', 'os', 'cpu', 'platform'])
    expect(
      typeof environment?.[key] === 'string' && environment[key].length > 0,
      errors,
      `actual ${key} metadata missing`,
    );
  expect(
    Array.isArray(environment?.visibility) &&
      environment.visibility.length > 0 &&
      environment.visibility.every(
        (entry, index, entries) =>
          entry.state === 'visible' && finite(entry.at) && (index === 0 || entry.at >= entries[index - 1].at),
      ),
    errors,
    'hidden-tab or missing visibility timeline',
  );
}

function validateSemanticAction(action, errors) {
  if (
    !['construct', 'restore', 'layout', 'active', 'drawing', 'study', 'pane', 'market'].includes(action.kind)
  )
    return;
  const proof = action.semanticObservation,
    requested = action.requested;
  expect(
    proof && requested && requested.kind === action.kind && same(proof.requested, requested),
    errors,
    `${action.id} raw semantic request/before/after proof missing`,
  );
  if (!proof || !requested) return;
  const before = proof.before,
    after = proof.after;
  if (['construct', 'restore'].includes(action.kind)) {
    expect(
      after?.workspace?.cells?.length === 4 && after.workspace.layout === 4,
      errors,
      `${action.id} actual complete constructed/restored workspace missing`,
    );
    if (requested.workspace)
      expect(
        sameOracleState(after.workspace, requested.workspace),
        errors,
        `${action.id} actual restore differs from supplied saved workspace`,
      );
  } else if (action.kind === 'layout')
    expect(
      before?.state?.layout !== requested.layout && after?.state?.layout === requested.layout,
      errors,
      `${action.id} actual layout transition ineffective`,
    );
  else if (action.kind === 'active')
    expect(
      before?.state?.activeCellId !== requested.cellId && after?.state?.activeCellId === requested.cellId,
      errors,
      `${action.id} actual active-cell transition ineffective`,
    );
  else {
    const prior = before?.workspace?.cells?.find((cell) => cell.id === requested.cellId)?.workspace;
    const actual = after?.workspace?.cells?.find((cell) => cell.id === requested.cellId)?.workspace;
    expect(prior && actual, errors, `${action.id} current edited cell workspace missing`);
    if (!prior || !actual) return;
    if (action.kind === 'market')
      expect(
        !same(prior.query, actual.query) && same(actual.query, requested.query),
        errors,
        `${action.id} actual market change differs from request`,
      );
    if (action.kind === 'pane')
      expect(
        !same(prior.layout, actual.layout) &&
          requested.panes?.every((pane) =>
            actual.layout.panes.some((item) => item.id === pane.id && item.weight === pane.weight),
          ),
        errors,
        `${action.id} actual pane weights differ from request`,
      );
    if (action.kind === 'study') {
      const original = prior.studies?.find((study) => study.id === requested.studyId),
        got = actual.studies?.find((study) => study.id === requested.studyId);
      expect(
        original && got && !same(original, got) && same(got, { ...original, ...requested.patch }),
        errors,
        `${action.id} actual study edit differs from request`,
      );
    }
    if (action.kind === 'drawing') {
      const original = prior.markets
        ?.find((item) => same(item.query, prior.query))
        ?.drawings?.drawings?.find((item) => item.id === requested.drawingId);
      const got = actual.markets
        ?.find((item) => same(item.query, actual.query))
        ?.drawings?.drawings?.find((item) => item.id === requested.drawingId);
      const want = original && {
        ...original,
        ...requested.patch,
        ...(requested.patch?.style ? { style: { ...original.style, ...requested.patch.style } } : {}),
      };
      expect(
        original && got && !same(original, got) && same(got, want),
        errors,
        `${action.id} actual drawing edit differs from current-market request`,
      );
    }
  }
}

function validateTransitions(record, errors, modes) {
  const actions = record.actions ?? {};
  const byId = new Map();
  const collect = (item) => {
    if (item?.id) byId.set(item.id, item);
    for (const key of ['one', 'four', 'receipt', 'parked', 'remounted', 'setup'])
      if (item?.[key]) collect(item[key]);
  };
  for (const list of Object.values(actions)) if (Array.isArray(list)) list.forEach(collect);
  for (const item of byId.values()) if (finite(item.dispatchedAt)) validateSemanticAction(item, errors);
  const cadence = (list, name) => {
    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      expect(
        finite(item.targetAt) && item.dispatchedAt >= item.targetAt - 1,
        errors,
        `${name} missing/early intended cadence timestamp`,
      );
      if (index) {
        expect(
          Math.abs(item.targetAt - list[index - 1].targetAt - 40) < 0.01,
          errors,
          `${name} target clock must independently advance40ms`,
        );
        expect(
          item.dispatchedAt >= list[index - 1].settledAt,
          errors,
          `${name} overlapping action/render attribution`,
        );
      }
    }
  };
  for (const name of ['tailReplace', 'tailAppendReplace', 'interaction', 'syncExact', 'syncNearest', 'soak'])
    cadence(actions[name] ?? [], name);
  for (const scopeName of ['maximum', 'full']) {
    if (!modes.has(scopeName)) continue;
    const scope = record.scene?.scopes?.[scopeName];
    if (!scope || !Array.isArray(scope.mutations)) continue;
    const mutations = scope.mutations;
    const cps =
      record.checkpoints?.filter(
        (item) => item.scope === (scopeName === 'maximum' ? 'maximum-sampled' : 'full-256'),
      ) ?? [];
    let previous = 0;
    for (const cp of cps) {
      const prefix = checkpointPrefix(cp);
      expect(
        Number.isInteger(prefix) && prefix >= previous && prefix <= mutations.length,
        errors,
        `${cp.id} chronological checkpoint prefix invalid`,
      );
      const part = mutations.slice(previous, prefix);
      const requirePerCell = (operation, count) =>
        expect(
          CELL_IDS.every(
            (id) =>
              part.filter((item) => item.operation === operation && item.cellId === id).length === count,
          ),
          errors,
          `${cp.id} actual ${operation} transitions missing/wrong count`,
        );
      if (cp.id === 'full-tail-replacement') requirePerCell('replace', 1);
      if (cp.id === 'full-append-255-to-256') {
        requirePerCell('source-reset', 1);
        requirePerCell('append', 1);
        expect(
          part.filter((item) => item.operation === 'source-reset').every((item) => item.rowCount === 255),
          errors,
          'full append must explicitly start255',
        );
      }
      if (cp.id === 'full-drawing-edit') requirePerCell('drawing-edit', 1);
      if (cp.id === 'full-study-parameter-edit') requirePerCell('study-edit', 1);
      if (cp.id === 'full-pane-edit') requirePerCell('pane-edit', 1);
      for (const [id, operation] of [
        ['full-market-switch', 'market-switch'],
        ['full-interval-switch', 'interval-switch'],
        ['full-parked-once-crossing-remount', 'parked-once-crossing'],
        ['full-save-restore', 'save-restore'],
        ['full-zero-size-recovery', 'zero-size-recovery'],
      ])
        if (cp.id === id)
          expect(
            part.filter((item) => item.operation === operation).length === 1,
            errors,
            `${id} required operation missing`,
          );
      if (cp.id === 'max-replacements') requirePerCell('replace', 100);
      if (cp.id === 'max-append-replacements') {
        requirePerCell('source-reset', 1);
        requirePerCell('append', 100);
        requirePerCell('replace', 100);
        expect(
          part.filter((item) => item.operation === 'source-reset').every((item) => item.rowCount === 99900),
          errors,
          'maximum append must explicitly start99900',
        );
      }
      if (cp.id === 'max-interactions') {
        requirePerCell('drawing-edit', 10);
        requirePerCell('pane-edit', 10);
      }
      if (['max-sync-exact', 'max-sync-nearest'].includes(cp.id))
        expect(
          part.some((item) => item.operation === 'sync' && item.match === cp.id.slice(9)),
          errors,
          `${cp.id} sync transition missing`,
        );
      previous = prefix;
    }
    expect(
      previous === mutations.length,
      errors,
      `${scopeName} trailing mutations omitted from final checkpoint`,
    );
    for (const source of scope.sourceRows ?? [])
      expect(
        same(
          source.orderedMutations,
          mutations.filter((item) => item.cellId === source.cellId),
        ),
        errors,
        `${scopeName} per-cell ordered mutation ledger differs`,
      );
    const resets = mutations.filter((item) => item.operation === 'source-reset');
    for (const resetId of new Set(resets.map((item) => item.checkpointId))) {
      const reset = resets.find((item) => item.checkpointId === resetId);
      const proof = (actions.lifecycle ?? []).find(
        (item) => item.kind === 'source-reset' && item.id === resetId,
      );
      expect(
        proof &&
          proof.rowCount === reset.rowCount &&
          proof.before?.cells?.filter((cell) => cell.feed).length === 4 &&
          proof.before.cells.every((cell) => cell.rows === (scopeName === 'maximum' ? 100000 : 256)) &&
          proof.after?.cells?.filter((cell) => cell.feed).length === 4 &&
          proof.after.cells.every((cell) => cell.rows === reset.rowCount) &&
          proof.setup?.kind === 'construct',
        errors,
        `${resetId} public destroy/recreate row reset proof missing`,
      );
      if (proof)
        checkProvider(proof.retirement?.after?.provider, errors, `${resetId} retired source setup`, {
          empty: true,
        });
    }
    const deliveries = mutations.filter((item) => item.operation === 'monitor-update');
    const deliveryKey = (checkpointId, query, bar) =>
      JSON.stringify([
        checkpointId,
        queryKey(query),
        bar?.time,
        bar?.open,
        bar?.high,
        bar?.low,
        bar?.close,
        bar?.volume,
        bar?.revision ?? null,
      ]);
    const deliveryIndex = new Map();
    for (const item of deliveries) {
      const key = deliveryKey(item.checkpointId, item.query, item.bar);
      if (!deliveryIndex.has(key)) deliveryIndex.set(key, item.sequence);
    }
    const currentQuery = new Map(scope.cells.map((cell) => [cell.id, cell.query]));
    for (const mutation of mutations) {
      if (['market-switch', 'interval-switch'].includes(mutation.operation)) {
        const prior = currentQuery.get(mutation.cellId);
        expect(
          mutation.operation === 'interval-switch'
            ? mutation.query?.symbol === prior?.symbol && mutation.query.interval !== prior.interval
            : mutation.query?.symbol !== prior?.symbol,
          errors,
          `${mutation.checkpointId} ineffective or wrong market/interval change`,
        );
        currentQuery.set(mutation.cellId, mutation.query);
      }
      if (['replace', 'append'].includes(mutation.operation)) {
        expect(
          deliveryIndex.get(
            deliveryKey(mutation.checkpointId, currentQuery.get(mutation.cellId), mutation.bar),
          ) < mutation.sequence,
          errors,
          `${mutation.checkpointId}/${mutation.cellId} source mutation lacks matching actual delivery`,
        );
      }
    }
    expect(
      deliveries.length > 0 && new Set(deliveries.map((item) => item.deliveryId)).size === deliveries.length,
      errors,
      `${scopeName} complete unique alert delivery chronology missing`,
    );
    for (const delivery of deliveries) {
      const id = delivery.deliveryId?.replace(/:\d+$/, '');
      const receipt = byId.get(id);
      const index = Number(delivery.deliveryId?.split(':').at(-1)) - 1;
      const actual = receipt?.deliveries?.[index] ?? receipt?.providerDeliveries?.[index];
      expect(
        receipt &&
          delivery.dispatchedAt === receipt.dispatchedAt &&
          actual &&
          queryKey(delivery.query) === (actual.key ?? queryKey(actual.query)) &&
          same(delivery.bar, actual.bar),
        errors,
        `${scopeName} ordered alert delivery not bound to actual dispatch ${delivery.deliveryId}`,
      );
    }
    for (const receipt of byId.values()) {
      const relevant =
        scopeName === 'maximum'
          ? /maximum|sync-|soak|real-wheel|resource-control/.test(receipt.phase ?? '')
          : receipt.phase === 'correctness-only';
      if (relevant && receipt.kind === 'deliver')
        expect(
          deliveries.filter((item) => item.deliveryId?.startsWith(receipt.id + ':')).length ===
            receipt.deliveries?.length && receipt.deliveries?.length > 0,
          errors,
          `${scopeName} actual delivery omitted from independent alert ledger`,
        );
    }
  }
  if (modes.has('maximum')) {
    for (const [category, kind] of [
      ['warmup', 'construct'],
      ['constructions', 'construct'],
      ['restores', 'restore'],
      ['tailReplace', 'deliver'],
      ['tailAppendReplace', 'deliver'],
      ['soak', 'deliver'],
    ])
      expect(
        (actions[category] ?? []).every((item) => item.kind === kind && same(item.affectedCellIds, CELL_IDS)),
        errors,
        `${category} wrong/no-op kind or four-cell attribution`,
      );
    for (const item of [...(actions.constructions ?? []), ...(actions.restores ?? [])]) {
      expect(
        finite(item.restoreFulfilledAt) && finite(item.hydratedAt) && item.hydratedAt <= item.settledAt,
        errors,
        `${item.id} actual restore/hydration endpoints missing`,
      );
      const hydration = item.hydration;
      expect(
        hydration?.cells?.length === 4 &&
          hydration.cells.every(
            (cell) =>
              cell.rows === 100000 && cell.feed?.status === 'live' && same(cell.query, cell.feed.query),
          ) &&
          hydration.monitor?.activeRuntimeEntries === 8,
        errors,
        `${item.id} actual four100k histories/eight latest hydration proof missing`,
      );
      if (hydration?.monitor) checkMonitor(hydration.monitor, errors, item.id);
    }
    for (const id of CELL_IDS) {
      const interactions = (actions.interaction ?? []).filter((item) => actionTargetCell(item) === id);
      for (const [kind, count] of [
        ['pan', 20],
        ['zoom', 20],
        ['drawing', 10],
        ['pane', 10],
      ])
        expect(
          interactions.filter(
            (item) =>
              (item.gesture ?? item.requested?.gesture ?? item.effectiveObservation?.gesture ?? item.kind) ===
              kind,
          ).length === count,
          errors,
          `${id} exact20pan20zoom10drawing10pane interaction mix missing`,
        );
      expect(
        (actions.wheel ?? []).filter((item) => actionTargetCell(item) === id).length === 6,
        errors,
        `${id} six real wheel inputs required`,
      );
      for (const category of ['syncExact', 'syncNearest']) {
        const sync = (actions[category] ?? []).filter((item) => item.syncObservation?.sourceCellId === id);
        expect(
          sync.length === 6 &&
            sync.filter((item) => item.kind === 'range').length === 3 &&
            sync.filter((item) => item.kind === 'cursor').length === 3,
          errors,
          `${id} ${category} exact pan/crosshair source mix missing`,
        );
      }
    }
    for (const item of actions.interaction ?? []) {
      const proof = item.kind === 'gesture' ? item.effectiveObservation : item.semanticObservation;
      expect(
        proof &&
          (item.kind === 'gesture'
            ? proof.beforeRange && proof.afterRange && !same(proof.beforeRange, proof.afterRange)
            : proof.before && proof.after && !same(proof.before, proof.after)),
        errors,
        `${item.id} actual effective interaction change missing`,
      );
    }
    for (const [category, count] of [
      ['tailReplace', 4],
      ['tailAppendReplace', 8],
      ['soak', 12],
    ])
      for (const item of actions[category] ?? [])
        expect(
          item.deliveries?.length === count,
          errors,
          `${item.id} actual ${count} original provider inputs missing`,
        );
    const scope = record.scene.scopes.maximum;
    const soakQueryOrder = [
      ...scope.cells.map((cell) => queryKey(cell.query)),
      ...scope.monitorSources.map((source) => queryKey(source.query)),
    ];
    for (const item of actions.soak ?? [])
      expect(
        same(
          item.deliveries?.map((delivery) => delivery.key),
          soakQueryOrder,
        ),
        errors,
        `${item.id} original inputs must follow four chart queries then eight monitor queries`,
      );
  }
  if (modes.has('full')) {
    const lifecycle = actions.lifecycle ?? [];
    for (const [id, kind] of [
      ['full-initial-setup-action', 'construct'],
      ['full-tail-replacement-action', 'deliver'],
      ['full-append-255-to-256-action', 'deliver'],
      ['full-market-switch-action', 'market'],
      ['full-interval-switch-action', 'market'],
      ['full-save-restore-action', 'restore'],
      ['full-zero-size', 'size'],
      ['full-size-recovery', 'size'],
    ])
      expect(byId.get(id)?.kind === kind, errors, `${id} actual operation receipt missing`);
    const parked = lifecycle.find((item) => item.kind === 'parked-once-proof');
    const id = 'grid-workload:cell-4:17';
    const get = (document) => document?.alerts?.find((rule) => rule.id === id);
    expect(
      get(parked?.beforeParked)?.status === 'armed' &&
        get(parked?.duringParked)?.status === 'triggered' &&
        get(parked?.duringParked)?.triggerCount === 1 &&
        same(parked?.duringParked, parked?.afterParked),
      errors,
      'actual parked once crossing/remount preservation missing',
    );
    expect(
      byId.get('full-zero-size')?.effectiveObservation?.afterRect?.width === 0 &&
        byId.get('full-zero-size')?.effectiveObservation?.afterRect?.height === 0 &&
        byId.get('full-size-recovery')?.effectiveObservation?.afterRect?.width === 1600 &&
        byId.get('full-size-recovery')?.effectiveObservation?.afterRect?.height === 1000,
      errors,
      'actual zero-size/recovery rectangles missing',
    );
  }
  if (modes.has('soak')) {
    const start = record.soakStartedAt,
      end = record.soakCompletedAt;
    const pauses = record.soakPauses;
    expect(
      finite(start) &&
        finite(end) &&
        end - start >= 120000 &&
        Math.abs(end - start - record.coverage?.soakElapsedMs) < 0.01,
      errors,
      'soak elapsed claim differs from actual start/end timestamps',
    );
    expect(Array.isArray(pauses), errors, 'actual soak lifecycle pauses missing');
    let pauseDuration = 0;
    for (let i = 0; i < (pauses?.length ?? 0); i++) {
      const pause = pauses[i];
      expect(
        finite(pause.startedAt) &&
          finite(pause.completedAt) &&
          pause.startedAt >= start &&
          pause.completedAt >= pause.startedAt &&
          pause.completedAt <= end &&
          (!i || pause.startedAt >= pauses[i - 1].completedAt),
        errors,
        'invalid/overlapping soak lifecycle pause',
      );
      pauseDuration += pause.completedAt - pause.startedAt;
    }
    expect(
      Math.abs(record.soakEffectiveRunningMs - (end - start - pauseDuration)) < 0.01,
      errors,
      'soak effective running time differs from raw pauses',
    );
    const lifecycle = actions.lifecycle ?? [];
    const counts = {
      parkCycles: lifecycle.filter((item) => item.kind === 'park-cycle').length,
      activeChanges: lifecycle.filter((item) => item.kind === 'active' && item.phase === 'soak-lifecycle')
        .length,
      restores: lifecycle.filter((item) => item.kind === 'restore' && item.phase === 'soak-lifecycle').length,
      destroyRecreates: lifecycle.filter((item) => item.kind === 'destroy-recreate').length,
    };
    for (const item of lifecycle.filter((item) => item.kind === 'park-cycle'))
      expect(
        item.one?.requested?.layout === 1 &&
          item.four?.requested?.layout === 4 &&
          item.four.dispatchedAt >= item.one.settledAt,
        errors,
        'soak park cycle must actually transition4→1→4 in order',
      );
    for (const item of lifecycle.filter((item) => item.kind === 'destroy-recreate'))
      checkProvider(item.retired?.after?.provider, errors, 'soak retired grid', { empty: true });
    expect(
      same(counts, { parkCycles: 10, activeChanges: 20, restores: 10, destroyRecreates: 6 }) &&
        same(counts, record.coverage?.lifecycleCounts),
      errors,
      'soak lifecycle summary differs from actual receipts',
    );
    expect(
      (actions.soak?.length ?? 0) >= 2 &&
        actions.soak.every((item) => item.dispatchedAt >= start && item.settledAt <= end),
      errors,
      'actual soak dispatch span missing',
    );
    expect(
      same(
        record.coverage?.soakCadence
          ?.filter((item) => item.phase === 'soak')
          .map((item) => [item.targetAt, item.dispatchedAt, item.completedAt]),
        actions.soak?.map((item) => [item.targetAt, item.dispatchedAt, item.settledAt]),
      ),
      errors,
      'soak cadence differs from actual dispatch/settlement records',
    );
    expect(
      actions.soak?.at(-1)?.settledAt >= end - 1000,
      errors,
      'soak last delivery does not cover measured120second interval',
    );
  }
}

export function validateGridEvidence(record, options = {}) {
  const mode = options.mode ?? record?.mode;
  const errors = [];
  expect(
    record?.schema === 'filtix-grid-installed-evidence' && record?.version === 1,
    errors,
    'unsupported grid evidence schema/version',
  );
  expect(
    ['all', 'max', 'soak', 'full', 'capacity'].includes(mode) && record?.mode === mode,
    errors,
    'grid evidence mode mismatch',
  );
  if (!['all', 'max', 'soak', 'full', 'capacity'].includes(mode)) return { valid: false, errors };
  errors.push(...trustedIdentityErrors(record.identity, options.expectedIdentity));
  const modes = new Set(
    mode === 'all'
      ? ['maximum', 'full', 'soak', 'capacity']
      : mode === 'max'
        ? ['maximum']
        : mode === 'soak'
          ? ['maximum', 'soak']
          : mode === 'full'
            ? ['full']
            : ['capacity'],
  );
  const gates = [
    ['scene', () => validateScene(record, errors, modes)],
    ['checkpoints', () => validateCheckpoints(record, errors, modes, mode)],
    ['actions', () => validateActions(record, errors, modes, mode)],
    ['resources', () => validateResources(record, errors, modes, mode)],
    ['capacity', () => validateCapacity(record, errors, mode)],
    ['transitions', () => validateTransitions(record, errors, modes)],
    ['environment', () => validateEnvironment(record, errors)],
    ['requests', () => validateProviderRequests(record, errors, modes)],
    [
      'sync',
      () => {
        if (modes.has('maximum')) validateSync(record, errors);
      },
    ],
  ];
  for (const [name, validate] of gates) {
    try {
      validate();
    } catch (failure) {
      errors.push(`${name} malformed/incomplete evidence: ${failure.message}`);
    }
  }
  const unsupportedClaims = Object.values(record.coverage?.renderedCoverageLabels ?? {})
    .map((item) => item.label ?? '')
    .join(' | ')
    .toLowerCase();
  expect(
    !/exhaustive.{0,24}100k|100k.{0,24}exhaustive/.test(unsupportedClaims),
    errors,
    'sampled maximum evidence cannot claim exhaustive100k rendered output',
  );
  expect(
    !/400.{0,12}32.{0,24}performance|performance.{0,24}400.{0,12}32/.test(unsupportedClaims),
    errors,
    'capacity correctness does not prove400/32 performance',
  );
  expect(Array.isArray(record.failures), errors, 'retained failure array missing');
  if (Array.isArray(record.failures) && record.failures.length > 0)
    errors.push(`evidence contains ${record.failures.length} retained failure(s)`);
  return { valid: errors.length === 0, errors };
}
