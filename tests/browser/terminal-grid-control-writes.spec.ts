import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('grid toolbar avoids unchanged writes while feeds update and repairs native state drift', async ({
  page,
}) => {
  await page.goto('/terminal-grid-test.html');
  const result = await page.evaluate(
    async (url) => {
      const { createTerminalGrid } = await import(url);
      const host = document.createElement('div');
      host.style.cssText = 'width:1000px;height:820px';
      document.body.append(host);
      const subscriptions = new Set<any>();
      let stateEvents = 0;
      let reenter = false;
      let grid: any;
      grid = createTerminalGrid(host, {
        layout: 4,
        query: { symbol: 'BTCUSDT', interval: '1m' },
        provider: {
          id: 'grid-control-writes',
          revisionMode: 'arrival',
          maxPageSize: 100,
          async getHistory() {
            return { bars: [], exhausted: true };
          },
          subscribe(_query: unknown, handlers: any) {
            subscriptions.add(handlers);
            queueMicrotask(() => {
              if (subscriptions.has(handlers)) handlers.onOpen();
            });
            return () => subscriptions.delete(handlers);
          },
        },
        onState() {
          stateEvents++;
          if (reenter && grid) {
            reenter = false;
            grid.setSync({ crosshairMatch: 'exact' });
          }
        },
      });
      let observer: MutationObserver | undefined;
      const restoreDescriptors: Array<() => void> = [];
      try {
        for (
          let i = 0;
          i < 100 && grid.getState().cells.some((cell: any) => cell.terminal?.feed.status !== 'live');
          i++
        )
          await new Promise((done) => setTimeout(done, 10));
        if (grid.getState().cells.some((cell: any) => cell.terminal?.feed.status !== 'live'))
          throw Error('Not live');
        const toolbar = host.querySelector<HTMLElement>('.filtix-terminal-grid-toolbar')!;
        const caption = toolbar.querySelector<HTMLElement>('[data-grid-active-cell]')!;
        const viewport = toolbar.querySelector<HTMLInputElement>('[data-grid-viewport]')!;
        const crosshair = toolbar.querySelector<HTMLInputElement>('[data-grid-crosshair]')!;
        const match = toolbar.querySelector<HTMLSelectElement>('[data-grid-crosshair-match]')!;
        let propertyWrites = 0;
        const observedProperties: Array<[Element, object, string]> = [
          [viewport, HTMLInputElement.prototype, 'checked'],
          [crosshair, HTMLInputElement.prototype, 'checked'],
          [match, HTMLSelectElement.prototype, 'value'],
        ];
        for (const root of host.querySelectorAll('[data-filtix-terminal-instance]')) {
          observedProperties.push(
            [root.querySelector('[data-terminal-theme]')!, HTMLSelectElement.prototype, 'value'],
            [root.querySelector('[data-terminal-ema]')!, HTMLInputElement.prototype, 'value'],
            [root.querySelector('[data-terminal-volume]')!, HTMLInputElement.prototype, 'checked'],
          );
        }
        for (const [element, prototype, key] of observedProperties) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
          Object.defineProperty(element, key, {
            configurable: true,
            get() {
              return descriptor.get!.call(this);
            },
            set(value) {
              propertyWrites++;
              descriptor.set!.call(this, value);
            },
          });
          restoreDescriptors.push(() => {
            delete (element as any)[key];
          });
        }
        let mutations = 0;
        observer = new MutationObserver((records) => {
          mutations += records.length;
        });
        observer.observe(toolbar, { subtree: true, attributes: true, childList: true, characterData: true });
        observer.observe(host.querySelector('.filtix-terminal-grid')!, {
          attributes: true,
          attributeFilter: ['data-theme'],
        });
        for (const cell of host.querySelectorAll('[data-filtix-grid-cell]'))
          observer.observe(cell, { attributes: true, attributeFilter: ['data-active'] });
        for (const root of host.querySelectorAll('[data-filtix-terminal-instance]')) {
          observer.observe(root, {
            attributes: true,
            attributeFilter: [
              'data-theme',
              'data-editor-mode',
              'data-editor-open',
              'data-terminal-editing-focus',
            ],
          });
          for (const field of root.querySelectorAll('[data-terminal-status],[data-terminal-error]'))
            observer.observe(field, {
              subtree: true,
              attributes: true,
              childList: true,
              characterData: true,
            });
          for (const field of root.querySelectorAll(
            '[data-terminal-toolbar],[data-terminal-footer],[data-terminal-body]',
          ))
            observer.observe(field, { attributes: true, attributeFilter: ['style'] });
        }
        const beforeEvents = stateEvents;
        for (let i = 1; i <= 4; i++) {
          for (const handlers of subscriptions)
            handlers.onBar({ time: i * 60_000, open: i, high: i + 2, low: i, close: i + 1, volume: 1 });
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        }
        mutations += observer.takeRecords().length;
        const unchanged = {
          propertyWrites,
          mutations,
          notifications: stateEvents - beforeEvents,
          bars: grid.getState().cells.map((cell: any) => cell.terminal.feed.bars),
        };
        observer.disconnect();

        grid.setActiveCell('cell-2');
        viewport.click();
        crosshair.click();
        match.value = 'nearest';
        match.dispatchEvent(new Event('change', { bubbles: true }));
        await grid.setLayout(2);
        const read = () => ({
          caption: caption.textContent,
          active: caption.dataset.gridActiveCell,
          pressed: [...toolbar.querySelectorAll('[data-grid-layout]')].map((element) =>
            element.getAttribute('aria-pressed'),
          ),
          viewport: viewport.checked,
          crosshair: crosshair.checked,
          match: match.value,
        });
        const changed = read();
        const saved = grid.getWorkspace();
        viewport.checked = false;
        crosshair.checked = false;
        match.value = 'exact';
        caption.textContent = 'drift';
        caption.dataset.gridActiveCell = 'wrong';
        toolbar.querySelector('[data-grid-layout="2"]')!.setAttribute('aria-pressed', 'false');
        const terminalRoot = host.querySelector<HTMLElement>(
          '[data-filtix-grid-cell="cell-1"] [data-filtix-terminal-instance]',
        )!;
        const settings = grid.getTerminal('cell-1').getSettings();
        terminalRoot.dataset.theme = 'drift';
        const terminalStatus = terminalRoot.querySelector<HTMLElement>('[data-terminal-status]')!;
        terminalStatus.textContent = 'drift';
        terminalStatus.dataset.ready = 'false';
        terminalRoot.querySelector<HTMLElement>('[data-terminal-error]')!.textContent = 'drift';
        terminalRoot.querySelector<HTMLSelectElement>('[data-terminal-theme]')!.value = 'light';
        terminalRoot.querySelector<HTMLInputElement>('[data-terminal-volume]')!.checked = !settings.volume;
        const styleRepairs: Array<[HTMLElement, string]> = [
          [terminalRoot.querySelector('[data-terminal-toolbar]')!, 'max-height'],
          [terminalRoot.querySelector('[data-terminal-footer]')!, 'max-height'],
          [terminalRoot.querySelector('[data-terminal-body]')!, '--terminal-editor-height'],
        ];
        for (const [element, property] of styleRepairs)
          element.style.setProperty(property, element.style.getPropertyValue(property), 'important');
        // Keep the original native setter's behavior, including each engine's
        // handling of an equal custom-property value with a changed priority.
        const nativePriorities = styleRepairs.map(([element, property]) => {
          const style = document.createElement('div').style;
          const value = element.style.getPropertyValue(property);
          style.setProperty(property, value, 'important');
          style.setProperty(property, value);
          return style.getPropertyPriority(property);
        });
        // A real feed publication refreshes controls even if preferences did not change.
        // setSync with an identical patch intentionally returns without publishing.
        for (const handlers of subscriptions)
          handlers.onBar({ time: 300_000, open: 5, high: 7, low: 5, close: 6, volume: 1 });
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const repaired = read();
        const terminalRepaired = {
          theme: terminalRoot.dataset.theme === settings.theme,
          selected:
            terminalRoot.querySelector<HTMLSelectElement>('[data-terminal-theme]')!.value === settings.theme,
          volume:
            terminalRoot.querySelector<HTMLInputElement>('[data-terminal-volume]')!.checked ===
            settings.volume,
          status: terminalStatus.textContent,
          ready: terminalStatus.dataset.ready,
          error: terminalRoot.querySelector<HTMLElement>('[data-terminal-error]')!.textContent,
          priorities: styleRepairs.map(([element, property]) => element.style.getPropertyPriority(property)),
        };
        grid.getTerminal('cell-1').applySettings({ theme: 'light', volume: false });
        const terminalChanged = {
          theme: terminalRoot.dataset.theme,
          selected: terminalRoot.querySelector<HTMLSelectElement>('[data-terminal-theme]')!.value,
          volume: terminalRoot.querySelector<HTMLInputElement>('[data-terminal-volume]')!.checked,
        };
        reenter = true;
        grid.setSync({ crosshair: false });
        const reentrant = read();
        await grid.restoreWorkspace(saved);
        const restoredToolbar = host.querySelector<HTMLElement>('.filtix-terminal-grid-toolbar')!;
        const restored = {
          active:
            restoredToolbar.querySelector<HTMLElement>('[data-grid-active-cell]')!.dataset.gridActiveCell,
          match: restoredToolbar.querySelector<HTMLSelectElement>('[data-grid-crosshair-match]')!.value,
          viewport: restoredToolbar.querySelector<HTMLInputElement>('[data-grid-viewport]')!.checked,
          layout: grid.getState().layout,
        };
        grid.destroy();
        return {
          unchanged,
          changed,
          repaired,
          terminalRepaired,
          nativePriorities,
          terminalChanged,
          reentrant,
          restored,
          subscriptions: subscriptions.size,
          children: host.children.length,
        };
      } finally {
        observer?.disconnect();
        restoreDescriptors.forEach((restore) => restore());
        grid.destroy();
        host.remove();
      }
    },
    '/@fs/' + resolve('packages/terminal/src/index.ts').replaceAll('\\', '/'),
  );
  expect(result.unchanged.bars).toEqual([4, 4, 4, 4]);
  expect(result.unchanged.notifications).toBeGreaterThan(0);
  expect(result.unchanged.propertyWrites).toBe(0);
  expect(result.unchanged.mutations).toBe(0);
  expect(result.changed).toEqual({
    caption: 'ACTIVE 2',
    active: 'cell-2',
    pressed: ['false', 'true', 'false'],
    viewport: true,
    crosshair: true,
    match: 'nearest',
  });
  expect(result.repaired).toEqual(result.changed);
  expect(result.terminalRepaired).toEqual({
    theme: true,
    selected: true,
    volume: true,
    status: 'Live',
    ready: 'true',
    error: '',
    priorities: result.nativePriorities,
  });
  expect(result.terminalChanged).toEqual({ theme: 'light', selected: 'light', volume: false });
  expect(result.reentrant.match).toBe('exact');
  expect(result.restored).toEqual({ active: 'cell-2', match: 'nearest', viewport: true, layout: 2 });
  expect(result.subscriptions).toBe(0);
  expect(result.children).toBe(0);
});
