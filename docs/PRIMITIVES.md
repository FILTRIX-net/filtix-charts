# Custom chart primitives

A primitive paints an optional annotation layer using a public CSS-pixel projection. The chart allocates its third canvas lazily on first attachment and removes it when the last primitive detaches. Charts without primitives retain their two-canvas scene/cursor architecture.

```ts
import type { PrimitiveHost } from '@filtix/charts';
let host: PrimitiveHost | undefined;
const detach = chart.attachPrimitive({
  attach(nextHost) {
    host = nextHost;
    return () => { host = undefined; };
  },
  draw(context, projection, mode) {
    const x = projection.timeToX(anchorTime);
    const y = projection.priceToY(anchorPrice);
    if (x === null || y === null) return;
    context.beginPath();
    context.arc(x, y, 4, 0, Math.PI * 2);
    context.fillStyle = '#96aee8';
    context.fill();
    // mode is 'screen' or 'export'; omit transient UI in export mode.
  },
});
// After changing external primitive data:
host?.invalidate();
// On teardown:
detach();
```

The engine provides a scaled drawing context and saves/restores its state around each callback. A primitive should clip its own shapes to the desired pane bounds. Do not retain the supplied canvas context beyond draw. The host root is for owned event listeners; its descendants are implementation details and must not be inspected or mutated. The API does not expose an owned canvas handle.

getProjection returns a stable snapshot of dimensions, pane bounds/scales, theme and loaded time mapping. It retains a stable timeline prefix rather than copying the complete history on every call. timeToX only resolves exact loaded timestamps, while xToTime finds the nearest loaded timestamp. Coordinates are unclamped: consumers may preserve offscreen geometry and clip during rendering. logicalIndexToTime requires an integer loaded index. Missing panes, absent time data or unavailable price scales yield null.

Invalidation coalesces with the next scheduled frame. Data, view, pane, theme and size changes repaint primitives; an ordinary crosshair move does not. Self-invalidation during draw schedules another frame. With diagnostics enabled, lastRenderMs includes scene, primitive and cursor submission work; structural primitiveCount/primitiveDraws counters remain inexpensive.

detach and chart.destroy release successful attachment cleanup once. Invalidation after detach is a no-op; getProjection then rejects. If attach itself throws, the primitive owns rollback of any listeners it installed before throwing; the chart rolls back its own registry and canvas resources. Export invokes draw with mode 'export' and rejects if a callback fails.

See the [exact public types](PRIMITIVE-CONTRACT.md) and [drawing add-on](DRAWINGS.md).
