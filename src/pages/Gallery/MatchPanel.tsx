// Sensor-matching readout: mean luma/RGB per frame with deltas against
// CAM2, plus a 16-bin luma histogram. Numbers instead of squinting.

import { useEffect, useRef, useState } from 'react';
import { computeFrameStats } from '../../utils/frameStats';
import type { FrameStats } from '../../utils/frameStats';
import { formatSigned } from '../../utils/format';

function MiniHist({ hist, label }: { hist: number[]; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = 64;
    const h = 22;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
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
              <th className="num">R</th>
              <th className="num">G</th>
              <th className="num">B</th>
              {isWiggle ? <th className="num">Δ R/G/B</th> : null}
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
                {isWiggle ? (
                  <td className="num">{i === 1 ? '—' : formatSigned(s.luma - ref.luma, 1)}</td>
                ) : null}
                <td className="num">{s.r.toFixed(0)}</td>
                <td className="num">{s.g.toFixed(0)}</td>
                <td className="num">{s.b.toFixed(0)}</td>
                {isWiggle ? (
                  <td className="num">
                    {i === 1
                      ? '—'
                      : `${formatSigned(s.r - ref.r, 0)}/${formatSigned(s.g - ref.g, 0)}/${formatSigned(s.b - ref.b, 0)}`}
                  </td>
                ) : null}
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
