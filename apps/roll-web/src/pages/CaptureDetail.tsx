import { useEffect, useMemo, useRef, useState } from 'react';
import {
  rollApi,
  type CaptureAssetDetail,
  type CaptureDetail as CaptureDetailView,
  type RollApi,
  type RollView,
} from '../api/client';
import { WigglePlayer } from '../components/WigglePlayer';

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

function metadata(capture: CaptureDetailView) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.4rem 1rem' }}>
      <dt>Captured</dt>
      <dd style={{ margin: 0 }}>{new Date(capture.capturedAt).toLocaleString()}</dd>
      <dt>Look</dt>
      <dd style={{ margin: 0 }}>{capture.look ?? 'KINO standard'}</dd>
      <dt>Resolution</dt>
      <dd style={{ margin: 0 }}>{capture.resolution}</dd>
      <dt>Frames</dt>
      <dd style={{ margin: 0 }}>{capture.frameCount}</dd>
    </dl>
  );
}

function assetImage(asset: CaptureAssetDetail, api: RollApi, alt = '') {
  return (
    <img
      key={asset.assetId}
      src={api.assetUrl(asset.assetId)}
      alt={alt}
      style={{ display: 'block', width: '100%', aspectRatio: '4 / 3', objectFit: 'cover' }}
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
      setCapture(await api.getCapture(slug, capture.captureId));
    } finally {
      setReacting(false);
    }
  };

  let media;
  if (capture.mode === 'wiggle') {
    media = (
      <>
        <div ref={heroRef} style={{ background: '#111' }}>
          {roll.downloadsEnabled && originalUrls.length >= 2 ? (
            <WigglePlayer
              frames={originalUrls}
              poster={still === undefined ? undefined : api.assetUrl(still.assetId)}
            />
          ) : still === undefined ? (
            <p style={{ color: 'white', padding: '3rem', textAlign: 'center' }}>Processing…</p>
          ) : (
            assetImage(still, api, 'Wiggle capture')
          )}
        </div>
        <button type="button" onClick={() => void heroRef.current?.requestFullscreen?.()}>
          Full screen
        </button>
        {roll.downloadsEnabled && originals.length > 0 ? (
          <div
            aria-label="Original frame strip"
            style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(72px, 1fr)', gap: 6 }}
          >
            {originals.map((asset, index) => assetImage(asset, api, `Frame ${String(index + 1)}`))}
          </div>
        ) : null}
      </>
    );
  } else if (capture.mode === 'quad') {
    const columns = Math.ceil(Math.sqrt(capture.frameCount));
    media = (
      <div
        aria-label="Quad frames"
        data-columns={columns}
        style={{ display: 'grid', gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`, gap: 8 }}
      >
        {originals.map((asset, index) => (
          <figure key={asset.assetId} style={{ margin: 0, minWidth: 0 }}>
            {assetImage(asset, api, `Camera ${String(index + 1)} frame`)}
            <figcaption style={{ fontSize: '0.75rem', marginTop: 3 }}>
              CAM {String(index + 1)} · {capture.look ?? 'KINO standard'}
            </figcaption>
          </figure>
        ))}
      </div>
    );
  } else {
    media = still === undefined ? <p>Processing…</p> : assetImage(still, api, 'KINO capture');
  }

  const downloadable = preferredAsset(capture) ?? originals[0];

  return (
    <article style={{ maxWidth: 900, margin: '0 auto', display: 'grid', gap: '1rem' }}>
      {media}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
        {roll.downloadsEnabled && downloadable !== undefined ? (
          <a href={api.assetUrl(downloadable.assetId, { download: true })} download>
            Download
          </a>
        ) : null}
        <button type="button" onClick={() => void share()}>
          Share
        </button>
        {roll.reactionsEnabled ? (
          <button
            type="button"
            aria-pressed={capture.reacted}
            aria-label={capture.reacted ? 'Remove heart' : 'Add heart'}
            disabled={reacting}
            onClick={() => void react()}
          >
            {capture.reacted ? '♥' : '♡'} {capture.reactionCount}
          </button>
        ) : null}
        {sharing === '' ? null : <span role="status">{sharing}</span>}
      </div>
      {capture.mode === 'wiggle' && still !== undefined ? (
        <section>
          <h2>Processed still</h2>
          {assetImage(still, api, 'Processed still')}
        </section>
      ) : null}
      <section>
        <h2>Capture details</h2>
        {metadata(capture)}
      </section>
    </article>
  );
}
