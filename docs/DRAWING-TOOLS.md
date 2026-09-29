# Advanced drawing tools

The terminal toolbar offers trend lines, price levels, rectangles, measurements, Fibonacci retracements, parallel channels and text notes. Use one click for a price level or note, two for a trend/rectangle/measurement/Fibonacci drawing, and three for a parallel channel. Escape, blur or pointer cancellation discards an unfinished gesture. A completed gesture creates one undo entry.

Open **Objects** to select any saved drawing, including hidden or locked ones. Edit its color, line width, meaningful fill opacity, visibility and geometry lock, then use **Apply changes** to commit the complete draft once. Invalid drafts remain editable and leave the stored object unchanged. Notes expose text/font size; Fibonacci exposes level ratios and optional style overrides. Blank color and width fields inherit the current drawing style; the line-style option labelled Inherit uses a solid line. The panel scrolls within the terminal and its Close button restores the chart area on narrow hosts.

Locked drawings remain selectable and allow explicit style/API edits or deletion; locking prevents pointer geometry changes. Hidden drawings are excluded from painting, hit testing and PNG export. Selection, unfinished gestures, undo history and Magnet state are transient.

## Add drawings through the terminal store

Use loaded candle times from the terminal's current market. Reacquire the store after a market switch or workspace restore.

```ts
const bars = terminal.getData();
if (bars.length >= 3) {
  const first = bars.at(-3)!;
  const middle = bars.at(-2)!;
  const last = bars.at(-1)!;
  const drawings = terminal.getDrawings();
  const fib = drawings.add({
    type: 'fibonacci-retracement',
    points: [
      { time: first.time, price: first.low },
      { time: last.time, price: last.high },
    ],
    levels: [{ ratio: 0 }, { ratio: 0.5, color: '#d19a66', lineStyle: 'dashed' }, { ratio: 1 }],
    style: { color: '#379ab5', lineWidth: 1.5 },
  });
  drawings.add({
    type: 'parallel-channel',
    points: [
      { time: first.time, price: first.high },
      { time: last.time, price: last.high },
      { time: middle.time, price: middle.low },
    ],
    style: { color: '#ba8651', fillOpacity: 0.12 },
  });
  drawings.add({
    type: 'text-note',
    points: [{ time: middle.time, price: middle.close }],
    text: 'Market structure\nWatching the retracement',
    fontSize: 14,
  });
  drawings.update(fib, { locked: true });
}
```

Fibonacci defaults to ratios 0, 0.236, 0.382, 0.5, 0.618, 0.786 and 1. A document accepts 1–32 unique finite ratios from -10 to 10, in caller order. Ratio 0 is the first anchor price and ratio 1 the second; intermediate levels interpolate prices on a linear scale and logarithms on a log scale. Optional per-level color and lineWidth override the drawing style. A level can use solid, dashed or dotted lineStyle; omission defaults to solid. Unrepresentable levels are skipped without altering the saved drawing.

A channel stores A, B and C. Its second rail ends at C+(B-A) in projected coordinates; the fourth corner is derived. Interactive creation requires distinct A/B and a distance of at least 2 CSS pixels from C to the first rail. Notes require non-whitespace plain text, normalize CRLF to LF and allow at most 2000 UTF-16 units and 20 lines. Font size defaults to 12 CSS pixels and accepts values from 8 to 48. All non-horizontal drawing anchors must be loaded to project; missing times/panes or invalid log projection hide the object temporarily and preserve saved data.

## OHLC magnet

The native Magnet button snaps new anchors and individually dragged handles to a nearby open, high, low or close on the exact loaded candle. It does not snap whole-object translations. Tool changes preserve the mode; market/layer replacement resets it. The terminal performs one indexed feed lookup per request, without copying complete history.

Applications composing their own chart/layer can supply a provider:

```ts
const layer = createDrawingLayer(chart, {
  store,
  magnet: true,
  snapDistance: 10,
  snapProvider({ paneId, point }) {
    if (paneId !== 'price' || typeof point.time !== 'number') return [];
    const bar = feed.getBar(point.time);
    return bar
      ? (['open', 'high', 'low', 'close'] as const).map((field) => ({
          field,
          time: bar.time,
          price: bar[field],
        }))
      : [];
  },
});
layer.setMagnet(false);
```

snapDistance defaults to 10 CSS pixels and accepts finite values from 1 to 40. The layer uses the gesture's frozen projection and nearest Euclidean distance; provider order breaks ties. Invalid candidates or provider failures leave the raw point usable. The drawings package itself does not depend on datafeed or React.

## Saved documents

DrawingDocument is the canonical filtix-drawings version 2 format. DrawingDocumentV1, DrawingV1 and DrawingTypeV1 preserve the historical shape. decodeDrawingDocument accepts supported v1/v2 input and returns owned canonical v2; legacy drawings migrate with locked:false and visible:true. copyDrawingDocument copies canonical data. Restore validates the whole input before changing state, including exact fields, identifiers, array density and capacity. New types and optional overrides retain their distinct fields instead of being flattened into old drawings.

Terminal workspace remains version 4 in v0.9 and now embeds drawing documents version 2. Historical TerminalWorkspaceV4 retains nested drawing version 1; TerminalWorkspaceV4WithDrawingsV2 freezes that historical v4 shape. Current v0.10 workspaces use v5, retain drawing documents v2 and add alerts; see [alert persistence](ALERTS.md). Existing v1–v4 workspaces migrate through the shared drawing decoder. Older packages cannot read new nested-v2 saves; keep explicit application storage and migration policies. The versioned drawing schema and package version are separate concepts.

Default capacity remains 200 drawings, configurable up to 1000; bounded undo history remains configurable from 0 to 500. PNG export includes only committed visible objects and excludes previews, handles and selection. A standalone layer releases its own listeners/primitive on destroy while its pure store remains usable.
