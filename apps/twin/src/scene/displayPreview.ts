// Bridge between the virtual sensor and the device display (issue #72): the
// SensorRig renders a small CAM1 view into this shared canvas a few times a
// second; the display drawer paints it into the viewfinder. Module state,
// no store — the display redraw loop already polls at its own cadence.
let canvas: HTMLCanvasElement | null = null;
let updatedAt = 0;

/** How long a preview stays trustworthy before the viewfinder falls back to
 * the synthetic framing marks (renderer stalled, sim powered off). */
const FRESH_MS = 2500;

export function previewCanvas(width: number, height: number): HTMLCanvasElement {
  if (!canvas) canvas = document.createElement('canvas');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}

export function markPreviewUpdated(): void {
  updatedAt = Date.now();
}

export function getDisplayPreview(): CanvasImageSource | null {
  return canvas && Date.now() - updatedAt < FRESH_MS ? canvas : null;
}

export function resetDisplayPreview(): void {
  updatedAt = 0;
}
