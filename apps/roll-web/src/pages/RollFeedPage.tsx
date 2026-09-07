import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  isNoRollError,
  PinRequiredError,
  rollApi,
  type CaptureView,
  type RollView,
} from '../api/client';
import { evictCaptureAssets } from '../cache/assets';
import { LoadFailure } from '../components/LoadFailure';
import { OfflineBanner } from '../components/OfflineBanner';
import { SafeImage } from '../components/SafeImage';
import { GuestBar, rollLabel, shortDate, SiteFooter } from '../components/SiteHeader';
import { CAMERA_SLOTS, NoPicture, StatusChip } from '../components/StatusChip';
import { useOnline } from '../hooks/useOnline';
import { useRollEvents } from '../hooks/useRollEvents';
import { useRollFeed } from '../hooks/useRollFeed';
import { absoluteUrl, setRouteMeta } from '../meta';
import { rememberRoll } from '../state/lastRoll';
import { togglePick, usePickedCaptures, usePicks } from '../state/picks';
import { NoRollPage } from './NotFoundPage';
import { PinGate } from './PinGate';
import { RollClosed, RollStateBanner, rollAcceptsUploads } from './RollClosed';

export interface RollFeedPageProps {
  slug: string;
}

/**
 * One photograph per row on a phone; two on a tablet, three on a laptop,
 * four on a wide desktop. A 4:3 tile is a third of 1440 px = 480 px wide and
 * a quarter of 1920 px = 480 px wide, so the tile never shrinks as the window
 * grows past a laptop - it gains a column instead. Must agree with
 * `TILE_SIZES`, which tells the browser the same widths for `srcset`.
 */
export const COLUMN_BREAKPOINTS: readonly [query: string, columns: number][] = [
  ['(min-width: 1600px)', 4],
  ['(min-width: 1100px)', 3],
  ['(min-width: 720px)', 2],
];

function useColumnCount(): number {
  const pick = (): number => {
    if (typeof window.matchMedia !== 'function') return 1;
    for (const [query, columns] of COLUMN_BREAKPOINTS) {
      if (window.matchMedia(query).matches) return columns;
    }
    return 1;
  };
  const [columns, setColumns] = useState(pick);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = COLUMN_BREAKPOINTS.map(([query]) => window.matchMedia(query));
    const changed = (): void => setColumns(pick());
    for (const entry of media) entry.addEventListener('change', changed);
    return () => {
      for (const entry of media) entry.removeEventListener('change', changed);
    };
  }, []);

  return columns;
}

/**
 * The capture-level asset for the first of these roles that has one.
 *
 * `frameIndex === null` is the filter that makes this still mean what it did.
 * A role used to hold at most one derived row; `thumb` now holds the
 * capture-level tile AND one per camera (worker `jobs/thumbnail.ts`), so a bare
 * `find(role === 'thumb')` is "whichever camera the API happened to list
 * first" — a tile that is one of four views rather than the capture's own.
 */
function assetOf(capture: Pick<CaptureView, 'assets'>, roles: readonly string[]) {
  for (const role of roles) {
    const asset = capture.assets.find(
      (candidate) => candidate.role === role && candidate.frameIndex === null,
    );
    if (asset !== undefined) return asset;
  }
  return undefined;
}

/**
 * How wide a tile is, as the browser needs it for `sizes`: the column count
 * `useColumnCount` derives from the same two breakpoints.
 */
export const TILE_SIZES = '(min-width: 1600px) 25vw, (min-width: 1100px) 33vw, (min-width: 720px) 50vw, 100vw';

/**
 * Below this device pixel ratio a `thumb` is enough for a tile; at or above
 * it, it is not. One tile is the full phone width, so a 360–430 px CSS tile
 * at 2× already wants 720–860 device pixels and at 3× wants 1080–1290. A
 * `thumb` is 720 px at best and 288 px on the device-uploaded rows this roll
 * is full of, which is where the visible 4× upscale came from.
 */
const TILE_STILL_DPR = 2;

