// The IMPORT FOLDER… control set: the header button, the session-only grid of
// what was imported, and the inspector opened on it. It needs no camera, so
// the gallery renders it in the disconnected state too.

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';
import { localImportSupported, pickLocalCaptures } from '../../device/localImport';
import type { LocalCapture } from '../../device/localImport';
import { CaptureInspector } from './CaptureInspector';
import { formatWhen } from './galleryPaging';
import type { CaptureSource } from './useCaptureFrames';

const CAN_IMPORT = localImportSupported();

export interface LocalImportUi {
  /** Header button, for the gallery's `pagehead-actions` row. */
  action: ReactNode;
  /** Error line plus the imported grid. Renders nothing until something is. */
  section: ReactNode;
  /** Open inspector, or null. Non-null means the device one must stand down. */
  inspector: ReactNode;
  open: boolean;
}

export function useLocalImport(): LocalImportUi {
  // Imported folders are session only: not on the card, not written anywhere,
  // gone when the tab closes.
  const [imported, setImported] = useState<LocalCapture[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = imported.find((c) => c.summary.id === openId) ?? null;
  // `useCaptureFrames` keys its load effect off source identity, so it has to
  // be stable across renders of an open imported capture.
  const source = useMemo<CaptureSource | null>(
    () => (open === null ? null : { kind: 'local', capture: open }),
    [open],
  );

  const importFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await pickLocalCaptures();
      if (found === null) return; // picker dismissed
      if (found.length === 0) {
        setError('No JPEGs in that folder.');
        return;
      }
      setImported(found);
      setOpenId(found[0].summary.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const action = (
    <>
      <Button
        size="sm"
        disabled={busy || !CAN_IMPORT}
        title="Open a folder of frames already pulled off the camera"
        onClick={() => void importFolder()}
      >
        {busy ? 'READING FOLDER…' : 'IMPORT FOLDER…'}
      </Button>
      {CAN_IMPORT ? null : <span className="microlabel">NO FOLDER PICKER IN THIS BROWSER</span>}
    </>
  );

  const clear = () => {
    setImported([]);
    setOpenId(null);
  };

  const section = (
    <>
      {error ? <p className="notice notice--err">Import: {error}</p> : null}
      {imported.length > 0 ? (
        <Panel
          title={`IMPORTED — SESSION ONLY (${imported.length})`}
          actions={
            <Button size="sm" onClick={clear}>
              CLEAR
            </Button>
          }
        >
          <div className="gallery-grid">
            {imported.map((cap) => (
              <button
                key={cap.summary.id}
                type="button"
                className="capturecard"
                onClick={() => setOpenId(cap.summary.id)}
              >
                <span className="capturecard-thumb">
                  <span className="mono" style={{ color: 'var(--text-on-dark)', fontSize: 10 }}>
                    {cap.frames.length} {cap.frames.length === 1 ? 'FRAME' : 'FRAMES'}
                  </span>
                  <span className="capturecard-kind">IMPORTED</span>
                </span>
                <span className="capturecard-meta">
                  <span className="capturecard-id">{cap.summary.id}</span>
                  <span className="capturecard-sub">
                    {cap.summary.ts === null ? 'NO META.JSON' : formatWhen(cap.summary.ts)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Panel>
      ) : null}
    </>
  );

  const inspector =
    open !== null && source !== null ? (
      <CaptureInspector
        summary={open.summary}
        roll={null}
        source={source}
        onClose={() => setOpenId(null)}
        onChanged={() => undefined}
      />
    ) : null;

  return { action, section, inspector, open: open !== null };
}
