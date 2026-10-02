import { useCallback, useEffect, useRef, useState } from 'react';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import './customer.css';
import './customer-shoot.css';
import './customer-pages.css';
import { useConnectionStore } from '../state/connectionStore';
import { useDeviceStore } from '../state/deviceStore';
import { useUpdateStore } from '../state/updateStore';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { pickLocalCaptures } from '../device/localImport';
import type { LocalCapture } from '../device/localImport';
import { BottomNav } from './BottomNav';
import type { CustomerPage } from './BottomNav';
import { StatusLine } from './StatusLine';
import { NoKino } from './NoKino';
import { ShootPage } from './shoot/ShootPage';
import { PhotosPage } from './photos/PhotosPage';
import { RollPage } from './roll/RollPage';
import { KinoPage } from './kino/KinoPage';
import type { KinoView } from './kino/KinoPage';
import { UpdateFlow } from './kino/UpdateFlow';
import { useUpdateCheck, useUpdateCheckStore } from './kino/useUpdateCheck';
import { attentionRows } from './attention';
import type { AttentionTarget } from './attention';
import { cameraName, statusSentence } from './copy';
import { useBusyLabel } from './useReadOnly';
import { useSerialWatch } from './useSerialWatch';

/** The cover drops (240 ms) and the sentence names the camera for one beat. */
const RECOGNITION_MS = 240 + 600;

/**
 * The customer shell. No KINO until a camera is recognised; then the status
 * line, one page and the four words at the bottom. Connected Studio always
 * opens on Shoot. Navigation is a cut.
 */
export function CustomerApp() {
  const phase = useConnectionStore((s) => s.phase);
  const state = useDeviceStore();
  const { info, config } = state;
  const reduced = useReducedMotion();
  const busyLabel = useBusyLabel();
  const update = useUpdateStore();
  const available = useUpdateCheckStore((s) => (s.dismissed ? null : s.available));
  const [page, setPage] = useState<CustomerPage>('shoot');
  const [kinoView, setKinoView] = useState<{ view: KinoView; nonce: number }>({ view: 'settings', nonce: 0 });
  const [recognised, setRecognised] = useState<string | null>(null);
  const [inverted, setInverted] = useState(false);
  const [local, setLocal] = useState<LocalCapture[] | null>(null);
  const wasInSession = useRef(false);

  useSerialWatch();
  useUpdateCheck();

  const inSession =
    (phase === 'connected' || phase === 'maintenance' || phase === 'updating' || phase === 'reconnecting') && info !== null;

  // Recognition: hold No KINO for one beat with the cover dropping and the
  // sentence naming the camera, then cut to Shoot.
  useEffect(() => {
    if (inSession && !wasInSession.current) {
      wasInSession.current = true;
      setPage('shoot');
      setLocal(null);
      if (reduced) return;
      setRecognised(cameraName(info, config));
      const t = setTimeout(() => setRecognised(null), RECOGNITION_MS);
      return () => clearTimeout(t);
    }
    if (!inSession) {
      wasInSession.current = false;
      setRecognised(null);
    }
    return undefined;
  }, [inSession, info, config, reduced]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [page, kinoView.nonce]);

  const openKino = useCallback((view: KinoView) => {
    setPage('kino');
    setKinoView((k) => ({ view, nonce: k.nonce + 1 }));
  }, []);

  const onAttention = useCallback(
    (target: AttentionTarget) => {
      if (target === 'photos') setPage('photos');
      else if (target === 'wifi') openKino('wifi');
      else if (target === 'update') openKino('update');
      else openKino('match');
    },
    [openKino],
  );

  const openFolder = async () => {
    try {
      const captures = await pickLocalCaptures();
      if (captures && captures.length > 0) setLocal(captures);
    } catch {
      // No folder picker in this browser: the sentence on the page is all there is.
    }
  };

  if (!inSession && local) {
    return (
      <div className="customer">
        <div className="c-page">
          <PhotosPage local={local} onCloseLocal={() => setLocal(null)} />
        </div>
      </div>
    );
  }

  if (!inSession || recognised) {
    return (
      <div className="customer">
        <NoKino recognised={recognised} reduced={reduced} onOpenFolder={() => void openFolder()} />
      </div>
    );
  }

  // An update owns the whole page while it runs, halts, or has just finished.
  if (update.running || update.halted || update.finished) {
    return (
      <div className="customer">
        <div className="c-page">
          <StatusLine sentence={statusSentence(phase, busyLabel)} rows={[]} onAction={onAttention} />
          <main className="c-main">
            <UpdateFlow onDone={() => setPage('shoot')} />
          </main>
        </div>
      </div>
    );
  }

  const rows = attentionRows({
    storage: state.storage,
    cameras: state.cameras,
    calibration: state.calibration,
    stats: state.stats,
    network: state.network,
    roll: state.roll,
    updateVersion: available?.release ?? null,
  });
  const locked = phase === 'updating' || phase === 'reconnecting';

  return (
    <div className={`customer${inverted ? ' is-inverted' : ''}`}>
      <div className="c-page">
        <StatusLine sentence={statusSentence(phase, busyLabel)} rows={rows} onAction={onAttention} />
        <main className="c-main">
          {page === 'shoot' ? (
            <ShootPage onOpenPhotos={() => setPage('photos')} />
          ) : page === 'photos' ? (
            <PhotosPage />
          ) : page === 'roll' ? (
            <RollPage onSetupWifi={() => openKino('wifi')} onInverted={setInverted} />
          ) : (
            <KinoPage view={kinoView.view} nonce={kinoView.nonce} onView={(v) => setKinoView((k) => ({ view: v, nonce: k.nonce + 1 }))} />
          )}
        </main>
        <BottomNav page={page} locked={locked} onNavigate={setPage} />
      </div>
    </div>
  );
}
