import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  apiFailureMessage,
  isNoRollError,
  PinRequiredError,
  rollApi,
  type CaptureView,
  type RollView,
} from '../api/client';
import { evictCaptureAssets } from '../cache/assets';
import { assetOf } from '../captures';
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
import { toggleReaction, usePickedCaptures, usePicks } from '../state/picks';
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
 * grows past a laptop - it gains a column instead.
 *
 * The stream is full-bleed at every width: `roll.css` caps the page chrome at
 * 900 px and says in its own comment that the stream is not part of that. So a
 * column really is a quarter of the window on a wide screen and keeps growing
 * with it, which is why `TILE_SIZES` — which must agree with this — carries a
 * pixel ceiling rather than bare `vw`.
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
 * How wide a tile is, as the browser needs it for `sizes`: the column count
 * `useColumnCount` derives from the same three breakpoints, with a ceiling.
 *
 * The ceiling is the correction. This was pure `vw` with no cap, and the
 * comment above it claimed the stream was capped at 900 px from 720 px up —
 * `roll.css` caps the page CHROME at 900 px (`.k-bar`, `.k-exif`, `.k-acts`,
 * `.k-info`, `.k-note`, `.frame-strip`) and deliberately leaves the stream
 * full-bleed, so on a 2560 px display four columns really are 640 px each and
 * the tiles keep growing with the window. 640 px is the honest cap: nothing
 * this app serves a tile from is wider (`kino-still` is 1280 px, a `thumb` 720,
 * and the device-uploaded thumbs 288), so promising more than that only makes
 * the browser fetch the largest candidate it can find on every screen.
 */
