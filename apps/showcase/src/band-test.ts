import { createChart, type ChartApi, type ChartOptions } from '@filtrix.net/charts';

const host = document.getElementById('band-host')!;
const quietTheme = {
  background: '#ffffff',
  text: '#ffffff',
  mutedText: '#ffffff',
  grid: '#ffffff',
  border: '#ffffff',
};
let chart: ChartApi = createChart(host, {
  width: 480,
  height: 320,
  autoSize: false,
  crosshair: false,
  theme: quietTheme,
});

function reset(options: ChartOptions = {}): ChartApi {
  chart.destroy();
  chart = createChart(host, {
    width: 480,
    height: 320,
    autoSize: false,
    crosshair: false,
    theme: quietTheme,
    ...options,
  });
  return chart;
}

function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const data = canvas
    .getContext('2d')!
    .getImageData(
      Math.max(0, Math.min(canvas.width - 1, Math.round(x * scaleX))),
      Math.max(0, Math.min(canvas.height - 1, Math.round(y * scaleY))),
      1,
      1,
    ).data;
  return Array.from(data);
}

async function exportPixel(x: number, y: number): Promise<{ rgba: number[]; width: number; height: number }> {
  const blob = await chart.exportImage();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const screen = host.querySelector<HTMLCanvasElement>('canvas[data-filtix-layer="scene"]')!;
  const rect = screen.getBoundingClientRect();
  const data = context.getImageData(
    Math.max(0, Math.min(canvas.width - 1, Math.round((x * canvas.width) / rect.width))),
    Math.max(0, Math.min(canvas.height - 1, Math.round((y * canvas.height) / rect.height))),
    1,
    1,
  ).data;
  return { rgba: Array.from(data), width: canvas.width, height: canvas.height };
}

const bandTestApi = {
  get chart() {
    return chart;
  },
  reset,
  scenePixel(x: number, y: number) {
    return pixel(host.querySelector<HTMLCanvasElement>('canvas[data-filtix-layer="scene"]')!, x, y);
  },
  darkestScenePixel(x: number, y: number, radius = 2) {
    const canvas = host.querySelector<HTMLCanvasElement>('canvas[data-filtix-layer="scene"]')!;
    let darkest = [255, 255, 255, 255];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        const candidate = pixel(canvas, x + dx, y + dy);
        if (candidate[0]! + candidate[1]! + candidate[2]! < darkest[0]! + darkest[1]! + darkest[2]!) {
          darkest = candidate;
        }
      }
    }
    return darkest;
  },
  exportPixel,
  regionCoverage(x0: number, x1: number, y0: number, y1: number) {
    const canvas = host.querySelector<HTMLCanvasElement>('canvas[data-filtix-layer="scene"]')!;
    const left = Math.floor(Math.min(x0, x1));
    const right = Math.ceil(Math.max(x0, x1));
    const top = Math.floor(Math.min(y0, y1));
    const bottom = Math.ceil(Math.max(y0, y1));
    let samples = 0;
    let nonBackground = 0;
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) {
        const rgba = pixel(canvas, x, y);
        samples += 1;
        if (rgba[0] !== 255 || rgba[1] !== 255 || rgba[2] !== 255) nonBackground += 1;
      }
    }
    return { samples, nonBackground };
  },
  canvasMetrics() {
    const canvases = [...host.querySelectorAll<HTMLCanvasElement>('canvas')];
    const scene = canvases[0]!;
    return {
      count: canvases.length,
      width: scene.width,
      height: scene.height,
      cssWidth: scene.getBoundingClientRect().width,
      cssHeight: scene.getBoundingClientRect().height,
      dpr: devicePixelRatio,
    };
  },
};

declare global {
  interface Window {
    bandTestApi: typeof bandTestApi;
  }
}
window.bandTestApi = bandTestApi;
