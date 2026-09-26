import { useEffect, useRef, useState } from 'react';
import type { ShootMode } from '@kino/kdp';
import { getDevice, refreshConfig, refreshDeviceInfo, refreshModes } from '../../app/session';
import { useDeviceStore, supports } from '../../state/deviceStore';
import { useReadOnly } from '../useReadOnly';
import { WiggleShoot } from './WiggleShoot';
import { QuadShoot } from './QuadShoot';
import { shootLayout, stageVars } from './shootLayout';
import type { ShootLayout } from './shootLayout';

/**
 * Shoot: the mode words, then the front of KINO with the latest result
 * beside it. The two words are the control; clicking the grey one switches
 * the camera. Everything below belongs to that mode.
 */
export function ShootPage({ onOpenPhotos }: { onOpenPhotos: () => void }) {
  const config = useDeviceStore((s) => s.config);
  const modes = useDeviceStore((s) => s.modes);
  const hasWiggle = useDeviceStore((s) => supports(s, 'wiggle'));
  const hasQuad = useDeviceStore((s) => supports(s, 'quad'));
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<ShootLayout>(() => shootLayout(1232));

  // The body's scale follows the content width; the cells never drop below a
  // useful click size and the result drops under the body before they would.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setLayout(shootLayout(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!config) return null;
  const mode = config.mode;
  const available = (m: ShootMode) => modes?.modes.find((o) => o.id === m)?.available ?? true;
  const offered: ShootMode[] = (['wiggle', 'quad'] as ShootMode[]).filter((m) =>
    m === 'wiggle' ? hasWiggle || mode === 'wiggle' : hasQuad || mode === 'quad',
  );

  const setMode = async (next: ShootMode) => {
    if (next === mode || busy || readOnly) return;
    const dev = getDevice();
    if (!dev) return;
    setBusy(true);
    setNote(null);
    try {
      await dev.setMode(next);
      await Promise.all([refreshConfig(), refreshDeviceInfo(), refreshModes()]);
    } catch {
      setNote("KINO didn't switch. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="c-shoot" aria-label="Shoot" ref={ref}>
      <h1 className="c-modes" aria-label="Mode">
        {offered.map((m) => (
          <button
            key={m}
            type="button"
            className="c-mode"
            aria-pressed={mode === m}
            disabled={busy || readOnly || !available(m)}
            title={available(m) ? undefined : modes?.modes.find((o) => o.id === m)?.unavailableReason ?? undefined}
            onClick={() => void setMode(m)}
          >
            {m === 'wiggle' ? 'Wiggle' : 'Quad'}
          </button>
        ))}
        {note ? <span className="c-mark">{note}</span> : null}
      </h1>
      <div className={`c-stage${layout.stacked ? ' is-stacked' : ''}`} style={stageVars(layout) as React.CSSProperties}>
        {mode === 'wiggle' ? (
          <WiggleShoot layout={layout} readOnly={readOnly} onOpenPhotos={onOpenPhotos} />
        ) : (
          <QuadShoot layout={layout} readOnly={readOnly} onOpenPhotos={onOpenPhotos} />
        )}
      </div>
    </section>
  );
}
