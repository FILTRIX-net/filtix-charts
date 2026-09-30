# Drawing tools and saved studies

`@filtrix.net/drawings` is an optional add-on for `@filtrix.net/charts`. Importing either package is safe during server rendering; create the browser layer after mounting a chart container.

```ts
import { createChart } from '@filtrix.net/charts';
import { createDrawingLayer, createDrawingStore } from '@filtrix.net/drawings';

const chart = createChart(container, { timeDomain: 'utc-ms', autoSize: true });
chart.addSeries('candlestick').setData(history);
chart.fitContent();

const store = createDrawingStore({ timeDomain: 'utc-ms', maxDrawings: 200, maxHistory: 100 });
const layer = createDrawingLayer(chart, {
  store,
  style: { color: '#96aee8', lineWidth: 2 },
  onState: (state) => updateToolbar(state),
});
layer.setTool('trend-line');
// Buttons can call store.undo(), store.redo(), layer.select(id), or store.remove(id).

// Persist only when the application chooses to save:
const document = store.toJSON();
localStorage.setItem('my-chart-drawings', JSON.stringify(document));
// restore validates the entire document before changing the model:
store.restore(JSON.parse(localStorage.getItem('my-chart-drawings')!));

// On unmount:
layer.destroy();
chart.destroy();
```

The store owns copied, validated drawings. A patch merges only specified style fields. IDs and drawing types cannot change. Default capacity is 200 objects (configurable 1–1,000); undo history defaults to 100 committed edits (0–500). Drag previews stay local and produce one history entry on commit. A zero history limit still mutates and notifies. Save documents exclude transient selection, previews, undo history and Magnet mode. Canonical documents use version 2; the shared decoder accepts historical version 1. See the [advanced tools and migration guide](DRAWING-TOOLS.md).

Use one click for a price level or text note; two clicks for a trend, rectangle, measurement or Fibonacci retracement; three clicks for a parallel channel. Select a drawing to move its body or endpoints. Escape, blur and cancelled pointers discard an active edit. Delete removes a selected object; Ctrl/Cmd+Z and Ctrl/Cmd+Y or Shift+Z operate history. Empty space remains available for chart navigation. During an owned edit, its captured projection determines the geometry.

Times belong to the chart's domain. When no store is supplied, the layer inherits that domain. A supplied mismatching store is rejected before attachment. All non-horizontal tools use exact loaded timestamps for every stored anchor; an unloaded anchor or absent pane hides the drawing until it can be projected again. Price levels retain a validated provenance timestamp but remain visible when that timestamp leaves loaded history. Annotations do not affect autoscaling. Log-scale dragging preserves the common displacement in logarithmic coordinates.

Colors accept #RRGGBB or #RRGGBBAA; line widths are 0.5–8 CSS pixels; fill opacity for rectangles, measurements, channels and note boxes is 0–1. Measurement returns signed price/percentage changes and elapsed milliseconds; a zero price or unrepresentable arithmetic produces null for the affected price result. Business dates use calendar-day elapsed time, including years 0000–0099, independently of local daylight saving.

The layer cleans up its listeners and primitive on destroy; repeated destroy is safe. Its pure store remains usable. Reading getState after destruction returns the last cached state, while mutating layer methods reject use after destruction.

The original [study screen](../apps/showcase/drawings.html) at /drawings.html demonstrates the original four tools, an editable object inspector, undo/redo, PNG export and explicit browser-local Save/Load. Its versioned fixed sample dataset makes saved logical viewports reproducible. The application validates the entire theme/viewport/drawing envelope before applying it. This envelope is an example application format, separate from the public drawing document.

PNG export includes committed annotations and omits handles, previews, selection and crosshair. See [primitive integration](PRIMITIVES.md), the [current drawing tools specification](../SOURCE-DISTRIBUTION.md#omitted-development-materials), the [historical v0.3 drawing contract](DRAWINGS-CONTRACT.md) and [v0.3 design](../SOURCE-DISTRIBUTION.md#omitted-development-materials).
