import { useEffect, useState } from 'react';
import { useConnectionStore } from '../../state/connectionStore';
import { useDeviceStore } from '../../state/deviceStore';
import { setUpdateState, useUpdateStore } from '../../state/updateStore';
import { abortUpdate, retryTarget, startUpdate } from '../../firmware/updater';
import { dismissUpdate, packageFor, useUpdateCheckStore } from './useUpdateCheck';
import { noteLines, updateView } from './updatePhase';

const DONE_HOLD_MS = 3000;

/**
 * The update, one system. "KINO 0.5.0 is ready." with the notes and one
 * button; then one bar and three sentences over the real store; then
 * "KINO is ready. Now on 0.5.0." and back to Shoot. No component rows, no
 * digests, no percentage.
 */
export function UpdateFlow({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const info = useDeviceStore((s) => s.info);
  const phase = useConnectionStore((s) => s.phase);
  const update = useUpdateStore();
  const available = useUpdateCheckStore((s) => s.available);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = update.running || update.halted || update.finished || downloading;
  const view = updateView({ targets: update.targets, phase, halted: update.halted, finished: update.finished, downloading });

  const finish = () => {
    setUpdateState({ targets: [], finished: false, halted: false, fatalError: null, pkg: null });
    useUpdateCheckStore.setState({ available: null });
    onDone();
  };

  useEffect(() => {
    if (!update.finished) return;
    const t = setTimeout(finish, DONE_HOLD_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update.finished]);

  const begin = async () => {
    if (!available) return;
    setError(null);
    setDownloading(true);
    const result = await packageFor(available);
    if (!result.ok) {
      setDownloading(false);
      setError("The update couldn't be fetched. Check the internet connection and try again.");
      return;
    }
    setUpdateState({ pkg: result.value, targets: [], finished: false, halted: false, fatalError: null });
    setDownloading(false);
    await startUpdate(result.value);
  };

  if (running) {
    const version = update.pkg?.manifest.version ?? available?.release ?? '';
    const failed = update.targets.find((t) => t.status === 'failed');
    return (
      <section className="c-flow" aria-label="Update" aria-live="polite">
        <h1 className="c-40">
          {view.stage === 'done' ? `KINO is ready. Now on ${version}.` : view.sentence}
        </h1>
        {update.fatalError && view.stage === 'stopped' ? <p className="c-quiet" style={{ marginTop: 12 }}>KINO didn't start the update. Try again.</p> : null}
        <div className={`c-fill${view.stage === 'done' ? ' is-done' : ''}`} role="progressbar" aria-label="Update progress" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.round(view.progress * 100) / 100}>
          <div className="c-fill-bar" style={{ width: `${Math.round(view.progress * 100)}%` }} />
        </div>
        {view.stage === 'stopped' ? (
          <div className="c-flow-actions">
            <button type="button" className="c-button" onClick={() => void (failed ? retryTarget(failed.id) : begin())}>
              Try again
            </button>
            <button
              type="button"
              className="c-link"
              onClick={() => {
                void abortUpdate();
                finish();
              }}
            >
              Stop for now
            </button>
          </div>
        ) : null}
        {view.stage === 'stopped' ? <p className="c-flow-note">Nothing more is written until you try again. Keep KINO plugged in.</p> : null}
        {view.stage === 'done' ? (
          <div className="c-flow-actions">
            <button type="button" className="c-button" onClick={finish}>
              Back to Shoot
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  if (!available) {
    return (
      <section className="c-flow" aria-label="Update">
        <h1 className="c-40">KINO is up to date{info ? `, ${info.p4Firmware}` : ''}.</h1>
        {onBack ? (
          <div className="c-flow-actions">
            <button type="button" className="c-link" onClick={onBack}>
              Back
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const lines = noteLines(available.notes);
  return (
    <section className="c-flow" aria-label="Update">
      <h1 className="c-40">KINO {available.release} is ready.</h1>
      {lines.length > 0 ? (
        <ul className="c-flow-lines">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      <p className="c-flow-note">About two minutes. KINO restarts at the end. Photos, looks and settings stay.</p>
      {error ? <p className="c-flow-note">{error}</p> : null}
      <div className="c-flow-actions">
        <button type="button" className="c-button" onClick={() => void begin()}>
          Update KINO
        </button>
        <button
          type="button"
          className="c-link"
          onClick={() => {
            dismissUpdate();
            onBack?.();
          }}
        >
          Not now
        </button>
      </div>
    </section>
  );
}
