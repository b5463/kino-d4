// Per-frame exposure statistics for the sensor-matching readout.

export interface FrameStats {
  luma: number; // mean, 0..255
  r: number;
  g: number;
  b: number;
  hist: number[]; // 16-bin luma histogram, normalized 0..1
}

export function computeFrameStats(img: HTMLImageElement): FrameStats {
  const w = 160;
  const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  let r = 0;
  let g = 0;
  let b = 0;
  const hist = new Array(16).fill(0);
  const n = w * h;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    hist[Math.min(15, Math.floor(y / 16))]++;
  }
  const maxBin = Math.max(...hist, 1);
  return {
    luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n,
    r: r / n,
    g: g / n,
    b: b / n,
    hist: hist.map((v: number) => v / maxBin),
  };
}
