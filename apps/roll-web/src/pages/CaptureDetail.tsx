import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import {
  rollApi,
  type AssetRole,
  type CaptureAssetDetail,
  type CaptureDetail as CaptureDetailView,
  type RollApi,
  type RollView,
} from '../api/client';
import { playerPlayback } from '../components/playback';
import { SafeImage } from '../components/SafeImage';
import { StatusChip } from '../components/StatusChip';
import { WigglePlayer } from '../components/WigglePlayer';
import { setPick } from '../state/picks';

export interface CaptureDetailProps {
  slug: string;
  capture: CaptureDetailView;
  roll: RollView;
  api?: RollApi;
  shareUrl?: string;
}

/**
 * Sorted by `frameIndex`, which is the 1-based CAMERA NUMBER, never a position.
 * A sparse capture (cameras 1, 3, 4) lists three assets with frameIndex 1, 3, 4;
 * the frame's place in this list is its playhead slot, its frameIndex its name.
 */
function assetsByRole(capture: Pick<CaptureDetailView, 'assets'>, role: string): CaptureAssetDetail[] {
  return capture.assets
    .filter((asset) => asset.role === role)
    .sort((left, right) => (left.frameIndex ?? 0) - (right.frameIndex ?? 0));
}

/** `CAM 3` — the camera that shot this frame, from frameIndex, never the array slot. */
export function cameraLabel(asset: { frameIndex: number | null }, fallbackSlot: number): string {
  return `CAM ${String(asset.frameIndex ?? fallbackSlot + 1)}`;
}

/** `1-4` when every camera answered, `1, 3, 4` when one did not. */
export function framesLabel(originals: readonly { frameIndex: number | null }[], frameCount: number): string {
  const cameras = originals
    .map((asset) => asset.frameIndex)
    .filter((index): index is number => index !== null);
  if (cameras.length === 0) return frameCount >= 2 ? `1-${String(frameCount)}` : '1';
  const contiguous = cameras.every((camera, position) => camera === position + 1);
  if (cameras.length === 1) return String(cameras[0]);
  return contiguous ? `1-${String(cameras.length)}` : cameras.join(', ');
}

/**
 * The still the hero shows when it is not playing frames: the processed look
 * first (`enhanced-still`, then the device's own `kino-still`, 1280 px), then
 * the middle ORIGINAL frame — the same camera the worker's still would show.
 * Never `thumb`: that is a 480–720 px feed tile, and on a phone the hero is
 * the full viewport width at 2–3× DPR, where a tile reads as a blurred
 * thumbnail scaled up. A thumb never appears on this page at all.
 */
export function heroStill(capture: CaptureDetailView): CaptureAssetDetail | undefined {
  const processed = ['enhanced-still', 'kino-still'].flatMap((role) => assetsByRole(capture, role))[0];
  if (processed !== undefined) return processed;
  const originals = assetsByRole(capture, 'original-frame');
  return originals[Math.floor(originals.length / 2)] ?? originals[0];
}

/**
 * The cheapest asset that depicts a given FRAME.
 *
 * ## Why this is not simply "the thumb"
 *
 * A quad's 97 px strip and its 2x2 overview draw four `original-frame`
 * assets — four full 1600x1200 JPEGs, ~770 kB, for eight boxes none of which
 * is wider than 195 CSS px. On venue Wi-Fi with fifty phones that is the
 * dominant traffic, and swapping in the capture's `thumb` (9 kB) or its
 * `kino-still` (100 kB) would remove nearly all of it.
 *
 * It was tried, and it is wrong. Every derived asset carries
 * `frameIndex: null` (`worker/src/jobs/derive.ts`), because the worker builds
 * ONE derivative per capture from ONE camera (`stillSource` in
 * `worker/src/jobs/capture.ts`). There is no per-camera thumbnail. So the
 * substitution paints the same picture in all four cells: on the bench roll
 * CAM 1 through CAM 4 are visibly different views, and a strip whose whole
 * job is "pick a camera by what it saw" became four copies of camera 3 with
 * different captions. That is not a cheaper strip, it is a wrong one.
 *
 * So this returns a derivative only when the derivative genuinely IS that
 * frame — a single-frame capture — and the original otherwise. The bytes
 * that remain are the price of showing four different photographs, and the
 * fix for them is a per-frame `thumb` from the worker (a `frame_index` on the
 * thumbnail job), not a client-side substitution. What the client CAN do is
 * make sure the hero paints first and the sheet-sized copies arrive behind
 * it, which is what `sheetImage` does.
 */
export function frameSource(
  capture: Pick<CaptureDetailView, 'assets' | 'frameCount'>,
  frame: CaptureAssetDetail,
): CaptureAssetDetail {
  if (capture.frameCount >= 2) return frame;
  for (const role of ['thumb', 'kino-still']) {
    const asset = capture.assets.find((candidate) => candidate.role === role);
    if (asset !== undefined) return asset;
  }
  return frame;
}

