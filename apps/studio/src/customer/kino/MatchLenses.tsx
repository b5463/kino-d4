import { useEffect, useRef, useState } from 'react';
import type { CalibrationEvent, CamCalibration, CamId } from '@kino/kdp';
import { CAM_IDS } from '@kino/kdp';
import { getDevice, onCalibrationEvent, refreshCalibration } from '../../app/session';
import { claimDevice, releaseDevice } from '../../state/deviceBusy';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { KinoFront } from '../physical/KinoFront';
import type { CellSpec } from '../physical/KinoFront';
import { LENS_POSITIONS } from '../physical/fieldBody';
import { matchFailure } from './matchCopy';

const OWNER = 'match';
const LABEL = 'MATCHING THE LENSES';
const SCALE = 4;
const LIVE_MS = 700;

type Step = 'aim' | 'hold' | 'running' | 'done' | 'failed';

/**
 * Match the lenses. One sentence per step, the four cells holding what the
 * lenses see, one button. The measurement is stored as soon as it lands;
 * the four thumbnails pull into alignment as the sentence becomes "The
 * lenses match." Numbers are Service's.
 */
export function MatchLenses({ onClose }: { onClose: () => void }) {
  const reduced = useReducedMotion();
  const [step, setStep] = useState<Step>('aim');
  const [failure, setFailure] = useState<{ kind: 'lens' | 'light'; sentence: string } | null>(null);
  const [live, setLive] = useState<(string | null)[]>([null, null, null, null]);
  const [nudge, setNudge] = useState<{ x: number; y: number }[] | null>(null);
  const urls = useRef<(string | null)[]>([null, null, null, null]);

  // Live thumbnails while aiming: the four lenses in turn, round after round,
  // at the rate the link allows. Not during the run, which owns the link.
  useEffect(() => {
    if (step !== 'aim' && step !== 'hold') return;
    let cancelled = false;
    const round = async () => {
      const dev = getDevice();
      if (!dev || cancelled) return;
      for (let at = 0; at < 4 && !cancelled; at++) {
        try {
          const bytes = await dev.previewFrame(CAM_IDS[at]!);
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
          if (urls.current[at]) URL.revokeObjectURL(urls.current[at]!);
          urls.current[at] = url;
          setLive([...urls.current]);
        } catch {
          // A lens that does not answer stays paper; the run itself says so.
        }
      }
      if (!cancelled) timer = setTimeout(() => void round(), LIVE_MS);
    };
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => void round(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step]);

  useEffect(
    () => () => {
      urls.current.forEach((u) => u && URL.revokeObjectURL(u));
      releaseDevice(OWNER);
    },
    [],
  );

  useEffect(
    () =>
      onCalibrationEvent((e: CalibrationEvent) => {
        if (e.step === 'result' && e.offsets) {
          void accept(e.offsets);
        } else if (e.step === 'error') {
          releaseDevice(OWNER);
          setFailure(matchFailure(e.message ?? ''));
          setStep('failed');
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const accept = async (offsets: Record<CamId, CamCalibration>) => {
    const dev = getDevice();
    try {
      if (dev) {
        await dev.applyCalibration(offsets);
        await refreshCalibration();
      }
      // Align: show the frames where they were, then let them converge.
      setNudge(CAM_IDS.map((cam) => ({ x: -offsets[cam].x * (SCALE / 5.5), y: -offsets[cam].y * (SCALE / 5.5) })));
      setStep('done');
      setTimeout(() => setNudge(null), reduced ? 0 : 60);
    } catch {
      setFailure({ kind: 'light', sentence: "That didn't work. Try again." });
      setStep('failed');
    } finally {
      releaseDevice(OWNER);
    }
  };

  const run = async () => {
    const dev = getDevice();
    if (!dev) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setFailure(null);
    setStep('running');
    try {
      await dev.startCalibration();
    } catch (err) {
      releaseDevice(OWNER);
      setFailure(matchFailure(err instanceof Error ? err.message : String(err)));
      setStep('failed');
    }
  };

  const cells: CellSpec[] = CAM_IDS.map((_, i) => ({
    url: live[i] ?? null,
    label: `${LENS_POSITIONS[i]} lens`,
    nudge: nudge?.[i],
  }));

  const sentence =
    step === 'aim' ? 'Point KINO at an evenly lit wall.'
    : step === 'hold' ? 'Hold it still.'
    : step === 'running' ? 'Matching the lenses…'
    : step === 'done' ? 'The lenses match.'
    : failure?.sentence ?? "That didn't work. Try again.";
  const body =
    step === 'aim' ? 'A plain wall in daylight is ideal. No windows in the picture.'
    : step === 'hold' ? 'This takes about ten seconds.'
    : step === 'done' ? "Stored on KINO. You won't need to do this again unless something changes."
    : step === 'failed' && failure?.kind === 'light' ? 'Shadows or a lamp in the frame throw it off.'
    : null;

  return (
    <section className="c-flow" aria-label="Match the lenses">
      <h1 className="c-40" role="status">
        {sentence}
      </h1>
      {body ? <p className="c-quiet" style={{ marginTop: 12 }}>{body}</p> : null}
      <div className="c-match-front">
        <KinoFront pxPerMm={SCALE} cover="open" cells={cells} reduced={reduced} />
      </div>
      <div className="c-flow-actions">
        {step === 'aim' ? (
          <button type="button" className="c-button" onClick={() => setStep('hold')}>
            Next
          </button>
        ) : step === 'hold' ? (
          <button type="button" className="c-button" onClick={() => void run()}>
            Match lenses
          </button>
        ) : step === 'done' ? (
          <button type="button" className="c-button" onClick={onClose}>
            Done
          </button>
        ) : step === 'failed' ? (
          <button type="button" className="c-button" onClick={() => setStep('aim')}>
            Try again
          </button>
        ) : null}
        {step !== 'running' && step !== 'done' ? (
          <button type="button" className="c-link" onClick={onClose}>
            Not now
          </button>
        ) : null}
      </div>
    </section>
  );
}