/**
 * The still a tile paints, and the rule that decides it.
 *
 * ## The rule
 *
 * A `srcset` candidate has to be describable — the browser picks by width, so
 * an asset with no recorded width cannot be one. The worker records widths;
 * a DEVICE-uploaded `thumb` does not (`width: null` on every such row), and
 * that is most of them. The old code therefore emitted no `srcset` at all and
 * left a 288 px thumb painted across 1170 device pixels.
 *
 * So, in order:
 *
 *  1. Build the `srcset` from the candidates whose widths ARE known. Two or
 *     more of them and the browser decides, which is always the better answer
 *     — a desktop column at 1× takes the small one, a 3× phone the large one.
 *  2. Fewer than two describable candidates and there is nothing to choose
 *     between, so this picks the single `src` itself, by device pixel ratio:
 *     under 2× the poster thumb is enough for one-tile-per-row; at 2× or more
 *     it is not, and the 1280 px `kino-still` becomes the `src` instead.
 *  3. No still with a known width either — take the poster and accept it.
 *
 * The hero on the capture page is unaffected: it never uses a thumb at all
 * (`heroStill`), and this is the feed's rule only.
 *
 * `dpr` is a parameter rather than a `window` read so the rule is testable.
 */
export function tileSources(
  capture: Pick<CaptureView, 'assets'>,
  assetUrl: (assetId: string) => string,
  dpr: number = typeof window === 'undefined' ? 1 : window.devicePixelRatio,
): { src: string; srcSet?: string; sizes?: string } | undefined {
  const poster = assetOf(capture, ['thumb', 'kino-still', 'wiggle-preview']);
  if (poster === undefined) return undefined;
  const candidates = ['thumb', 'kino-still', 'enhanced-still']
    .flatMap((role) =>
      // Capture-level rows only. A per-camera `thumb` is 720 px too, so it
      // would collide with the capture's own in the width map below and the
      // browser would pick one camera's frame for the whole tile.
      capture.assets.filter((asset) => asset.role === role && asset.frameIndex === null),
    )
    .filter((asset) => asset.width !== null && asset.width > 0);
  const widths = new Map<number, string>();
  for (const asset of candidates) widths.set(asset.width ?? 0, asset.assetId);

  if (widths.size >= 2) {
    const srcSet = [...widths.entries()]
      .sort(([left], [right]) => left - right)
      .map(([width, assetId]) => `${assetUrl(assetId)} ${String(width)}w`)
      .join(', ');
    return { src: assetUrl(poster.assetId), srcSet, sizes: TILE_SIZES };
  }

  // Step 2. Only reached when the poster's own width is unrecorded, because a
  // poster WITH a width is itself one of the describable candidates and a
  // second one would have taken the branch above.
  if (poster.width === null && dpr >= TILE_STILL_DPR) {
    const still = ['kino-still', 'enhanced-still']
      .flatMap((role) =>
        capture.assets.filter((asset) => asset.role === role && asset.frameIndex === null),
      )
      .find((asset) => asset.width !== null && asset.width > 0);
    if (still !== undefined) return { src: assetUrl(still.assetId) };
  }

  return { src: assetUrl(poster.assetId) };
}

