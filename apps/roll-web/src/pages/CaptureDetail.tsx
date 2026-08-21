import { useEffect, useMemo, useRef, useState } from 'react';
import {
  rollApi,
  type CaptureAssetDetail,
  type CaptureDetail as CaptureDetailView,
  type RollApi,
  type RollView,
} from '../api/client';
import { WigglePlayer } from '../components/WigglePlayer';
import { Button, Panel, ToolbarFrame } from '@kino/design-system';

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
    <dl className="roll-metadata">
      <dt>Captured</dt>
      <dd>{new Date(capture.capturedAt).toLocaleString()}</dd>
      <dt>Look</dt>
      <dd>{capture.look ?? 'KINO standard'}</dd>
      <dt>Resolution</dt>
      <dd>{capture.resolution}</dd>
      <dt>Frames</dt>
      <dd>{capture.frameCount}</dd>
    </dl>
  );
}

function assetImage(asset: CaptureAssetDetail, api: RollApi, alt = '') {
  return (
    <img
      key={asset.assetId}
      src={api.assetUrl(asset.assetId)}
      alt={alt}
      className="roll-media"
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
        <div ref={heroRef} className="roll-stage">
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
        <Button onClick={() => void heroRef.current?.requestFullscreen?.()}>
          Full screen
        </Button>
        {roll.downloadsEnabled && originals.length > 0 ? (
          <div aria-label="Original frame strip" className="roll-frame-strip">
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
        className="roll-quad"
        style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }}
      >
        {originals.map((asset, index) => (
          <figure key={asset.assetId} className="roll-figure">
            {assetImage(asset, api, `Camera ${String(index + 1)} frame`)}
            <figcaption>
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
    <article className="roll-detail">
      {media}
      <ToolbarFrame className="roll-actions" aria-label="Capture actions">
        {roll.downloadsEnabled && downloadable !== undefined ? (
          <a className="roll-action" href={api.assetUrl(downloadable.assetId, { download: true })} download>
            Download
          </a>
        ) : null}
        <Button onClick={() => void share()}>
          Share
        </Button>
        {roll.reactionsEnabled ? (
          <Button
            aria-pressed={capture.reacted}
            aria-label={capture.reacted ? 'Remove heart' : 'Add heart'}
            disabled={reacting}
            onClick={() => void react()}
          >
            {capture.reacted ? '♥' : '♡'} {capture.reactionCount}
          </Button>
        ) : null}
        {sharing === '' ? null : <span role="status" aria-live="polite" aria-atomic="true">{sharing}</span>}
      </ToolbarFrame>
      {capture.mode === 'wiggle' && still !== undefined ? (
        <Panel title="Processed still">
          {assetImage(still, api, 'Processed still')}
        </Panel>
      ) : null}
      <Panel title="Capture details">
        {metadata(capture)}
      </Panel>
    </article>
  );
}
