/**
 * Installs an audit-only registry for application-authored structural light-DOM nodes.
 *
 * The function is intentionally closure-free so Playwright can serialize it
 * through browserContext.addInitScript() before the application mounts.
 */
export function installOwnedDomTracker(options = {}) {
  const consumerRootSelector = options.consumerRootSelector ?? '#root';
  const terminalRootSelector = options.terminalRootSelector ?? '[data-filtix-terminal]';
  const globalName = options.globalName ?? '__filtixOwnedDomTracker';

  if (typeof consumerRootSelector !== 'string' || consumerRootSelector.length === 0) {
    throw new TypeError('consumerRootSelector must be a non-empty string');
  }
  if (typeof terminalRootSelector !== 'string' || terminalRootSelector.length === 0) {
    throw new TypeError('terminalRootSelector must be a non-empty string');
  }
  if (typeof globalName !== 'string' || globalName.length === 0) {
    throw new TypeError('globalName must be a non-empty string');
  }
  if (globalThis[globalName]) return globalThis[globalName];

  document.querySelector(consumerRootSelector);
  document.querySelector(terminalRootSelector);

  const state = {
    records: [],
    seenNodes: new WeakSet(),
    recordByNode: new WeakMap(),
    consumerRootIds: new WeakMap(),
    terminalGenerations: new WeakMap(),
    consumerRootIdsSeen: new Set(),
    terminalGenerationsSeen: new Set(),
    nextConsumerRootId: 1,
    nextTerminalGeneration: 1,
    mutationRecordsProcessed: 0,
  };

  const typeName = (node) => {
    if (node.nodeType === 1) return 'element';
    if (node.nodeType === 3) return 'text';
    if (node.nodeType === 8) return 'comment';
    return 'other';
  };

  const consumerRootId = (root) => {
    let id = state.consumerRootIds.get(root);
    if (id === undefined) {
      id = state.nextConsumerRootId;
      state.nextConsumerRootId += 1;
      state.consumerRootIds.set(root, id);
      state.consumerRootIdsSeen.add(id);
    }
    return id;
  };

  const terminalGeneration = (root) => {
    let generation = state.terminalGenerations.get(root);
    if (generation === undefined) {
      generation = state.nextTerminalGeneration;
      state.nextTerminalGeneration += 1;
      state.terminalGenerations.set(root, generation);
      state.terminalGenerationsSeen.add(generation);
    }
    return generation;
  };

  const nearestContext = (node) => {
    const element = node.nodeType === 1 ? node : node.parentElement;

    let foundConsumerRootId = null;
    let foundTerminalGeneration = null;
    for (let current = element; current; current = current.parentElement) {
      if (foundTerminalGeneration === null && current.matches(terminalRootSelector)) {
        foundTerminalGeneration = terminalGeneration(current);
      }
      if (foundConsumerRootId === null && current.matches(consumerRootSelector)) {
        foundConsumerRootId = consumerRootId(current);
      }
    }
    return {
      consumerRootId: foundConsumerRootId,
      terminalGeneration: foundTerminalGeneration,
    };
  };

  const registerNode = (node, context, flags = {}) => {
    if (context.consumerRootId === null && context.terminalGeneration === null) return;
    let record = state.recordByNode.get(node);
    if (record === undefined) {
      if (state.seenNodes.has(node)) throw new Error('Owned DOM tracker registry invariant failed');
      record = {
        ref: new WeakRef(node),
        type: typeName(node),
        consumerRootId: context.consumerRootId,
        terminalGeneration: context.terminalGeneration,
        isConsumerRoot: Boolean(flags.isConsumerRoot),
        isTerminalRoot: Boolean(flags.isTerminalRoot),
      };
      state.seenNodes.add(node);
      state.recordByNode.set(node, record);
      state.records.push(record);
      return;
    }
    if (record.consumerRootId === null && context.consumerRootId !== null) {
      record.consumerRootId = context.consumerRootId;
    }
    if (record.terminalGeneration === null && context.terminalGeneration !== null) {
      record.terminalGeneration = context.terminalGeneration;
    }
    record.isConsumerRoot ||= Boolean(flags.isConsumerRoot);
    record.isTerminalRoot ||= Boolean(flags.isTerminalRoot);
  };

  const registerTree = (node, inheritedContext) => {
    let context = inheritedContext;
    let isConsumerRoot = false;
    let isTerminalRoot = false;

    if (node.nodeType === 1) {
      if (node.matches(consumerRootSelector)) {
        isConsumerRoot = true;
        context = { ...context, consumerRootId: consumerRootId(node) };
      }
      if (node.matches(terminalRootSelector)) {
        isTerminalRoot = true;
        context = { ...context, terminalGeneration: terminalGeneration(node) };
      }
    }

    registerNode(node, context, { isConsumerRoot, isTerminalRoot });
    for (const child of node.childNodes) registerTree(child, context);
  };

  const discoverCurrentRoots = () => {
    const consumerRoots = document.querySelectorAll(consumerRootSelector);
    for (const root of consumerRoots) {
      registerTree(root, { consumerRootId: consumerRootId(root), terminalGeneration: null });
    }

    const terminalRoots = document.querySelectorAll(terminalRootSelector);
    for (const root of terminalRoots) {
      const context = nearestContext(root);
      registerTree(root, {
        consumerRootId: context.consumerRootId,
        terminalGeneration: terminalGeneration(root),
      });
    }
    return { consumerRoots: consumerRoots.length, terminalRoots: terminalRoots.length };
  };

  const processRecords = (records) => {
    if (records.length === 0) return;
    state.mutationRecordsProcessed += records.length;
    for (const mutation of records) {
      const knownTarget = state.recordByNode.get(mutation.target);
      const targetContext = knownTarget
        ? {
            consumerRootId: knownTarget.consumerRootId,
            terminalGeneration: knownTarget.terminalGeneration,
          }
        : nearestContext(mutation.target);

      if (mutation.type === 'childList') {
        for (const removed of mutation.removedNodes) registerTree(removed, targetContext);
        for (const added of mutation.addedNodes) registerTree(added, targetContext);
      }
    }
    discoverCurrentRoots();
  };

  const observer = new MutationObserver((records) => processRecords(records));
  observer.observe(document, {
    childList: true,
    subtree: true,
  });
  discoverCurrentRoots();

  const emptyByType = () => ({
    element: { connected: 0, connectedOutside: 0, detached: 0, retainedOutside: 0, total: 0 },
    text: { connected: 0, connectedOutside: 0, detached: 0, retainedOutside: 0, total: 0 },
    comment: { connected: 0, connectedOutside: 0, detached: 0, retainedOutside: 0, total: 0 },
    other: { connected: 0, connectedOutside: 0, detached: 0, retainedOutside: 0, total: 0 },
  });

  const emptyScope = () => ({
    rootCount: 0,
    connected: 0,
    connectedOutside: 0,
    detached: 0,
    retainedOutside: 0,
    total: 0,
    byType: emptyByType(),
  });

  const addToScope = (scope, type, location) => {
    scope.total += 1;
    scope.byType[type].total += 1;
    scope[location] += 1;
    scope.byType[type][location] += 1;
    if (location !== 'connected') {
      scope.retainedOutside += 1;
      scope.byType[type].retainedOutside += 1;
    }
  };

  const currentLocation = (node, record) => {
    const context = nearestContext(node);
    const connected = Boolean(node.isConnected);
    return {
      consumer:
        connected && context.consumerRootId === record.consumerRootId
          ? 'connected'
          : connected
            ? 'connectedOutside'
            : 'detached',
      terminal:
        connected && context.terminalGeneration === record.terminalGeneration
          ? 'connected'
          : connected
            ? 'connectedOutside'
            : 'detached',
    };
  };

  const prepare = () => {
    const before = state.mutationRecordsProcessed;
    processRecords(observer.takeRecords());
    const roots = discoverCurrentRoots();
    processRecords(observer.takeRecords());
    return {
      mutationRecordsProcessed: state.mutationRecordsProcessed - before,
      registrySlots: state.records.length,
      consumerRoots: roots.consumerRoots,
      terminalRoots: roots.terminalRoots,
      consumerRootsSeen: state.consumerRootIdsSeen.size,
      terminalGenerationsSeen: state.terminalGenerationsSeen.size,
    };
  };

  const sample = () => {
    const consumer = emptyScope();
    const terminal = emptyScope();
    const generations = new Map();
    for (const id of state.terminalGenerationsSeen) {
      generations.set(id, { id, rootConnected: false, ...emptyScope() });
    }

    const liveRecords = [];
    let dead = 0;
    for (const record of state.records) {
      const node = record.ref.deref();
      if (node === undefined) {
        dead += 1;
        continue;
      }
      liveRecords.push(record);
      const location = currentLocation(node, record);

      if (record.consumerRootId !== null) {
        addToScope(consumer, record.type, location.consumer);
        if (record.isConsumerRoot && location.consumer === 'connected') consumer.rootCount += 1;
      }

      if (record.terminalGeneration !== null) {
        addToScope(terminal, record.type, location.terminal);
        const generation = generations.get(record.terminalGeneration);
        addToScope(generation, record.type, location.terminal);
        if (record.isTerminalRoot && location.terminal === 'connected') {
          terminal.rootCount += 1;
          generation.rootCount += 1;
          generation.rootConnected = true;
        }
      }
    }
    state.records = liveRecords;

    return {
      version: 1,
      coverage: {
        name: 'ownedStructuralDom',
        version: 1,
        nodeTypes: ['element', 'text', 'comment', 'other'],
        excludedNodeTypes: ['attr', 'shadow-dom'],
      },
      consumer,
      terminal: { ...terminal, generations: [...generations.values()] },
      totalOwned: { consumer: consumer.total, terminal: terminal.total },
      rootCount: { consumer: consumer.rootCount, terminal: terminal.rootCount },
      registry: {
        live: liveRecords.length,
        dead,
        pruned: dead,
        slots: state.records.length,
        mutationRecordsProcessed: state.mutationRecordsProcessed,
      },
    };
  };

  const api = Object.freeze({ version: 1, prepare, sample });
  globalThis[globalName] = api;
  return api;
}
