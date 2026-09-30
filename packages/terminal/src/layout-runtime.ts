import type { ChartApi, ChartPaneLayout } from '@filtrix.net/charts';
import { copyLayout, sameLayout } from './layout';
import type { TerminalLayout, TerminalPaneId } from './types';

/** Bridges effective engine deltas without treating membership or derived focus as preferences. */
export class TerminalLayoutRuntime {
  private readonly origin = {};
  private observed: ChartPaneLayout;
  private membership: { pending: boolean }[] = [];
  private readonly unsubscribe: () => void;
  constructor(
    private chart: ChartApi,
    private canonical: () => TerminalLayout,
    private visible: () => ReadonlySet<TerminalPaneId>,
    private adopt: (layout: TerminalLayout) => void,
  ) {
    this.observed = chart.getPaneLayout();
    this.unsubscribe = chart.subscribePaneLayoutChange((next, meta) => {
      const before = this.observed;
      this.observed = next;
      const own = this.membership.at(-1);
      const changedMembership =
        before.panes.length !== next.panes.length || before.panes.some((p, i) => p.id !== next.panes[i]?.id);
      if (own?.pending && changedMembership) {
        own.pending = false;
        return;
      }
      if (meta.origin === this.origin) return;
      const layout = copyLayout(this.canonical()),
        prior = new Map(before.panes.map((p) => [p.id, p])),
        current = new Map(next.panes.map((p) => [p.id, p]));
      for (const pane of layout.panes) {
        const old = prior.get(pane.id),
          value = current.get(pane.id);
        if (!old || !value) continue;
        if (old.weight !== value.weight) pane.weight = value.weight;
        if (
          old.minHeight !== value.minHeight &&
          Number.isInteger(value.minHeight) &&
          value.minHeight >= 24 &&
          value.minHeight <= 2048
        )
          pane.minHeight = value.minHeight;
      }
      if (
        next.maximizedPaneId !== before.maximizedPaneId &&
        (next.maximizedPaneId === null || this.visible().has(next.maximizedPaneId as TerminalPaneId))
      )
        layout.maximizedPaneId = next.maximizedPaneId as TerminalPaneId | null;
      if (!sameLayout(layout, this.canonical())) this.adopt(layout);
    });
  }
  ownMembership<T>(work: () => T): T {
    const frame = { pending: true };
    this.membership.push(frame);
    try {
      return work();
    } finally {
      this.membership.pop();
    }
  }
  /** Presenter-only override is never part of the canonical document. */
  sync(
    layout: TerminalLayout,
    effectiveMaximizedPaneId: TerminalPaneId | null = layout.maximizedPaneId,
  ): void {
    const actual = new Set(this.chart.getPaneLayout().panes.map((p) => p.id));
    this.chart.applyPaneLayout(
      {
        panes: layout.panes.filter((p) => actual.has(p.id)),
        maximizedPaneId:
          effectiveMaximizedPaneId !== null && !actual.has(effectiveMaximizedPaneId)
            ? null
            : effectiveMaximizedPaneId,
      },
      { origin: this.origin },
    );
  }
  destroy(): void {
    this.unsubscribe();
  }
}
