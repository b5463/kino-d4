// Sensor-matching readout: mean luma/RGB per frame with deltas against
// CAM2, plus a 16-bin luma histogram. Numbers instead of squinting.

import { useEffect, useRef, useState } from 'react';
import { computeFrameStats } from '../../utils/frameStats';
import type { FrameStats } from '../../utils/frameStats';

/** Drawn size of the sparkline, in CSS pixels. */
const HIST_W = 64;
const HIST_H = 22;
/** Backing-store multiplier ceiling — bounds cost on 5x displays. */
const MAX_DPR = 3;

/**
 * Signed delta that never prints `-0`.
 *
 * `formatSigned` works off the unrounded value, so a −0.4 difference rendered
 * at zero decimals came out as `-0`: a sign on a number the table is calling
 * zero. Rounding first and re-reading the sign fixes it.
 */
function delta(v: number, digits = 0): string {
  const s = v.toFixed(digits);
  const rounded = Number(s);
  if (rounded === 0) return (0).toFixed(digits);
  return rounded > 0 ? `+${s}` : s;
}

function MiniHist({ hist, label }: { hist: number[]; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = HIST_W;
    const h = HIST_H;
    // Backing store = CSS size × device pixel ratio, capped — the same policy
    // the look preview uses. Painting 64×22 device pixels into a 64×22 CSS
    // box left the bars soft on every retina display in the building.
    const dpr = Math.min(MAX_DPR, (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d')!;
    // One unit = one CSS pixel from here down.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    // One deliberate baseline rule, then bars. A per-bin 1px minimum drew a
    // dotted floor under the empty bins that read as a rendering fault.
    ctx.fillStyle = '#c3ceda';
    ctx.fillRect(0, h - 1, w, 1);
    ctx.fillStyle = '#2f70c9';
    hist.forEach((v, i) => {
      const bh = v * (h - 2);
      if (bh > 0) ctx.fillRect(i * 4, h - bh, 3, bh);
    });
  }, [hist]);
  return <canvas ref={ref} aria-label={label} style={{ display: 'block' }} />;
}

export function MatchPanel({ frameUrls, isWiggle }: { frameUrls: string[]; isWiggle: boolean }) {
  const [stats, setStats] = useState<FrameStats[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      frameUrls.map(
        (url) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('decode failed'));
            img.src = url;
          }),
      ),
    ).then(
      (imgs) => {
        if (!cancelled) setStats(imgs.map(computeFrameStats));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [frameUrls]);

  if (!stats) return null;
  const ref = stats[1]; // CAM2

  return (
    <div style={{ marginTop: 10 }}>
      <p className="microlabel" style={{ marginBottom: 4 }}>
        SENSOR MATCH{isWiggle ? ' · DELTAS VS CAM2' : ' · QUAD — LOOKS DIFFER BY DESIGN'}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>CAMERA</th>
              <th className="num">LUMA</th>
              {isWiggle ? <th className="num">Δ LUMA</th> : null}
              {/* Each delta sits next to the channel it belongs to. Packing
                  three of them into one `+12/+5/-0` cell meant reading a
                  string instead of scanning a column. */}
              <th className="num">R</th>
              {isWiggle ? <th className="num">Δ R</th> : null}
              <th className="num">G</th>
              {isWiggle ? <th className="num">Δ G</th> : null}
              <th className="num">B</th>
              {isWiggle ? <th className="num">Δ B</th> : null}
              <th>HISTOGRAM</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => (
              <tr key={i}>
                <td>
                  CAM {i + 1}
                  {i === 1 && isWiggle ? ' (ref)' : ''}
                </td>
                <td className="num">{s.luma.toFixed(1)}</td>
                {isWiggle ? <td className="num">{i === 1 ? '—' : delta(s.luma - ref.luma, 1)}</td> : null}
                <td className="num">{s.r.toFixed(0)}</td>
                {isWiggle ? <td className="num">{i === 1 ? '—' : delta(s.r - ref.r)}</td> : null}
                <td className="num">{s.g.toFixed(0)}</td>
                {isWiggle ? <td className="num">{i === 1 ? '—' : delta(s.g - ref.g)}</td> : null}
                <td className="num">{s.b.toFixed(0)}</td>
                {isWiggle ? <td className="num">{i === 1 ? '—' : delta(s.b - ref.b)}</td> : null}
                <td>
                  <MiniHist
                    hist={s.hist}
                    label={`CAM ${i + 1} luma histogram, 16 bins${i === 1 && isWiggle ? ' (reference)' : ''}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
