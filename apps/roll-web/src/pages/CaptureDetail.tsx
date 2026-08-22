import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { kdpLoopToMediaLoop } from '@kino/media';
import {
  rollApi,
  type AssetRole,
  type CaptureAssetDetail,
  type CaptureDetail as CaptureDetailView,
  type RollApi,
  type RollView,
} from '../api/client';
import { WigglePlayer } from '../components/WigglePlayer';
import { setPick } from '../state/picks';

export interface CaptureDetailProps {
  slug: string;
  capture: CaptureDetailView;
  roll: RollView;
  api?: RollApi;
  shareUrl?: string;
}

function assetsByRole(capture: CaptureDetailView, role: string): CaptureAssetDetail[] {
  return capture.assets
    .filter((asset) => asset.role === role)
    .sort((left, right) => (left.frameIndex ?? 0) - (right.frameIndex ?? 0));
}

function preferredAsset(capture: CaptureDetailView): CaptureAssetDetail | undefined {
  const roles = [
    'enhanced-wiggle',
    'wiggle-mp4',
    'wiggle-webp',
    'contact-sheet',
    'enhanced-still',
    'kino-still',
    'wiggle-preview',
    'thumb',
  ];
  return roles.flatMap((role) => assetsByRole(capture, role))[0];
}

function assetImage(asset: CaptureAssetDetail, api: RollApi, alt = '') {
  return (
    <img
      key={asset.assetId}
      src={api.assetUrl(asset.assetId)}
      alt={alt}
      className="photo-img"
    />
  );
}