/** `1600 / 1200` from the asset row, or null when the worker did not record a size. */
export function aspectOf(asset: { width: number | null; height: number | null }): string | null {
  if (asset.width === null || asset.height === null || asset.width <= 0 || asset.height <= 0) return null;
  return `${String(asset.width)} / ${String(asset.height)}`;
}

/**
 * Width over height of the whole quad: `columns` frames across, the rows it
 * takes below, each frame at the first frame's ratio. Landscape and desktop
 * cap the quad's width from this so the block fits the viewport height
 * without scrolling; portrait ignores it and takes the full width.
 */
export function quadRatio(
  frames: readonly { width: number | null; height: number | null }[],
  columns: number,
): number {
  const first = frames.find((frame) => aspectOf(frame) !== null);
  const frame = first === undefined ? 4 / 3 : (first.width ?? 4) / (first.height ?? 3);
  const rows = Math.max(1, Math.ceil(Math.max(frames.length, 1) / columns));
  return (columns * frame) / rows;
}

/**
 * Which frame a quad opens on. A phone in portrait is ~390 CSS px wide: a
 * 2x2 of 4:3 frames puts each picture at 195x146, which is a contact sheet,
 * not a photograph - the operator's words were "you cannot even make out the
 * pictures". So on a narrow screen the page opens on ONE frame, the full
 * width, with the CAM strip under it to switch; a tap on the big frame goes
 * back to the 2x2. A desktop has the room and opens on the overview. Null
 * means the overview. Pure so it can be tested without a window; the caller
 * passes what `matchMedia` said.
 */
export function initialQuadFrame(
  capture: Pick<CaptureDetailView, 'mode' | 'assets'>,
  narrow: boolean,
): number | null {
  if (!narrow || capture.mode !== 'quad') return null;
  return assetsByRole(capture, 'original-frame').length > 0 ? 0 : null;
}

const NARROW = '(max-width: 600px)';

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
  // The frame's own ratio, so the box is right before the bytes arrive and a
  // 4:3 frame is never letterboxed into a square or squeezed into 16:9.
  const aspect = aspectOf(asset);
  return (
    <SafeImage
      key={asset.assetId}
      src={api.assetUrl(asset.assetId)}
      alt={alt}
      className="photo-img"
      width={asset.width ?? undefined}
      height={asset.height ?? undefined}
      style={aspect === null ? undefined : { aspectRatio: aspect }}
      retry
    />
  );
}

/**
 * A contact-sheet-sized picture: the small derivative's bytes drawn at the
 * frame's own shape.
 *
 * `aspectRatio` comes from whichever of the two rows recorded a size, so the
 * box is the right shape before any bytes arrive and nothing reflows when
 * they do. `width`/`height` are the intrinsic size of the FILE being fetched
 * — they have to describe the bytes, not the frame, or the browser's own
 * ratio would disagree with the CSS one.
 */
