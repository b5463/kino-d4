import QRCode from 'qrcode';

// QR for the virtual D4 display and the Roll panel (issue #75). The display
// redraw loop is synchronous, so the canvas is rendered once per URL in the
// background and read from a one-entry cache.

let cache: { url: string; canvas: HTMLCanvasElement } | null = null;
let rendering: string | null = null;

/** Synchronous read; kicks off a render when the URL is new. Null until the
 * first render lands (one redraw tick later). */
export function rollQrCanvas(url: string | null): HTMLCanvasElement | null {
  if (!url) return null;
  if (cache?.url === url) return cache.canvas;
  if (rendering !== url) {
    rendering = url;
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, url, { width: 148, margin: 1 })
      .then(() => {
        cache = { url, canvas };
      })
      .catch(() => {
        rendering = null;
      });
  }
  return null;
}