/** `21:40` — the clock mark a group of captures is filed under. */
export function clockMark(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The camera numbers that answered, from `frameIndex` (1-based camera number), sorted. */
export function camerasPresent(capture: Pick<CaptureView, 'assets'>): number[] {
  return capture.assets
    .filter((asset) => asset.role === 'original-frame')
    .map((asset) => asset.frameIndex)
    .filter((index): index is number => index !== null)
    .sort((left, right) => left - right);
}

/**
 * One bar per CAMERA SLOT, 1 to 4, lit when a frame from that camera exists
 * and dark when it does not — cameras 1, 3, 4 show slot 2 unlit. Each lit bar
 * carries `data-pos`, the frame's index in the stored list, which is the index
 * a live player publishes on `data-frame`; the stylesheet lights the matching
 * bar so the mark is the playhead, not a badge kept in step by hand. Until
 * the feed knows which cameras answered it lights the first `frameCount`
 * slots. A single-frame capture collapses to one wide bar.
 */
export function FrameMark({ capture }: { capture: Pick<CaptureView, 'assets' | 'frameCount'> }) {
  if (capture.frameCount < 2) return <span className="k-frames k-frames--solo" aria-hidden="true"><b /></span>;
  const known = camerasPresent(capture);
  // `known.length > 0` was the wrong test and it made the mark lie.
  //
  // A feed row does not always list every `original-frame` a capture has —
  // plenty of rows on this roll carry `frameCount: 4` and exactly one of them
  // — so "some originals were listed" is not "these are the cameras that
  // answered". With the old test such a capture drew ONE lit bar and three
  // empty slots: a complete photograph accused of losing three cameras, and
  // the emptier the slot became legible the worse the accusation read.
  //
  // Only a list that accounts for every frame the capture claims can be read
  // as the roster. A genuinely partial capture still shows its gaps, because
  // its `frameCount` IS the number of cameras that answered (three cameras,
  // `frameCount: 3`, `original-frame` 1, 3 and 4 — slot 2 empty).
  const complete = known.length >= capture.frameCount;
  const cameras = complete ? known : Array.from({ length: Math.min(capture.frameCount, CAMERA_SLOTS) }, (_unused, index) => index + 1);
  return (
    <span className="k-frames" aria-hidden="true">
      {Array.from({ length: CAMERA_SLOTS }, (_unused, index) => {
        const camera = index + 1;
        const position = cameras.indexOf(camera);
        return position === -1 ? (
          <b key={camera} data-cam={camera} data-missing="" />
        ) : (
          <b key={camera} data-cam={camera} data-pos={position} />
        );
      })}
    </span>
  );
}

/** Exported for the tile-level tests; the page is the only caller. */
export function CaptureTile({
  slug,
  capture,
  index,
  isNew,
  picked,
  onPick,
  showClock = false,
}: {
  slug: string;
  capture: CaptureView;
  index: string;
  isNew: boolean;
  picked: boolean;
  onPick: (captureId: string) => void;
  /**
   * Print this tile's own minute in the overlay. Set when the row mark above
   * is only an hour — on two or more columns a row holds a whole hour, so
   * without this the minute a photograph was taken is nowhere on the feed.
   */
  showClock?: boolean;
}) {
  const poster = assetOf(capture, ['thumb', 'kino-still', 'wiggle-preview']);
  const failed = capture.status === 'failed';
  // A failed capture shows its still if the worker made one, never a bake.
  const animated = failed ? undefined : assetOf(capture, ['wiggle-webp', 'wiggle-preview']);
  // The grid never mounts the live player. A baked animation is one request
  // of a few tens of kB; the live player is four full-resolution originals
  // per tile, times every tile on screen, on party Wi-Fi. Until the worker
  // has baked one the tile is the thumb, still, wearing "Processing…". The
  // live player belongs to the capture page, where the guest asked for that
  // one photograph.
  const source = animated ?? poster;
  // A baked animation is one file at one size; a still gets the srcset.
  const stillSources = animated === undefined ? tileSources(capture, (id) => rollApi.assetUrl(id)) : undefined;
  const media =
    source === undefined ? (
      <NoPicture status={failed ? 'failed' : 'processing'} />
    ) : (
      <SafeImage
        // `stillSources.src`, not the poster: when no candidate can be
        // described the rule above has already chosen the one file this tile
        // should fetch, and re-deriving it here would throw that away.
        src={stillSources?.src ?? rollApi.assetUrl(source.assetId)}
        srcSet={stillSources?.srcSet}
        sizes={stillSources?.sizes}
        alt=""
        loading="lazy"
        className="photo-img"
      />
    );
  // failed and partial come from the wire; a wiggle with no bake yet is
  // processing whatever the status column says, because that is what the
  // guest is looking at.
  const chipStatus =
    failed || capture.status === 'partial'
      ? capture.status
      : capture.mode === 'wiggle' && animated === undefined
        ? 'processing'
        : capture.status;
  const present = camerasPresent(capture).length || capture.frameCount;

  return (
    <div className="k-shot" data-new={isNew || undefined}>
      <a
        className="k-open"
        href={`/r/${encodeURIComponent(slug)}/c/${encodeURIComponent(capture.captureId)}`}
        aria-label={`Open capture ${index} from ${clockMark(capture.capturedAt)}`}
      >
        {media}
      </a>
      {isNew ? <span className="k-new">New</span> : null}
      <div className="k-overlay">
        <span className="k-idx">
          <FrameMark capture={capture} />
          <span className="k-no">{index}</span>
          {showClock ? <span className="k-at">{clockMark(capture.capturedAt)}</span> : null}
          {/* Motion off: the range is spelled out, since the bars cannot move.
              A baked animation moves without the player, so it is not still.
              With the minute printed there is no room for both, and the bars
              beside it already say how many frames there are. */}
          {capture.frameCount >= 2 && animated === undefined && !showClock ? (
            <span className="k-still">1-{capture.frameCount}</span>
          ) : null}
          {/* The state of the photograph, on the line that already carries
              what this photograph IS — never a plate dropped on the picture.
              A tile with no picture at all says it in the empty window
              instead, so the word is not printed twice. */}
          {source === undefined ? null : <StatusChip status={chipStatus} present={present} />}
        </span>
        <button
          type="button"
          className="k-pick"
          aria-pressed={picked}
          aria-label={picked ? `Remove pick ${index}` : `Pick ${index}`}
          onClick={() => onPick(capture.captureId)}
        >
          {picked ? '\u2665' : '\u2661'}
        </button>
      </div>
    </div>
  );
}

/**
 * A mark in the stream — a day or a clock — and, when there is more than one
 * hour loaded, the handle that opens the time index.
 *
 * It is a button only when there is somewhere to go. A control that opens an
 * empty list is worse than no control, and on a roll with one hour in it there
 * is nothing to jump between.
 */
function Mark({
  className,
  label,
  canJump,
  onJump,
}: {
  className: string;
  label: string;
  canJump: boolean;
  onJump: () => void;
}) {
  const inner = (
    <>
      <i aria-hidden="true" />
      <span>{label}</span>
    </>
  );
  if (!canJump) return <div className={className}>{inner}</div>;
  return (
    <button type="button" className={className} aria-label={`${label} — jump to another time`} onClick={onJump}>
      {inner}
      <span className="k-jump-mark" aria-hidden="true" />
    </button>
  );
}

/** A day boundary, a clock mark, or a row of captures filed under the mark above. */
export type StreamItem =
  | { kind: 'day'; key: string; label: string; at: string }
  | { kind: 'clock'; key: string; label: string; at: string }
  | { kind: 'row'; key: string; captures: CaptureView[] };

/** `2026-8-7` — the calendar day a capture belongs to, in the guest's own zone. */
function dayKey(at: Date): string {
  return `${String(at.getFullYear())}-${String(at.getMonth())}-${String(at.getDate())}`;
}

/**
 * How coarse a clock mark is, for a given column count.
 *
 * A mark ends the row it is standing over, so on a phone (one column) a mark
 * per MINUTE costs nothing: every tile is its own row anyway. On two, three or
 * four columns it cost everything — the captures on this roll are minutes
 * apart, so every group held one tile, every row broke after one tile, and a
 * 1440 px desktop feed was a single left-hand column with two thirds of the
 * screen black. Above one column the mark is the HOUR and the minutes fill
 * the rows underneath it; the tile then prints its own minute (`showClock`).
 */
export function markGranularity(columns: number): 'minute' | 'hour' {
  return columns > 1 ? 'hour' : 'minute';
}

/**
 * The stream: day boundaries, clock marks, and rows of tiles under them.
 *
 * The day comes from each capture's OWN `capturedAt`. It used to come from
 * `roll.createdAt` printed once on the very first mark, which on this roll put
 * `29.08.26` over a photograph taken on 07.09 and left a roll spanning ten
 * days with no boundary anywhere in it.
 */
export function streamItems(captures: readonly CaptureView[], columns: number): StreamItem[] {
  const items: StreamItem[] = [];
  const hourly = markGranularity(columns) === 'hour';
  let day: string | null = null;
  let mark: string | null = null;
  let row: CaptureView[] = [];

  const flush = (): void => {
    if (row.length === 0) return;
    items.push({ kind: 'row', key: `r_${row[0]!.captureId}`, captures: row });
    row = [];
  };

  for (const capture of captures) {
    const at = new Date(capture.capturedAt);
    const clock = clockMark(capture.capturedAt);
    const nextDay = Number.isNaN(at.getTime()) ? null : dayKey(at);
    if (nextDay !== null && nextDay !== day) {
      flush();
      day = nextDay;
      // A new day restarts the clock marks: 23:50 and 00:10 are different
      // hours anyway, but two consecutive days can share one.
      mark = null;
      items.push({
        kind: 'day',
        key: `d_${capture.captureId}`,
        label: shortDate(capture.capturedAt),
        at: capture.capturedAt,
      });
    }
    const nextMark = clock === '' ? '' : hourly ? `${clock.slice(0, 2)}:00` : clock;
    if (nextMark !== mark) {
      flush();
      mark = nextMark;
      items.push({ kind: 'clock', key: `t_${capture.captureId}`, label: nextMark, at: capture.capturedAt });
    }
    row.push(capture);
    if (row.length === columns) flush();
  }
  flush();
  return items;
}

/**
 * Below this scroll depth a live arrival goes to the "N new" pill instead of
 * shifting the grid under the guest's thumb. Above it the head is on screen and
 * prepending is what live means.
 */
const PREPEND_SCROLL_LIMIT_PX = 80;

/**
 * A clock mark's own height: `.k-clock` is 8 + 5 px of padding around one
 * 11 px line. Measured, not guessed — the virtualiser corrects it from the
 * real element on the first measure anyway; this only has to be close enough
 * that the scrollbar is not a lie before that happens.
 */
const CLOCK_ROW_PX = 28;

/** A day boundary is the same line with a rule above it and more air. */
const DAY_ROW_PX = 46;

/**
 * How tall one row of tiles is, from the width it actually has.
 *
 * The estimate used to be a flat 220 px against a real ~300 px row, so the
 * total height was a third short: the scrollbar claimed the roll was shorter
 * than it is and the page grew under the guest's thumb as each page measured
 * itself. A tile is 4:3 and `columns` of them share the stream's width, so
 * the height follows from the width and nothing else. The overlay is
 * absolutely positioned inside the tile and adds none; the `1` is the row's
 * `paddingBottom` hairline, which does.
 */
export function rowEstimate(streamWidth: number, columns: number): number {
  const tile = Math.max(1, streamWidth) / Math.max(1, columns);
  return Math.round(tile * 0.75) + 1;
}

/** One entry in the time index: a label and the stream row it jumps to. */
export interface HourMark {
  key: string;
  /** `21:00`. The day it belongs to is the heading above it. */
  label: string;
  /** Index into the stream, which is what `scrollToIndex` takes. */
  index: number;
}

/** One day of the loaded roll, and the hours inside it. */
export interface DayMark extends HourMark {
  hours: HourMark[];
}

/**
 * The time index, derived from the marks already in the stream.
 *
 * A roll is an evening — or, on this one, ten days — and 1,900 captures is
 * four hundred screens of linear scrolling. This is the shortest thing that
 * makes that navigable without inventing a second data source: the stream
 * already files captures under day and clock marks, so the first mark of each
 * hour IS the row a "21:00" jump should land on. Nothing is fetched for it and
 * nothing is guessed.
 *
 * It can only offer what is LOADED — the feed is keyset-paginated and the API
 * has no time index a client could ask for a cursor by hour — so it grows as
 * the guest goes deeper. That is honest: every key in it lands on a row that
 * exists, and the panel says so.
 *
 * Days rather than a flat hour list because a flat list repeats the same six
 * characters on every key and gives the eye nothing to land on. The heading
 * carries the day once and the hours under it stay two digits wide.
 */
export function timeIndex(items: readonly StreamItem[]): DayMark[] {
  const days: DayMark[] = [];
  const seen = new Set<string>();

  items.forEach((item, index) => {
    if (item.kind === 'day') {
      days.push({ key: `d_${item.at}`, label: item.label, index, hours: [] });
      return;
    }
    if (item.kind !== 'clock') return;
    const at = new Date(item.at);
    if (Number.isNaN(at.getTime())) return;
    // A stream that starts mid-day (it cannot, but the function is pure and
    // is called on hand-built lists in the tests) still gets a heading.
    if (days.length === 0) {
      days.push({ key: `d_${item.at}`, label: shortDate(item.at), index, hours: [] });
    }
    const day = days[days.length - 1]!;
    const label = `${String(at.getHours()).padStart(2, '0')}:00`;
    const key = `${day.key} ${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    day.hours.push({ key, label, index });
  });

  return days.filter((day) => day.hours.length > 0);
}

/** How many hours the whole index offers — under two there is nothing to jump between. */
export function indexSize(days: readonly DayMark[]): number {
  return days.reduce((total, day) => total + day.hours.length, 0);
}

/** Virtualized, keyset-paginated and live-updating guest Roll gallery. */
export function RollFeedPage({ slug }: RollFeedPageProps) {
  const feed = useRollFeed(slug);
  const online = useOnline();
  const [roll, setRoll] = useState<RollView | null>(null);
  const [rollError, setRollError] = useState<Error | null>(null);
  const [tab, setTab] = useState<'photos' | 'picks' | 'info'>('photos');
  const listRef = useRef<HTMLDivElement>(null);
  const columns = useColumnCount();
  const picks = usePicks(slug);
  const picked = usePickedCaptures(slug, picks, feed.captures);
  /**
   * A capture's number is its place in the roll, counted from the oldest, so
   * `003` means the same thing to two guests looking at the same photograph.
   * The feed arrives newest first, hence the subtraction.
   */
  const indexOf = useCallback(
    (captureId: string): string => {
      const at = feed.captures.findIndex((c) => c.captureId === captureId);
      const total = Math.max(feed.captures.length, roll?.photoCount ?? 0);
      const nth = at < 0 ? 0 : total - at;
      return String(nth).padStart(3, '0');
    },
    [feed.captures, roll?.photoCount],
  );

  // The plate gives way going down the roll and returns on the first upward
  // move, so the photographs get the screen without navigation ever being
  // more than one gesture away.
  const [barHidden, setBarHidden] = useState(false);
  useEffect(() => {
    let previous = window.scrollY;
    const onScroll = (): void => {
      const y = window.scrollY;
      setBarHidden(y > 120 && y > previous);
      previous = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Picking is immediate and local: no request, no toast, no confirmation.
  const onPickToggle = useCallback((captureId: string): void => {
    togglePick(slug, captureId);
  }, [slug]);
  const shown = tab === 'picks' ? picked : feed.captures;
  const items = useMemo(() => streamItems(shown, columns), [columns, shown]);
  const days = useMemo(() => timeIndex(items), [items]);
  const hourly = markGranularity(columns) === 'hour';

  // The time index is opened FROM a mark in the stream rather than living in a
  // strip above it. The strip it replaces was a row of pale plate keys that ate
  // the top of the feed, repeated the clock marks immediately below it and ran
  // off the right edge with nothing to say so. A mark is already sticky at the
  // top of the screen and already says where the guest is; making it the
  // control adds no chrome at all and puts the affordance on the thing it
  // describes.
  const [indexOpen, setIndexOpen] = useState(false);
  useEffect(() => {
    if (!indexOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIndexOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [indexOpen]);
  const canJump = indexSize(days) > 1;

  const refreshRoll = useCallback(async (): Promise<void> => {
    try {
      const next = await rollApi.getRoll(slug);
      setRoll(next);
      setRollError(null);
      // The landing page offers a way back to the roll last opened here.
      rememberRoll(slug, next.title);
    } catch (caught) {
      setRollError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, [slug]);

  useEffect(() => {
    void refreshRoll();
  }, [refreshRoll]);

  // What a pasted roll link previews as. The cover is the newest capture's
  // tile — the same picture the guest is looking at when they copy the link.
  const cover = feed.captures[0];
  useEffect(() => {
    const title = roll === null ? rollLabel(undefined, slug) : rollLabel(roll.title, slug);
    const count = roll?.photoCount ?? feed.captures.length;
    const still = cover === undefined ? undefined : tileSources(cover, (id) => rollApi.assetUrl(id));
    setRouteMeta({
      title: `${title} — KINO Roll`,
      description: `${String(count)} ${count === 1 ? 'frame' : 'frames'} from a KINO D4.`,
      image: still === undefined ? undefined : absoluteUrl(still.src),
    });
  }, [cover, feed.captures.length, roll, slug]);

  const removeLive = useCallback(
    (captureId: string): void => {
      const capture = feed.captures.find((candidate) => candidate.captureId === captureId);
      feed.remove(captureId);
      if (capture !== undefined) void evictCaptureAssets(capture, rollApi).catch(() => {});
    },
    [feed],
  );

  const failure = rollError ?? feed.error;

  // Only captures that arrive through the live event stream get the NEW
  // badge; initial pages and older pages never do. The badge stays for the
  // session — the border highlight animates once and settles.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const nearTop = (): boolean => window.scrollY <= PREPEND_SCROLL_LIMIT_PX;
  const prependLive = useCallback(
    (capture: CaptureView): void => {
      if (!nearTop()) {
        feed.buffer(capture);
        return;
      }
      feed.prepend(capture);
      setFreshIds((previous) => new Set(previous).add(capture.captureId));
    },
    [feed],
  );

  // The reconnect/pageshow head refetch obeys the same rule as a live arrival:
  // a scrolled guest gets the pill, not a shifted grid.
  const refetchHeadLive = useCallback(
    async (): Promise<void> => feed.refetchHead({ buffer: !nearTop() }),
    [feed],
  );

  const flushPending = (): void => {
    const flushed = feed.flushPending();
    setFreshIds((previous) => {
      const next = new Set(previous);
      for (const id of flushed) next.add(id);
      return next;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // The host cleared the roll: the list empties in one step, live, and the
  // "N new" pill goes with it. The cached tiles are left to the cache's own
  // expiry — evicting two thousand entries one by one is not worth a stall.
  const clearLive = useCallback((): void => {
    feed.clear();
    setFreshIds(new Set());
  }, [feed]);

  useRollEvents(
    slug,
    {
      prepend: prependLive,
      replace: feed.replace,
      remove: removeLive,
      refetchHead: refetchHeadLive,
      onRollChanged: refreshRoll,
      onRollCleared: clearLive,
    },
    rollApi,
    roll !== null && !(failure instanceof PinRequiredError) && !isNoRollError(failure),
  );

  // The stream's own width, which is what a row's height is derived from.
  // Read off the element rather than the window: the stream is capped at
  // 900 px from 720 px up, so on a desktop the window width is not the tile
  // width and an estimate built from it is out by a third the other way.
  const [streamWidth, setStreamWidth] = useState(() =>
    typeof window === 'undefined' ? 390 : window.innerWidth,
  );
  useEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    const measure = (): void => {
      if (element.clientWidth > 0) setStreamWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tab]);

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: (index) => {
      const kind = items[index]?.kind;
      if (kind === 'clock') return CLOCK_ROW_PX;
      if (kind === 'day') return DAY_ROW_PX;
      return rowEstimate(streamWidth, columns);
    },
    overscan: 3,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastVirtualRow = virtualRows[virtualRows.length - 1];
  // Where the guest is, in the index's own terms: the last hour that starts at
  // or above the topmost rendered row. Without it the panel is a list of
  // places with no "you are here", which is half a map.
  const topIndex = virtualRows[0]?.index ?? 0;
  const currentHourKey = days
    .flatMap((day) => day.hours)
    .filter((hour) => hour.index <= topIndex)
    .at(-1)?.key;

  useEffect(() => {
    if (
      tab === 'photos' &&
      lastVirtualRow !== undefined &&
      lastVirtualRow.index >= items.length - 2 &&
      feed.hasMore &&
      !feed.loading
    ) {
      void feed.loadMore().catch(() => {});
    }
  }, [feed, lastVirtualRow, items.length, tab]);

  if (failure instanceof PinRequiredError) {
    return (
      <PinGate
        slug={slug}
        onUnlocked={async () => {
          await Promise.all([refreshRoll(), feed.refetchHead()]);
        }}
      />
    );
  }

  if (isNoRollError(failure)) return <NoRollPage />;

  const photoCount = roll?.photoCount ?? feed.captures.length;
  const acceptsUploads = rollAcceptsUploads(roll?.status);
  const retry = async (): Promise<void> => {
    await Promise.all([refreshRoll(), feed.refetchHead().catch(() => {})]);
  };

  return (
    <>
      <div className="k-app">
        <OfflineBanner />
        <GuestBar name={rollLabel(roll?.title, slug)} count={photoCount} hidden={barHidden}>
          <nav className="k-nav" aria-label="Roll sections">
            <button type="button" aria-current={tab === 'photos'} onClick={() => setTab('photos')}>
              Roll
            </button>
            <button
              type="button"
              aria-current={tab === 'picks'}
              aria-label={`My picks, ${String(picks.size)}`}
              onClick={() => setTab('picks')}
            >
              Picks
              {picks.size > 0 ? <span className="k-cnt">{String(picks.size).padStart(2, '0')}</span> : null}
            </button>
            <button type="button" aria-current={tab === 'info'} onClick={() => setTab('info')}>
              Info
            </button>
          </nav>
        </GuestBar>

        {roll?.status === 'closed' ? <RollClosed closedAt={roll.closedAt} /> : null}
        {roll?.status === 'archived' ? <RollStateBanner status="archived" /> : null}

        {failure !== null ? <LoadFailure onRetry={() => void retry()} offline={!online} /> : null}

        {tab === 'info' && roll !== null ? (
          <div className="k-info">
            <dl>
              <dt>Roll</dt>
              <dd><b>{roll.title}</b></dd>
              {/* The code, because it is what a guest reads out to somebody
                  who wants in and there was nowhere else on the app to find
                  it once the QR card had been put down. */}
              <dt>Code</dt>
              <dd><b className="k-code">{slug}</b></dd>
              {/* "Date" claimed one day for a roll that can run for ten. This
                  is the day the roll was opened, and it says so. */}
              <dt>Started</dt>
              <dd>{shortDate(roll.createdAt)}</dd>
              {/* One word for the count everywhere: FRAMES. The header window
                  prints `1918 FR`, this row prints `1918 frames`, and the two
                  no longer disagree about what is being counted. */}
              <dt>Frames</dt>
              <dd>
                <b>{photoCount}</b> {photoCount === 1 ? 'frame' : 'frames'}
              </dd>
              <dt>Camera</dt>
              <dd><b>KINO D4</b> · four lenses</dd>
              <dt>Saving</dt>
              <dd>{roll.downloadsEnabled ? 'On — you can keep these photographs' : 'Off for this roll'}</dd>
              <dt>Display</dt>
              <dd>
                <a className="k-link" href={`/r/${encodeURIComponent(slug)}/display`}>
                  Open this roll on a screen
                </a>
              </dd>
            </dl>
          </div>
        ) : null}

        {tab !== 'info' ? (
          <>
            {tab === 'photos' && feed.captures.length === 0 && feed.loading ? (
              <p className="k-note" role="status" aria-live="polite">Reading roll…</p>
            ) : null}
            {tab === 'photos' && feed.captures.length === 0 && !feed.loading && failure === null ? (
              <div className="k-note" role="status" aria-live="polite">
                <span className="k-blank" aria-hidden="true"><b /><b /><b /><b /></span>
                {/* A closed or archived roll takes no more uploads, so "leave
                    this page open" would be a promise nothing can keep. */}
                <b>{acceptsUploads ? 'No photographs yet' : 'No photographs'}</b>
                {acceptsUploads ? 'They appear here as the camera sends them. You can leave this page open.' : null}
              </div>
            ) : null}
            {tab === 'picks' && shown.length === 0 ? (
              <div className="k-note" role="status" aria-live="polite">
                <span className="k-blank" aria-hidden="true"><b /><b /><b /><b /></span>
                <b>Nothing picked</b>
                Tap the heart on a photograph to keep it here. Picks stay on this phone.
              </div>
            ) : null}

            {tab === 'photos' && feed.pending.length > 0 ? (
              <button
                type="button"
                className="new-pill"
                role="status"
                aria-live="polite"
                onClick={flushPending}
              >
                {feed.pending.length} new
              </button>
            ) : null}

            {/* Only what is already LOADED can be offered: the feed is
                keyset-paginated and the API has no time index a client could
                ask for a cursor by hour, so this grows as the guest goes
                deeper. Every key in it lands on a row that exists, and the
                last line of the panel says as much. */}
            {indexOpen ? (
              <div className="k-index" role="dialog" aria-modal="true" aria-label="Jump to a time">
                <button type="button" className="k-veil" aria-label="Close" onClick={() => setIndexOpen(false)} />
                <div className="k-index-body">
                  {days.map((day) => (
                    <section key={day.key} className="k-index-day">
                      <h2>{day.label}</h2>
                      <div className="k-index-hours">
                        {day.hours.map((hour) => (
                          <button
                            key={hour.key}
                            type="button"
                            aria-current={hour.key === currentHourKey}
                            onClick={() => {
                              virtualizer.scrollToIndex(hour.index, { align: 'start' });
                              setIndexOpen(false);
                            }}
                          >
                            {hour.label}
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                  <p className="k-index-note">More hours appear as you scroll further back.</p>
                </div>
              </div>
            ) : null}

            <div ref={listRef} className="k-stream" role="region" aria-label="Roll captures">
              <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
                {virtualRows.map((virtualRow) => {
                  const item = items[virtualRow.index];
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${String(virtualRow.start - virtualizer.options.scrollMargin)}px)`,
                      }}
                    >
                      {item === undefined ? null : item.kind === 'day' ? (
                        /* A real day boundary, from the captures' own clocks.
                           It used to be `shortDate(roll.createdAt)` printed
                           once on the very first mark, which put the roll's
                           birthday over a photograph taken ten days later. */
                        <Mark className="k-day" label={item.label} canJump={canJump} onJump={() => setIndexOpen(true)} />
                      ) : item.kind === 'clock' ? (
                        <Mark className="k-clock" label={item.label} canJump={canJump} onJump={() => setIndexOpen(true)} />
                      ) : (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
                            gap: '1px',
                            paddingBottom: '1px',
                          }}
                        >
                          {item.captures.map((capture) => (
                            <CaptureTile
                              key={capture.captureId}
                              slug={slug}
                              capture={capture}
                              index={indexOf(capture.captureId)}
                              isNew={freshIds.has(capture.captureId)}
                              picked={picks.has(capture.captureId)}
                              onPick={onPickToggle}
                              showClock={hourly}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}
      </div>
      {/* The end mark belongs to the STREAM and only once the stream has
          actually ended. It used to be printed unconditionally, so it sat
          under "Nothing picked", under the Info table, and — worst — directly
          under "Could not reach the roll", where it told a guest whose roll
          had not loaded at all that they had reached the end of it. */}
      {tab === 'photos' && !feed.hasMore && feed.captures.length > 0 && failure === null ? (
        <SiteFooter count={feed.captures.length} />
      ) : null}
    </>
  );
}