function sheetImage(
  source: CaptureAssetDetail,
  frame: { width: number | null; height: number | null },
  api: RollApi,
  alt: string,
  aspectFallback: string,
) {
  const aspect = aspectOf(frame) ?? aspectOf(source) ?? aspectFallback;
  return (
    <SafeImage
      src={api.assetUrl(source.assetId)}
      alt={alt}
      className="photo-img"
      // The intrinsic size of the FILE, plus the ratio of the frame, so the
      // box is right before the bytes land and nothing reflows when they do.
      width={source.width ?? undefined}
      height={source.height ?? undefined}
      // Behind the hero. These are contact-sheet copies of pictures the guest
      // has not asked to look at yet; the one they ARE looking at must not
      // queue behind them on a party uplink.
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      style={{ aspectRatio: aspect }}
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
  // One status line for everything this page reports back — a copied link, a
  // failed share, a render the platform refused.
  const [status, setStatus] = useState('');
  const [reacting, setReacting] = useState(false);
  const [saving, setSaving] = useState(false);
  // null = the default view (wigglegram, or the quad overview); a number pins
  // one D4 frame. A quad on a phone starts pinned - see `initialQuadFrame`.
  const [frame, setFrame] = useState<number | null>(() =>
    initialQuadFrame(
      initialCapture,
      typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches,
    ),
  );
  const heroRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);

  useEffect(() => setCapture(initialCapture), [initialCapture]);

  /**
   * The Save sheet is a modal, so it has to behave like one.
   *
   * It carried `role="dialog" aria-modal="true"` and none of what those two
   * attributes promise: focus stayed on the Save button behind it, Escape did
   * nothing, and a screen reader or a keyboard walked straight past the sheet
   * into a page it was covering. All three are the same fix.
   *
   * `inert` on the page behind is what makes "the background is not there"
   * true for the tab order, the pointer AND the accessibility tree at once —
   * a hand-rolled tab trap only ever covers the first. The sheet is a child
   * of the article, so the article cannot be the inert element; its two
   * children that are NOT the sheet are marked instead.
   */
  useEffect(() => {
    if (!saving) return;
    const previouslyFocused = document.activeElement;
    const sheet = sheetRef.current;
    const article = articleRef.current;

    const behind =
      article === null
        ? []
        : [...article.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.classList.contains('k-sheet'));
    for (const element of behind) element.setAttribute('inert', '');

    const focusables = (): HTMLElement[] =>
      sheet === null
        ? []
        : [...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];

    // The first ACTION, not the veil: the veil is a close target that happens
    // to be first in the DOM, and landing on "Close" is not what opening a
    // save sheet means.
    const first = focusables().filter((element) => !element.classList.contains('k-veil'))[0];
    first?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSaving(false);
        return;
      }
      if (event.key !== 'Tab') return;
      // `inert` already keeps the background out of the tab order; this only
      // wraps the ends of the sheet's own list so focus cannot reach the
      // browser chrome and never come back.
      const inSheet = focusables();
      if (inSheet.length === 0) return;
      const edge = event.shiftKey ? inSheet[0] : inSheet[inSheet.length - 1];
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? inSheet[inSheet.length - 1] : inSheet[0])?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const element of behind) element.removeAttribute('inert');
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [saving]);

  const originals = useMemo(() => assetsByRole(capture, 'original-frame'), [capture.assets]);
  const still = heroStill(capture);
  // Memoized on the assets, not rebuilt every render: a fresh array is a new
  // `frames` prop, and the player reads that as a new set of frames — it
  // restarted the preload and dropped back to the poster on every re-render.
  const originalUrls = useMemo(
    () => originals.map((asset) => api.assetUrl(asset.assetId)),
    [api, originals],
  );
  const currentShareUrl =
    shareUrl ??
    (typeof window === 'undefined'
      ? `/r/${encodeURIComponent(slug)}/c/${encodeURIComponent(capture.captureId)}`
      : window.location.href);

  const share = async (): Promise<void> => {
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: roll.title, url: currentShareUrl });
        setStatus('Shared');
      } else {
        await navigator.clipboard.writeText(currentShareUrl);
        setStatus('Link copied');
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setStatus('Could not share');
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
    setStatus('');
    try {
      await api.requestRender(slug, capture.captureId, role);
    } catch (caught) {
      setRequestedRoles((previous) => {
        const next = new Set(previous);
        next.delete(role);
        return next;
      });
      // The row used to revert to its idle label with nothing said, so a
      // guest saw "Preparing…" flicker back to a hint and had no idea the
      // request had failed. Say so, in the one status line this page has.
      setStatus(
        caught instanceof Error
          ? `Could not prepare that file: ${caught.message}`
          : 'Could not prepare that file',
      );
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
  const failed = capture.status === 'failed';
  // Width over height of what the hero shows, for the landscape height cap.
  const heroAsset = pinnedFrame ?? originals[0] ?? still;
  const heroRatio =
    heroAsset === undefined || aspectOf(heroAsset) === null
      ? null
      : ((heroAsset.width ?? 4) / (heroAsset.height ?? 3)).toFixed(4);

  let media;
  if (pinnedFrame !== undefined) {
    const picture = assetImage(pinnedFrame, api, `${cameraLabel(pinnedFrame, frame ?? 0)} frame`);
    // On a quad the big frame is itself the way back to the 2x2: one tap,
    // no extra control. A wiggle's pinned frame stays a plain picture - its
    // way back is the strip, where the pressed thumb un-pins.
    media =
      capture.mode === 'quad' ? (
        <button type="button" className="photo-open" aria-label="Show all frames" onClick={() => setFrame(null)}>
          {picture}
        </button>
      ) : (
        picture
      );
  } else if (failed) {
    // A failed capture gets no player: whatever frames exist may be half
    // written. The still, if the worker made one, is the honest picture.
    media = still === undefined ? <p className="photo-processing">FAILED</p> : assetImage(still, api, 'Failed capture');
  } else if (capture.mode === 'wiggle') {
    // Playback is not a download: a host turning saves off must not freeze
    // the photograph or hide the frames it was built from.
    media =
      originalUrls.length >= 2 ? (
        <WigglePlayer
          frames={originalUrls}
          {...playerPlayback(capture.playback)}
          poster={still === undefined ? undefined : api.assetUrl(still.assetId)}
        />
      ) : still === undefined ? (
        <p className="photo-processing">Processing…</p>
      ) : (
        assetImage(still, api, 'Wiggle capture')
      );
  } else if (capture.mode === 'quad') {
    const columns = Math.ceil(Math.sqrt(capture.frameCount));
    // One hero child, not three. The grid, the look and the chip used to be
    // separate flex items of a ROW flexbox, so on a phone the four frames
    // shared the width with the label and rendered as a stack of thumbnails
    // in the top-left corner with the look floating beside them.
    media = (
      <div
        className="photo-quad-wrap"
        style={{ '--quad-ratio': quadRatio(originals, columns).toFixed(4) } as CSSProperties}
      >
        <div
          aria-label="Quad frames"
          data-columns={columns}
          className="photo-quad"
          style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }}
        >
          {/* Every frame in the overview is a tap target: it pins that frame
              to the full hero width, where a picture can be looked at. */}
          {originals.map((asset, index) => (
            <figure key={asset.assetId} className="photo-figure">
              <button
                type="button"
                className="photo-open"
                aria-label={`Show ${cameraLabel(asset, index)} large`}
                onClick={() => setFrame(index)}
              >
{sheetImage(frameSource(capture, asset), asset, api, `${cameraLabel(asset, index)} frame`, '4 / 3')}
              </button>
              <figcaption>{cameraLabel(asset, index)}</figcaption>
            </figure>
          ))}
        </div>
        {/* One look, once, as a caption row under the grid. `look` is a single
            value for the whole capture on the guest wire — there are no
            per-camera recipeIds there — so printing it under all four frames
            claimed four recipes that do not exist. */}
        <p className="photo-look">{capture.look ?? 'KINO standard'}</p>
      </div>
    );
  } else {
    media = still === undefined ? <p className="photo-processing">Processing…</p> : assetImage(still, api, 'KINO capture');
  }

  // SAVE PHOTO is a still, never an animation or a video — a guest tapping
  // "save photo" on a wiggle wants a picture their camera roll can show.
  // Never the thumb: a 720 px tile is not a photograph anyone wants to keep.
  const stillRoles = ['enhanced-still', 'kino-still'];
  const savablePhoto = stillRoles.flatMap((role) => assetsByRole(capture, role))[0] ?? originals[0];
  // The strip under the hero: a wiggle's frames, and a quad's four looks -
  // on a quad it is how a phone moves between the four full-width pictures.
  // Two frames at least: with one there is nothing to move between, and a
  // strip of one thumb is one enormous square under the same picture.
  const showFrameStrip =
    (capture.mode === 'wiggle' || capture.mode === 'quad') && originals.length > 1 && !failed;

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
    <article className="photo-page" ref={articleRef}>
      <h1 className="k-sr">{`${roll.title} — capture from ${clockOf(capture.capturedAt)}`}</h1>

      <div
        ref={heroRef}
        className="k-hero"
        style={heroRatio === null ? undefined : ({ '--hero-ratio': heroRatio } as CSSProperties)}
      >
        {media}
        <StatusChip status={capture.status} present={originals.length} />
      </div>

      {showFrameStrip ? (
        <>
          <h2 className="k-sr">The frames</h2>
          <div aria-label="Original frame strip" className="frame-strip">
            {/* `data-slot` is the frame's place in the stored list — the same
                index the player publishes on `data-frame` — so the playhead
                follows position while the printed name follows the camera. */}
            {originals.map((asset, index) => (
              <button
                key={asset.assetId}
                type="button"
                className="frame-thumb"
                data-slot={index}
                aria-pressed={frame === index}
                aria-label={`${cameraLabel(asset, index)} frame`}
                onClick={() => setFrame(frame === index ? null : index)}
              >
{/* A 97 px cell of a picture the guest has not opened. Square by
                    CSS; `aspect-ratio` here too so the row has its height
                    before any bytes arrive. Low priority and lazy: the hero
                    is the picture being looked at and goes first. */}
                <SafeImage
                  src={api.assetUrl(frameSource(capture, asset).assetId)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  fetchPriority="low"
                  style={{ aspectRatio: '1 / 1' }}
                />
                <span aria-hidden="true">{cameraLabel(asset, index)}</span>
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
          <dd>{framesLabel(originals, capture.frameCount)}</dd>
        </div>
        {pinnedFrame === undefined ? null : (
          <div><dt>showing</dt><dd>{cameraLabel(pinnedFrame, frame ?? 0)}</dd></div>
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
      {status === '' ? null : (
        <p className="k-status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
      )}

      {/* One save action, one plain list. The crop ratios used to sit in a
          second box competing with "Save photo"; they are formats of the same
          decision, so they belong behind the same control. */}
      {saving ? (
        <div className="k-sheet" role="dialog" aria-modal="true" aria-label="Save" ref={sheetRef}>
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