export const TILE_SIZES =
  '(min-width: 1600px) min(25vw, 640px), (min-width: 1100px) min(33vw, 640px), (min-width: 720px) 50vw, 100vw';

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
  eager = false,
}: {
  slug: string;
  capture: CaptureView;
  /**
   * The capture's place in the roll, zero-padded — or null when this surface
   * cannot know it. The Picks tab is the null case: a pick can be a capture
   * that is not in any loaded feed page, so the lookup missed and the tile
   * printed `000`, which is a number and a wrong one. Nothing is better than
   * a wrong frame number, and the clock beside it still identifies the shot.
   */
  index: string | null;
  isNew: boolean;
  picked: boolean;
  /** Null when the roll has hearts turned off; the control is not rendered. */
  onPick: ((captureId: string) => void) | null;
  /**
   * Print this tile's own minute in the overlay. Set when the row mark above
   * is only an hour — on two or more columns a row holds a whole hour, so
   * without this the minute a photograph was taken is nowhere on the feed.
   */
  showClock?: boolean;
  /**
   * The first photograph on the roll. Every tile was `loading="lazy"`,
   * including the one above the fold, so the picture a guest opens the roll to
   * see waited for a layout pass before the browser would even ask for it.
   */
  eager?: boolean;
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
        // The tile is 4:3 by stylesheet, so this is not what shapes the box —
        // it is the intrinsic size of the FILE, which is what stops the
        // browser reflowing the row when the bytes turn out to disagree with
        // the estimate. Absent on the device-uploaded rows, which record none.
        width={source.width ?? undefined}
        height={source.height ?? undefined}
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={eager ? 'high' : undefined}
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
        aria-label={
          index === null
            ? `Open capture from ${clockMark(capture.capturedAt)}`
            : `Open capture ${index} from ${clockMark(capture.capturedAt)}`
        }
      >
        {media}
      </a>
      {isNew ? <span className="k-new">New</span> : null}
      <div className="k-overlay">
        <span className="k-idx">
          <FrameMark capture={capture} />
          {index === null ? null : <span className="k-no">{index}</span>}
          {showClock || index === null ? <span className="k-at">{clockMark(capture.capturedAt)}</span> : null}
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
        {/* No heart when the roll has hearts off. It used to be rendered
            unconditionally and to write only to this phone, while the capture
            page's heart posted a reaction and WAS gated on
            `roll.reactionsEnabled` \u2014 two hearts meaning two things through one
            storage key, so hearting a tile and opening it showed an empty
            heart with a count of zero. One behaviour, one gate. */}
        {onPick === null ? null : (
          <button
            type="button"
            className="k-pick"
            aria-pressed={picked}
            aria-label={
              index === null
                ? picked
                  ? 'Remove heart'
                  : 'Add heart'
                : picked
                  ? `Remove pick ${index}`
                  : `Pick ${index}`
            }
            onClick={() => onPick(capture.captureId)}
          >
            {picked ? '\u2665' : '\u2661'}
          </button>
        )}
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
  /**
   * `hour` is the `HH:00` this mark files under, computed here from the same
   * `Date` the day boundary already needed. `timeIndex` used to re-parse
   * `at` into a fresh `Date` per mark to work it out again, which on a roll
   * with 1,900 captures is a second full pass of date parsing on every live
   * arrival.
   */
  | { kind: 'clock'; key: string; label: string; at: string; hour: string }
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
    const hour = clock === '' ? '' : `${clock.slice(0, 2)}:00`;
    const nextMark = clock === '' ? '' : hourly ? hour : clock;
    if (nextMark !== mark) {
      flush();
      mark = nextMark;
      items.push({
        kind: 'clock',
        key: `t_${capture.captureId}`,
        label: nextMark,
        at: capture.capturedAt,
        hour,
      });
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
    // Any falsy hour, not just the empty string: `streamItems` writes `''` for
    // an `at` it could not parse, and this function is pure and is called on
    // hand-built lists, where the field can be missing outright. An index key
    // labelled `undefined` lands the guest nowhere.
    if (!item.hour) return;
    // A stream that starts mid-day (it cannot, but the function is pure and
    // is called on hand-built lists in the tests) still gets a heading.
    if (days.length === 0) {
      days.push({ key: `d_${item.at}`, label: shortDate(item.at), index, hours: [] });
    }
    const day = days[days.length - 1]!;
    const label = item.hour;
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
   *
   * A Map, built once per feed change, not a `findIndex` per tile. The
   * `findIndex` was O(n) inside a callback the whole grid depends on, so every
   * tile re-rendered whenever the feed changed and each one then walked the
   * list: about sixty tiles times 1,900 captures, ~114,000 comparisons per
   * render on a party roll.
   *
   * Null rather than `000` for a capture that is not in the feed at all. The
   * Picks tab shows `picked`, which can hold captures fetched by id and absent
   * from every loaded page, and those tiles used to number themselves `000`.
   */
  const feedIndex = useMemo(() => {
    const positions = new Map<string, number>();
    feed.captures.forEach((capture, at) => positions.set(capture.captureId, at));
    return positions;
  }, [feed.captures]);

  const indexOf = useCallback(
    (captureId: string): string | null => {
      const at = feedIndex.get(captureId);
      if (at === undefined) return null;
      const total = Math.max(feedIndex.size, roll?.photoCount ?? 0);
      return String(total - at).padStart(3, '0');
    },
    [feedIndex, roll?.photoCount],
  );

  // The plate gives way going down the roll and returns on the first upward
  // move, so the photographs get the screen without navigation ever being
  // more than one gesture away.
  const [barHidden, setBarHidden] = useState(false);
  useEffect(() => {
    let previous = window.scrollY;
    // One read and at most one state write per animation frame. Unthrottled,
    // this ran `setBarHidden` on every scroll event the browser could emit —
    // a React render per frame of a flick, competing with the virtualiser's
    // own work on the same thumb movement.
    let frame: number | null = null;
    const onScroll = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const y = window.scrollY;
        setBarHidden(y > 120 && y > previous);
        previous = y;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

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
  const indexRef = useRef<HTMLDivElement>(null);
  /**
   * The index panel claims `role="dialog" aria-modal="true"`, so it has to
   * behave like one.
   *
   * It did not. `aria-modal` tells assistive technology that everything
   * outside this element is not there — while focus stayed on the mark in the
   * stream that opened it, which is outside. A screen reader user was left
   * with a page that had been declared hidden and a cursor sitting in the
   * hidden part of it. Escape already worked; the other three halves of a
   * dialog are focus in, focus trapped, focus restored.
   *
   * `inert` on everything the panel is NOT is what makes "not there" true for
   * the tab order, the pointer AND the accessibility tree at once, the same
   * way the capture page's save sheet does it. The panel is a child of the app
   * shell, so the shell cannot be the inert element; its other children are.
   * The keydown wrap only stops focus escaping into the browser chrome and
   * never coming back.
   */
  useEffect(() => {
    if (!indexOpen) return;
    const previouslyFocused = document.activeElement;
    const panel = indexRef.current;
    const behind =
      panel?.parentElement === null || panel?.parentElement === undefined
        ? []
        : [...panel.parentElement.children].filter(
            (child): child is HTMLElement => child instanceof HTMLElement && child !== panel,
          );
    for (const element of behind) element.setAttribute('inert', '');

    const focusables = (): HTMLElement[] =>
      panel === null
        ? []
        : [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')];

    // The first HOUR, not the veil: the veil is a close target that happens to
    // be first in the DOM, and landing on "Close" is not what opening a
    // time index means.
    const first = focusables().filter((element) => !element.classList.contains('k-veil'))[0];
    (first ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIndexOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const inPanel = focusables();
      if (inPanel.length === 0) return;
      const edge = event.shiftKey ? inPanel[0] : inPanel[inPanel.length - 1];
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? inPanel[inPanel.length - 1] : inPanel[0])?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const element of behind) element.removeAttribute('inert');
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
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

  /**
   * The heart on a tile: the same thing the capture page's heart does.
   *
   * It used to be `togglePick` — a localStorage write, no request, and no
   * `reactionsEnabled` gate — while the capture page posted a reaction and
   * read the server's answer back. Both wrote the same storage key, so
   * hearting a tile and then opening that photograph showed an empty heart
   * with a count of zero, and `state/picks.ts` claimed the server stayed the
   * truth while the feed was quietly making that false.
   */
  const [pickStatus, setPickStatus] = useState('');
  const onPickToggle = useCallback((captureId: string): void => {
    setPickStatus('');
    void toggleReaction(slug, captureId).then((result) => {
      if ('failed' in result) setPickStatus(result.failed);
    });
  }, [slug]);

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

  /**
   * The stream's own geometry: how wide it is, and how far down the document
   * it starts.
   *
   * Both read off the element, and both re-read whenever anything above it can
   * have moved. The width is what a row's height is derived from — the stream
   * is full-bleed, so on a desktop a column is a quarter of the window and an
   * estimate built from anything else is out by a third.
   *
   * The offset is the one that was broken. `scrollMargin` was
   * `listRef.current?.offsetTop ?? 0` read during render: on the first render
   * the ref is null, so the virtualiser was born believing the stream starts
   * at the top of the document, and nothing ever told it otherwise — not the
   * offline banner appearing, not the closed-roll banner, not the header
   * retracting, not the "N new" pill. Every row was then positioned from a
   * stale origin. It is state now, measured after layout and on every resize.
   */
  const [stream, setStream] = useState<{ width: number; top: number }>(() => ({
    width: typeof window === 'undefined' ? 390 : window.innerWidth,
    top: 0,
  }));
  useEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    const measure = (): void => {
      const width = element.clientWidth;
      const top = element.getBoundingClientRect().top + window.scrollY;
      setStream((current) =>
        // Only on a real change: this runs from a ResizeObserver and from
        // every scroll-driven layout the banners cause, and a fresh object
        // per call would re-render the whole grid for nothing.
        (width > 0 && current.width !== width) || current.top !== top
          ? { width: width > 0 ? width : current.width, top }
          : current,
      );
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    // The stream itself for its width; the app shell for everything that can
    // push it down the page without changing its size.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const shell = element.closest('.k-app');
    if (shell !== null) observer.observe(shell);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [tab, indexOpen, roll?.status, online, failure]);

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: (index) => {
      const kind = items[index]?.kind;
      if (kind === 'clock') return CLOCK_ROW_PX;
      if (kind === 'day') return DAY_ROW_PX;
      return rowEstimate(stream.width, columns);
    },
    overscan: 3,
    scrollMargin: stream.top,
  });

  /**
   * Throw the measurement cache away when the tab changes.
   *
   * Photos and Picks are two different lists behind one virtualiser, and the
   * rows are keyed by position, so the heights measured for Photos row 0..n
   * were reused for whatever Picks put in those positions — a clock mark's
   * 28 px standing in for a row of tiles, and back again.
   */
  useEffect(() => virtualizer.measure(), [tab, columns, stream.width, virtualizer]);
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

  /**
   * The load-more trigger. The `!feed.loading` guard that used to be part of
   * this condition read state against a dependency (`feed`) that is a fresh
   * object every render, so two runs in one commit could both see
   * `loading: false` and both fetch the same page. The guard is inside
   * `useRollFeed.loadMore` now, where it is a ref and is read synchronously.
   */
  useEffect(() => {
    if (
      tab === 'photos' &&
      lastVirtualRow !== undefined &&
      lastVirtualRow.index >= items.length - 2 &&
      feed.hasMore
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

        {/* All five roll statuses, not two. `draft` and `trash` used to render
            nothing at all, so a roll that was not open yet or had been deleted
            looked exactly like a live one with no photographs on it —
            underneath the line "They appear here as the camera sends them",
            which nothing was going to make true. `RollStateBanner` carries the
            other three; `closed` keeps its own component because it prints a
            date. */}
        {roll?.status === 'closed' ? (
          <RollClosed closedAt={roll.closedAt} />
        ) : roll === null ? null : (
          <RollStateBanner status={roll.status} />
        )}

        {/* Page-wide only when there is no roll on screen. A `loadMore` that
            failed with two hundred photographs already loaded used to paint
            "Could not reach the roll" across the top of them; that failure
            belongs to the load-more control, at the bottom, where it is. */}
        {failure !== null && feed.captures.length === 0 ? (
          <LoadFailure
            onRetry={() => void retry()}
            offline={!online}
            reason={apiFailureMessage(failure)}
          />
        ) : null}

        {pickStatus === '' ? null : (
          <p className="k-note" role="status" aria-live="polite" aria-atomic="true">{pickStatus}</p>
        )}

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

            {/* The announcement and the control are two elements, because they
                cannot be one. `role="status"` on a `<button>` REPLACES the
                button role, so assistive technology was told about a live
                region and given no way to activate it — the one control on
                this page that reaches a scrolled thumb was, to a screen
                reader, not a control at all. The span announces; the button
                is a button. */}
            {tab === 'photos' && feed.pending.length > 0 ? (
              <>
                <span className="k-sr" role="status" aria-live="polite">
                  {feed.pending.length} new{' '}
                  {feed.pending.length === 1 ? 'photograph' : 'photographs'}
                </span>
                <button type="button" className="new-pill" onClick={flushPending}>
                  {feed.pending.length} new
                </button>
              </>
            ) : null}

            {/* Only what is already LOADED can be offered: the feed is
                keyset-paginated and the API has no time index a client could
                ask for a cursor by hour, so this grows as the guest goes
                deeper. Every key in it lands on a row that exists, and the
                last line of the panel says as much. */}
            {indexOpen ? (
              <div
                ref={indexRef}
                className="k-index"
                role="dialog"
                aria-modal="true"
                aria-label="Jump to a time"
                tabIndex={-1}
              >
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
                              onPick={roll?.reactionsEnabled === true ? onPickToggle : null}
                              showClock={hourly}
                              eager={capture.captureId === cover?.captureId}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* One more page did not arrive. Scoped to the control that asked
                for it: the photographs above are still readable, still
                openable and still saveable, so a page-wide alert is a lie
                about the state of the page. */}
            {tab === 'photos' && feed.loadMoreError !== null ? (
              <p className="roll-alert" role="alert">
                <span>
                  {online
                    ? (apiFailureMessage(feed.loadMoreError) ?? 'Could not load more of the roll.')
                    : "You're offline. The rest of the roll is not here yet."}
                </span>
                <button type="button" onClick={() => void feed.loadMore().catch(() => {})}>
                  Try again
                </button>
              </p>
            ) : null}
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
