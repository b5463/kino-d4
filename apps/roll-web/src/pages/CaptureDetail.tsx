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

/** `21:40` and `2026.08.22 21:40` — the way the camera writes a time. */
function two(n: number): string {
  return String(n).padStart(2, '0');
}

export function clockOf(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function stampOf(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getFullYear())}.${two(d.getMonth() + 1)}.${two(d.getDate())} ${clockOf(value)}`;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'image/gif': 'gif',
};

/** `KINO_0003_wiggle.mp4` — what the file is called once it is off the phone. */
export function fileName(
  capture: { captureId: string; capturedAt: string },
  role: string,
  mime: string,
): string {
  const stamp = stampOf(capture.capturedAt).replace(/[.: ]/g, '');
  const kind = role.replace(/^kino-|^social-/, '');
  return `KINO_${stamp}_${kind}.${EXT[mime] ?? 'bin'}`;
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
  const [saving, setSaving] = useState(false);
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

  /**
   * Hand the file to the system share sheet when the browser can, because a
   * plain download does not reach Photos on iOS — it lands in Files, if
   * anywhere. The sheet offers "Save Image"/"Save Video", which is what a
   * guest actually wants. Anything else falls through to the download link.
   */
  const shareFile = async (url: string, name: string, mime: string): Promise<boolean> => {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
    try {
      const body = await fetch(url).then((r) => (r.ok ? r.blob() : null));
      if (body === null) return false;
      const file = new File([body], name, { type: mime });
      if (!navigator.canShare({ files: [file] })) return false;
      await navigator.share({ files: [file] });
      return true;
    } catch (caught) {
      // A cancelled share is a decision, not a failure.
      if (caught instanceof DOMException && caught.name === 'AbortError') return true;
      return false;
    }
  };

  /** A save row: download link when the asset exists, render request until then. */
  const saveAction = (role: AssetRole, label: string, hint: string, lead: ReactElement): ReactElement => {
    const asset = assetsByRole(capture, role)[0];
    if (asset !== undefined) {
      const href = api.assetUrl(asset.assetId, { download: true });
      return (
        <a
          className="action-link"
          href={href}
          download
          onClick={(event) => {
            event.preventDefault();
            void shareFile(href, fileName(capture, role, asset.mime), asset.mime).then((shared) => {
              if (!shared) window.location.href = href;
              setSaving(false);
            });
          }}
        >
          {lead}
          {label}
          <span className="k-hint">{hint}</span>
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
        {lead}
        {label}
        <span className="k-hint">{requestedRoles.has(role) ? 'Preparing…' : hint}</span>
      </button>
    );
  };

  const pinnedFrame = frame === null ? undefined : originals[frame];

  let media;
  if (pinnedFrame !== undefined) {
    media = assetImage(pinnedFrame, api, `Frame ${String((frame ?? 0) + 1)}`);
  } else if (capture.mode === 'wiggle') {
    // Playback is not a download: a host turning saves off must not freeze
    // the photograph or hide the frames it was built from.
    media =
      originalUrls.length >= 2 ? (
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
  const showFrameStrip = capture.mode === 'wiggle' && originals.length > 0;

  // The leading mark on a row IS the shape you are about to save.
  const box = (w: number, h: number): ReactElement => (
    <span className="k-lead" aria-hidden="true"><i style={{ width: w, height: h }} /></span>
  );
  const bars = (
    <span className="k-lead" aria-hidden="true"><b /><b /><b /><b /></span>
  );

  // ORIGINAL is a still that already exists, so it is a plain link; the rest
  // may still need building the first time somebody asks for them.
  const derived: [AssetRole, string, string, ReactElement][] = [
    ...(capture.mode === 'wiggle'
      ? ([['wiggle-mp4', 'Wiggle', 'mp4 · to Photos', bars]] as [AssetRole, string, string, ReactElement][])
      : []),
    ['social-9x16', 'Story', '9:16', box(11, 18)],
    ['social-4x5', 'Post', '4:5', box(14, 18)],
    ['social-1x1', 'Square', '1:1', box(17, 17)],
  ];

  const originalHref =
    savablePhoto === undefined ? null : api.assetUrl(savablePhoto.assetId, { download: true });

  return (
    <article className="photo-page">
      <h1 className="k-sr">{`${roll.title} — capture from ${clockOf(capture.capturedAt)}`}</h1>

      <div ref={heroRef} className="k-hero">
        {media}
      </div>

      {showFrameStrip ? (
        <>
          <h2 className="k-sr">The four frames</h2>
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
                <img src={api.assetUrl(asset.assetId)} alt="" />
                <span aria-hidden="true">{index + 1}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <dl className="k-exif">
        <div><dt>shot</dt><dd>{stampOf(capture.capturedAt)}</dd></div>
        <div><dt>device</dt><dd>D4</dd></div>
        <div>
          <dt>frames</dt>
          <dd>{capture.frameCount >= 2 ? `1-${String(capture.frameCount)}` : '1'}</dd>
        </div>
        {frame === null ? null : (
          <div><dt>showing</dt><dd>{frame + 1}</dd></div>
        )}
      </dl>

      <div className="k-acts" aria-label="Capture actions">
        {roll.downloadsEnabled ? (
          <button type="button" className="k-save" onClick={() => setSaving(true)}>
            Save
          </button>
        ) : (
          <span className="k-save" aria-disabled="true">Saving is off for this roll</span>
        )}
        {roll.reactionsEnabled ? (
          <button
            type="button"
            className="k-icon"
            aria-pressed={capture.reacted}
            aria-label={capture.reacted ? 'Remove heart' : 'Add heart'}
            disabled={reacting}
            onClick={() => void react()}
          >
            {capture.reacted ? '\u2665' : '\u2661'} {capture.reactionCount}
          </button>
        ) : null}
      </div>
      {sharing === '' ? null : (
        <p className="k-status" role="status" aria-live="polite" aria-atomic="true">{sharing}</p>
      )}

      {/* One save action, one plain list. The crop ratios used to sit in a
          second box competing with "Save photo"; they are formats of the same
          decision, so they belong behind the same control. */}
      {saving ? (
        <div className="k-sheet" role="dialog" aria-modal="true" aria-label="Save">
          <button type="button" className="k-veil" aria-label="Close" onClick={() => setSaving(false)} />
          <menu className="k-tray">
            <li><div className="k-grip" aria-hidden="true" /><p className="k-tray-head">Save · goes to your photos</p></li>
            {originalHref === null || savablePhoto === undefined ? null : (
              <li>
                <a
                  className="action-link"
                  href={originalHref}
                  download
                  onClick={(event) => {
                    event.preventDefault();
                    void shareFile(
                      originalHref,
                      fileName(capture, 'kino-still', savablePhoto.mime),
                      savablePhoto.mime,
                    ).then((shared) => {
                      if (!shared) window.location.href = originalHref;
                      setSaving(false);
                    });
                  }}
                >
                  {box(20, 15)}
                  Original
                  <span className="k-hint">{capture.resolution}</span>
                </a>
              </li>
            )}
            {derived.map(([role, label, hint, lead]) => (
              <li key={role}>{saveAction(role, label, hint, lead)}</li>
            ))}
            <li>
              <button
                type="button"
                className="action-link"
                aria-label="Share"
                onClick={() => {
                  void share();
                  setSaving(false);
                }}
              >
                <span className="k-lead" aria-hidden="true">
                  <i style={{ width: 15, height: 15, borderStyle: 'dashed' }} />
                </span>
                Share a link
                <span className="k-hint">anyone with the roll</span>
              </button>
            </li>
            <li>
              <button type="button" className="action-link k-cancel" onClick={() => setSaving(false)}>
                Cancel
              </button>
            </li>
          </menu>
        </div>
      ) : null}
    </article>
  );
}
