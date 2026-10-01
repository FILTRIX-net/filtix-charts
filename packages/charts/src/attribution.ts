import type { Scene } from './types';

const label = 'FILTRIX.NET';
const width = 96;
const height = 20;
const font = '600 10px system-ui, sans-serif';

function bounds(scene: Scene) {
  const pane = scene.panes.find((value) => value.height > 0);
  if (!pane || scene.width <= 0 || scene.height <= 0 || scene.plotWidth < width + 16 || pane.height < 80)
    return null;
  // Leave 16 CSS pixels clear of the axis or the pane's divider hit target.
  return { left: 8, top: pane.top + pane.height - height - 16 };
}

export function createAttribution(wrapper: HTMLElement, scene: Scene) {
  const anchor = wrapper.ownerDocument.createElement('a');
  anchor.dataset.filtixAttribution = '';
  anchor.textContent = label;
  anchor.href = 'https://filtrix.net/';
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.cssText =
    `display:none;position:absolute;box-sizing:border-box;width:${width}px;height:${height}px;` +
    `font:${font};line-height:${height}px;text-align:center;text-decoration:none;` +
    'border-radius:3px;white-space:nowrap;overflow:hidden;outline-offset:2px;';
  const focus = () => {
    anchor.style.outline = '2px solid currentColor';
  };
  const blur = () => {
    anchor.style.outline = '';
  };
  anchor.addEventListener('focus', focus);
  anchor.addEventListener('blur', blur);
  wrapper.append(anchor);
  let lastTop: number | undefined;
  let lastVisible = false;
  let lastText: string | undefined;
  let lastBackground: string | undefined;
  return {
    sync() {
      const box = bounds(scene);
      const visible = scene.options.attribution !== false && box !== null;
      if (visible !== lastVisible) {
        anchor.style.display = visible ? 'block' : 'none';
        lastVisible = visible;
      }
      if (box && box.top !== lastTop) {
        anchor.style.left = `${box.left}px`;
        anchor.style.top = `${box.top}px`;
        lastTop = box.top;
      }
      if (scene.theme.text !== lastText) {
        anchor.style.color = scene.theme.text;
        lastText = scene.theme.text;
      }
      if (scene.theme.background !== lastBackground) {
        anchor.style.backgroundColor = scene.theme.background;
        lastBackground = scene.theme.background;
      }
    },
    destroy() {
      anchor.removeEventListener('focus', focus);
      anchor.removeEventListener('blur', blur);
      anchor.remove();
    },
  };
}

export function drawWatermark(context: CanvasRenderingContext2D, scene: Scene) {
  const box = bounds(scene);
  if (!box) return;
  context.save();
  context.beginPath();
  context.rect(box.left, box.top, width, height);
  context.clip();
  context.globalAlpha = 0.85;
  context.fillStyle = scene.theme.background;
  context.fillRect(box.left, box.top, width, height);
  context.globalAlpha = 0.68;
  context.fillStyle = scene.theme.text;
  context.font = font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, box.left + width / 2, box.top + height / 2);
  context.restore();
}
