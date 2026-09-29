import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('study and layout controls avoid unchanged writes and preserve editing and native repairs', async ({
  page,
}, testInfo) => {
  await page.goto('/terminal-grid-test.html');
  const result = await page.evaluate(
    async (url) => {
      const { createTerminal } = await import(url);
      const host = document.createElement('div');
      host.style.cssText = 'width:1100px;height:800px';
      document.body.append(host);
      const subscriptions = new Set<any>();
      let notifications = 0;
      const terminal = createTerminal(host, {
        query: { symbol: 'BTCUSDT', interval: '1m' },
        studies: [
          { kind: 'sma', period: 3 },
          { kind: 'rsi', period: 3 },
        ],
        provider: {
          id: 'study-layout-control-writes',
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
          notifications++;
        },
      });
      const settle = () =>
        new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      let observer: MutationObserver | undefined;
      const restore: Array<() => void> = [];
      const publish = (i: number) => {
        for (const handlers of subscriptions)
          handlers.onBar({ time: i * 60_000, open: i, low: i, high: i + 2, close: i + 1, volume: 1 });
      };
      try {
        for (let i = 0; i < 100 && terminal.getState().feed.status !== 'live'; i++)
          await new Promise((done) => setTimeout(done, 10));
        if (terminal.getState().feed.status !== 'live') throw Error('Not live');
        await settle();
        const panel = host.querySelector<HTMLElement>('[data-terminal-studies-panel]')!;
        const toggle = host.querySelector<HTMLButtonElement>('[data-terminal-studies-toggle]')!;
        const layout = host.querySelector<HTMLElement>('[data-terminal-layout-controls]')!;
        const roots = [panel, toggle, layout];
        let writes = 0,
          mutations = 0;
        for (const root of roots) {
          for (const element of root.querySelectorAll('input,select,button')) {
            const properties: Array<[object, string]> =
              element instanceof HTMLInputElement
                ? [
                    [HTMLInputElement.prototype, 'value'],
                    [HTMLInputElement.prototype, 'checked'],
                    [HTMLInputElement.prototype, 'disabled'],
                  ]
                : element instanceof HTMLSelectElement
                  ? [
                      [HTMLSelectElement.prototype, 'value'],
                      [HTMLSelectElement.prototype, 'disabled'],
                    ]
                  : [[HTMLButtonElement.prototype, 'disabled']];
            for (const [prototype, key] of properties) {
              const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
              Object.defineProperty(element, key, {
                configurable: true,
                get() {
                  return descriptor.get!.call(this);
                },
                set(value) {
                  writes++;
                  descriptor.set!.call(this, value);
                },
              });
              restore.push(() => {
                delete (element as any)[key];
              });
            }
          }
        }
        observer = new MutationObserver((records) => {
          mutations += records.length;
        });
        for (const root of roots)
          observer.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
        const beforeNotifications = notifications;
        for (let i = 1; i <= 4; i++) {
          publish(i);
          await settle();
        }
        mutations += observer.takeRecords().length;
        const unchanged = {
          writes,
          mutations,
          notifications: notifications - beforeNotifications,
          bars: terminal.getState().feed.bars,
        };
        observer.disconnect();

        const first = panel.querySelector<HTMLElement>('[data-terminal-study-row]')!;
        const period = first.querySelector<HTMLInputElement>('[data-terminal-study-period]')!;
        const visible = first.querySelector<HTMLInputElement>('[data-terminal-study-visible]')!;
        const name = first.querySelector<HTMLElement>('[data-terminal-study-name]')!;
        const restoreButton = layout.querySelector<HTMLButtonElement>('[data-terminal-pane-restore]')!;
        const layoutStatus = layout.querySelector<HTMLElement>('[data-terminal-layout-status]')!;
        const expected = {
          period: period.value,
          visible: visible.checked,
          name: name.textContent,
          disabled: restoreButton.disabled,
          caption: restoreButton.textContent,
          status: layoutStatus.textContent,
        };
        period.value = '499';
        visible.checked = !visible.checked;
        name.textContent = 'drift';
        restoreButton.disabled = !restoreButton.disabled;
        restoreButton.textContent = 'drift';
        restoreButton.dataset.terminalDerivedRestore = 'drift';
        layoutStatus.textContent = 'drift';
        toggle.setAttribute('aria-expanded', 'true');
        publish(5);
        await settle();
        const repaired = {
          period: period.value,
          visible: visible.checked,
          name: name.textContent,
          disabled: restoreButton.disabled,
          caption: restoreButton.textContent,
          status: layoutStatus.textContent,
        };
        const repairedAttributes = {
          expanded: toggle.getAttribute('aria-expanded'),
          derived: restoreButton.dataset.terminalDerivedRestore,
        };

        terminal.applyLayout({ studiesOpen: true });
        await settle();
        const opened = {
          hidden: panel.hidden,
          expanded: toggle.getAttribute('aria-expanded'),
          focusInside: panel.contains(document.activeElement),
        };
        period.focus();
        period.value = '7';
        publish(6);
        await settle();
        const draft = {
          value: period.value,
          focused: document.activeElement === period,
          committed: terminal.getStudies()[0].period,
        };
        terminal.updateStudy(terminal.getStudies()[0].id, { period: 4 });
        const changed = {
          value: period.value,
          focused: document.activeElement === period,
          committed: terminal.getStudies()[0].period,
        };
        terminal.applyLayout({ studiesOpen: false });
        const closed = {
          hidden: panel.hidden,
          expanded: toggle.getAttribute('aria-expanded'),
          focused: document.activeElement === toggle,
        };
        terminal.destroy();
        return {
          unchanged,
          expected,
          repaired,
          repairedAttributes,
          opened,
          draft,
          changed,
          closed,
          subscriptions: subscriptions.size,
          children: host.children.length,
        };
      } finally {
        observer?.disconnect();
        restore.forEach((fn) => fn());
        terminal.destroy();
        host.remove();
      }
    },
    '/@fs/' + resolve('packages/terminal/src/index.ts').replaceAll('\\', '/'),
  );
  const observations = testInfo.outputPath('native-control-observations.json');
  writeFileSync(observations, JSON.stringify(result, null, 2) + '\n');
  await testInfo.attach('native-control-observations', {
    path: observations,
    contentType: 'application/json',
  });
  expect(result.repaired).toEqual(result.expected);
  expect(result.repairedAttributes).toEqual({ expanded: 'false', derived: 'false' });
  expect(result.opened).toEqual({ hidden: false, expanded: 'true', focusInside: true });
  expect(result.draft).toEqual({ value: '7', focused: true, committed: 3 });
  expect(result.changed).toEqual({ value: '4', focused: true, committed: 4 });
  expect(result.closed).toEqual({ hidden: true, expanded: 'false', focused: true });
  expect(result.subscriptions).toBe(0);
  expect(result.children).toBe(0);
  expect(result.unchanged.bars).toBe(4);
  expect(result.unchanged.notifications).toBeGreaterThan(0);
  expect(result.unchanged.writes).toBe(0);
  expect(result.unchanged.mutations).toBe(0);
});
