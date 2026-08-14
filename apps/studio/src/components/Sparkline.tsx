import { useEffect, useRef } from 'react';

/**
 * Small utility-style line chart in an inset well: dotted grid, one series,
 * min/max/current readouts. Canvas-drawn, redraws on data change.
 *
 * Autoscale (min→max of the data) is the default and is right for series
 * with no meaningful zero — skew, throughput. It is wrong for a series the
 * reader judges against a fixed physical range: autoscaling a cell voltage
 * turned an 0.08 V sag into a cliff that contradicted the honest
 * "SAG OVER RUN 0.080 V" readout printed underneath. Pass yMin/yMax for
 * those and the shape matches reality.
 *
 * Either way the axis range is printed next to MIN/MAX, so the reader can
 * see whether the shape is scaled or absolute.
 *
 * `unit` goes in the label and `format` returns bare numbers, the same
 * contract as `usColumn`. A widget that switched unit per readout printed
 * `MIN 889 µs · AXIS AUTO 889 µs–2.27 ms · MAX 2.27 ms` and made the smallest
 * number look like the largest.
 */
export function Sparkline({
  label,
  unit,
  values,
  format,
  color = '#2f70c9',
  height = 64,
  yMin,
  yMax,
}: {
  label: string;
  /** One unit for every number in the widget. Keeps its real case. */
  unit?: string;
  values: number[];
  format: (v: number) => string;
  color?: string;
  height?: number;
  /** Fixed axis floor. Omit for autoscale. */
  yMin?: number;
  /** Fixed axis ceiling. Omit for autoscale. */
  yMax?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The drawn domain. A fixed range wins over the data, but a value that
  // escapes it is clamped into the plot rather than drawn off-canvas.
  const dataMin = values.length ? Math.min(...values) : 0;
  const dataMax = values.length ? Math.max(...values) : 0;
  const axisMin = yMin ?? dataMin;
  const axisMax = yMax ?? dataMax;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.parentElement ? canvas.parentElement.clientWidth - 16 : 260;
    const cssW = Math.max(120, w);
    // The backing store used to be sized in CSS pixels, so every sparkline on
    // a Retina or 4K bench was drawn at half resolution and upscaled — a
    // blurred 1.5px line under crisp text.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    // Draw in CSS pixels; the transform handles the device ratio.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, height);

    // dotted grid
    ctx.strokeStyle = '#dfe5ec';
    ctx.setLineDash([1, 3]);
    for (let i = 1; i <= 3; i++) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (values.length < 2) return;
    const span = axisMax - axisMin || 1;
    const pad = 6;
    const px = (i: number) => (i / (values.length - 1)) * (cssW - 2 * pad) + pad;
    const py = (v: number) => {
      const frac = Math.min(1, Math.max(0, (v - axisMin) / span));
      return height - pad - frac * (height - 2 * pad);
    };

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    values.forEach((v, i) => {
      if (i === 0) ctx.moveTo(px(0), py(v));
      else ctx.lineTo(px(i), py(v));
    });
    ctx.stroke();

    // last-point marker
    const last = values[values.length - 1];
    ctx.fillStyle = color;
    ctx.fillRect(px(values.length - 1) - 2, py(last) - 2, 4, 4);
  }, [values, color, height, axisMin, axisMax]);

  const last = values.length ? values[values.length - 1] : 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span className="microlabel">
          {label}
          {/* Units keep their real case inside an uppercased label. */}
          {unit ? <> (<span style={{ textTransform: 'none' }}>{unit}</span>)</> : null}
        </span>
        <span className="val">{values.length ? format(last) : '—'}</span>
      </div>
      <div className="well" style={{ padding: 8 }}>
        <canvas
          ref={canvasRef}
          aria-label={unit ? `${label} chart, ${unit}` : `${label} chart`}
          style={{ display: 'block', width: '100%' }}
        />
      </div>
      {/* Units keep their real case — uppercasing turns µs into MS. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 2 }}>
        <span className="spark-minmax">MIN {values.length ? format(dataMin) : '—'}</span>
        <span className="spark-minmax">
          {yMin !== undefined || yMax !== undefined ? 'AXIS ' : 'AXIS AUTO '}
          {values.length ? `${format(axisMin)}–${format(axisMax)}` : '—'}
        </span>
        <span className="spark-minmax">MAX {values.length ? format(dataMax) : '—'}</span>
      </div>
    </div>
  );
}