/** Mode-aware capture presentation, separated from loading so it is acceptance-testable. */
export function CaptureDetail({
  slug,
  capture: initialCapture,
  roll,
  api = rollApi,
  shareUrl,
}: CaptureDetailProps) {
  const [capture, setCapture] = useState(initialCapture);
  const [sharing, setSharing] = useState('');
  const [reacting, setReacting] = useState(false);
  // null = the default view (wigglegram when available); a number pins one D4 frame.
  const [frame, setFrame] = useState<number | null>(null);
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => setCapture(initialCapture), [initialCapture]);

  const originals = useMemo(() => assetsByRole(capture, 'original-frame'), [capture]);
  const still = preferredAsset(capture);
  const originalUrls = originals.map((asset) => api.assetUrl(asset.assetId));
  const currentShareUrl =
    shareUrl ??
    (typeof window === 'undefined'
      ? `/r/${encodeURIComponent(slug)}/c/${encodeURIComponent(capture.captureId)}`
      : window.location.href);

  const share = async (): Promise<void> => {
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: roll.title, url: currentShareUrl });
        setSharing('Shared');
      } else {
        await navigator.clipboard.writeText(currentShareUrl);
        setSharing('Link copied');
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setSharing('Could not share');
    }
  };

  const react = async (): Promise<void> => {
    if (reacting) return;
    setReacting(true);
    try {
      await api.react(slug, capture.captureId);
      const next = await api.getCapture(slug, capture.captureId);
      setCapture(next);
      // The local picks set is a cache of the server's per-guest truth.
      setPick(slug, next.captureId, next.reacted);
    } finally {
      setReacting(false);
    }
  };

  // Lazy derivatives (wiggle MP4, social crops): request once, then wait for
  // the capture to refresh with the finished asset over SSE.
  const [requestedRoles, setRequestedRoles] = useState<ReadonlySet<AssetRole>>(new Set());
  const requestRender = async (role: AssetRole): Promise<void> => {
    setRequestedRoles((previous) => new Set(previous).add(role));
    try {
      await api.requestRender(slug, capture.captureId, role);
    } catch {
      setRequestedRoles((previous) => {
        const next = new Set(previous);
        next.delete(role);
        return next;
      });
    }
  };

  /** A save control: download link when the asset exists, render request until then. */
  const saveAction = (role: AssetRole, label: string): ReactElement => {
    const asset = assetsByRole(capture, role)[0];
    if (asset !== undefined) {
      return (
        <a className="action-link" href={api.assetUrl(asset.assetId, { download: true })} download>
          {label}
        </a>
      );
    }
    return (
      <button
        type="button"
        className="action-link"
        disabled={requestedRoles.has(role)}
        onClick={() => void requestRender(role)}
      >
        {requestedRoles.has(role) ? 'Rendering…' : label}
      </button>
    );
  };

  const pinnedFrame = frame === null ? undefined : originals[frame];

  let media;
  if (pinnedFrame !== undefined) {
    media = assetImage(pinnedFrame, api, `Frame ${String((frame ?? 0) + 1)}`);
  } else if (capture.mode === 'wiggle') {
    media =
      roll.downloadsEnabled && originalUrls.length >= 2 ? (
        <WigglePlayer
          frames={originalUrls}
          fps={capture.playback?.fps}
          // The stored loop word is KDP's; the player speaks @kino/media's.
          loop={kdpLoopToMediaLoop(capture.playback?.loop ?? 'bounce')}
          poster={still === undefined ? undefined : api.assetUrl(still.assetId)}
        />
      ) : still === undefined ? (
        <p className="photo-processing">Processing…</p>
      ) : (
        assetImage(still, api, 'Wiggle capture')
      );
  } else if (capture.mode === 'quad') {
    const columns = Math.ceil(Math.sqrt(capture.frameCount));
    media = (
      <div
        aria-label="Quad frames"
        data-columns={columns}
        className="photo-quad"
        style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }}
      >
        {originals.map((asset, index) => (
          <figure key={asset.assetId} className="photo-figure">
            {assetImage(asset, api, `Camera ${String(index + 1)} frame`)}
            <figcaption>
              CAM {String(index + 1)} · {capture.look ?? 'KINO standard'}
            </figcaption>
          </figure>
        ))}
      </div>
    );
  } else {
    media = still === undefined ? <p className="photo-processing">Processing…</p> : assetImage(still, api, 'KINO capture');
  }

  // SAVE PHOTO is a still, never an animation or a video — a guest tapping
  // "save photo" on a wiggle wants a picture their camera roll can show.
  const stillRoles = ['enhanced-still', 'kino-still', 'thumb'];
  const savablePhoto = stillRoles.flatMap((role) => assetsByRole(capture, role))[0] ?? originals[0];
  const showFrameStrip = capture.mode === 'wiggle' && roll.downloadsEnabled && originals.length > 0;

  return (
    <article className="photo-page">
      <div className="photo-main">
        <div ref={heroRef} className="photo-frame">
          {media}
        </div>

        {showFrameStrip ? (
          <section className="frame-strip-section">
            <h2 className="section-label">D4 frames</h2>
            <div aria-label="Original frame strip" className="frame-strip">
              {originals.map((asset, index) => (
                <button
                  key={asset.assetId}
                  type="button"
                  className="frame-thumb"
                  aria-pressed={frame === index}
                  aria-label={`Frame ${String(index + 1)}`}
                  onClick={() => setFrame(frame === index ? null : index)}
                >
                  <img src={api.assetUrl(asset.assetId)} alt="" className="photo-img" />
                  <span aria-hidden="true">{index + 1}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="photo-actions" aria-label="Capture actions">
          {roll.reactionsEnabled ? (
            <button
              type="button"
              className="action-link"
              aria-pressed={capture.reacted}
              aria-label={capture.reacted ? 'Remove heart' : 'Add heart'}
              disabled={reacting}
              onClick={() => void react()}
            >
              {capture.reacted ? '♥' : '♡'} {capture.reactionCount}
            </button>
          ) : null}
          {roll.downloadsEnabled && savablePhoto !== undefined ? (
            <a className="action-link" href={api.assetUrl(savablePhoto.assetId, { download: true })} download>
              Save photo
            </a>
          ) : null}
          {roll.downloadsEnabled && capture.mode === 'wiggle' ? saveAction('wiggle-mp4', 'Save wiggle') : null}
          <button type="button" className="action-link" onClick={() => void share()}>
            Share
          </button>
          <button
            type="button"
            className="action-link"
            onClick={() => void heroRef.current?.requestFullscreen?.()}
          >
            Full size
          </button>
          {sharing === '' ? null : <span role="status" aria-live="polite" aria-atomic="true">{sharing}</span>}
        </div>

        {roll.downloadsEnabled ? (
          <div className="photo-actions photo-formats" aria-label="Social formats">
            <span className="format-label">Save for social</span>
            {saveAction('social-9x16', '9:16')}
            {saveAction('social-4x5', '4:5')}
            {saveAction('social-1x1', '1:1')}
          </div>
        ) : null}
      </div>

      <aside className="photo-side">
        {capture.mode === 'wiggle' && still !== undefined ? (
          <section className="side-box">
            <h2 className="section-label">
              KINO process <span className="section-sub">Wiggle · {capture.look ?? 'KINO standard'}</span>
            </h2>
            {assetImage(still, api, 'Processed still')}
          </section>
        ) : null}

        <section className="side-box">
          <h2 className="section-label">Photo information</h2>
          <dl className="info-list">
            <dt>Captured</dt>
            <dd>{new Date(capture.capturedAt).toLocaleString()}</dd>
            <dt>Camera</dt>
            <dd>KINO D4</dd>
            <dt>Look</dt>
            <dd>{capture.look ?? 'KINO standard'}</dd>
            <dt>Resolution</dt>
            <dd>{capture.resolution.replace('x', ' × ')}</dd>
            <dt>Frames</dt>
            <dd>{capture.frameCount}</dd>
          </dl>
        </section>
      </aside>
    </article>
  );
}
