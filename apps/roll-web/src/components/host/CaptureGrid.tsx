import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Button, ToolbarFrame } from '@kino/design-system';
import type { HostCaptureView } from '../../api/hostClient';
import { SafeImage } from '../SafeImage';

/**
 * The moderation grid.
 *
 * A wedding roll is not fifty captures, it is two thousand. Painted whole, that
 * was ~13,400 DOM nodes and ~1,800 `<img>` elements in one page — the phone it
 * is meant to be moderated from could not scroll it. Rows are virtualised
 * against the window scroller, the same mechanism the guest feed uses, so the
 * document holds one screen of tiles plus a little overscan whatever the roll's
 * size.
 *
 * The filter bar is the other half of the same problem: finding 47 hidden
 * captures among 1,900 by scrolling is not finding them.
 */

export const CAPTURE_FILTERS = ['all', 'pending', 'hidden', 'trash', 'failed'] as const;
export type CaptureFilter = (typeof CAPTURE_FILTERS)[number];

const FILTER_LABEL: Record<CaptureFilter, string> = {
  all: 'All',
  pending: 'Pending',
  hidden: 'Hidden',
  trash: 'In trash',
  failed: 'Failed',
};

export function matchesFilter(capture: HostCaptureView, filter: CaptureFilter): boolean {
  const trashed = capture.deletedAt !== null;
  switch (filter) {
    case 'all':
      return true;
    case 'trash':
      return trashed;
    case 'hidden':
      return !trashed && !capture.visible;
    case 'failed':
      return !trashed && capture.status === 'failed';
    case 'pending':
      return !trashed && capture.status !== 'ready' && capture.status !== 'failed';
  }
}

/**
 * The tile's picture: the capture's own derivative, not one camera's.
 *
 * `frameIndex === null` is what keeps that true. `thumb` now holds a
 * capture-level tile AND one per camera (worker `jobs/thumbnail.ts`), so a bare
 * role match would put a single camera's frame on the host's tile — the same
 * mistake the guest feed's `assetOf` avoids the same way.
 */
export function posterOf(capture: HostCaptureView): string | null {
  const captureLevel = (role: string): string | undefined =>
    capture.assets.find((asset) => asset.role === role && asset.frameIndex === null)?.assetId;
  return captureLevel('thumb') ?? captureLevel('kino-still') ?? captureLevel('wiggle-preview') ?? null;
}

/** What a tile says it is, in one word, for the placeholder and the label. */
export function tileState(capture: HostCaptureView): string {
  if (capture.deletedAt !== null) return 'In trash';
  if (!capture.visible) return 'Hidden';
  if (capture.status === 'failed') return 'Failed';
  if (capture.status !== 'ready') return 'Processing';
  return 'Visible';
}

/** Tile width the CSS grid lands on, and the height one row of them needs. */
const MIN_TILE = 170;
/** Border, padding, the meta line and the button row under the 4:3 media. */
const TILE_CHROME = 60;

interface GridMetrics {
  columns: number;
  rowHeight: number;
  scrollMargin: number;
  /** False until the runway has been measured once. */
  ready: boolean;
}

function useGridMetrics(ref: React.RefObject<HTMLDivElement | null>): GridMetrics {
  const [metrics, setMetrics] = useState<GridMetrics>({
    columns: 1,
    rowHeight: 200,
    scrollMargin: 0,
    ready: false,
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => {
      const width = element.clientWidth;
      const columns = Math.max(1, Math.floor((width + 8) / (MIN_TILE + 8)));
      const tile = columns === 0 ? MIN_TILE : (width - (columns - 1) * 8) / columns;
      setMetrics({
        columns,
        // 4:3 media plus the meta line and the button row. Rounded up, never
        // below a floor: a zero estimate makes the virtualiser render nothing.
        rowHeight: Math.max(120, Math.round((tile * 3) / 4) + TILE_CHROME),
        scrollMargin: element.getBoundingClientRect().top + window.scrollY,
        ready: true,
      });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);

  return metrics;
}

export interface CaptureGridProps {
  captures: HostCaptureView[];
  assetUrl: (assetId: string) => string;
  busy: boolean;
  filter: CaptureFilter;
  onFilter: (filter: CaptureFilter) => void;
  onHide: (captureId: string, next: 'hide' | 'unhide') => void;
  onDelete: (captureId: string) => void;
  onRestore: (captureId: string) => void;
  /** The capture deleted by the last click, which gets the Undo wording. */
  undoFor: string | null;
}

export function CaptureGrid({
  captures,
  assetUrl,
  busy,
  filter,
  onFilter,
  onHide,
  onDelete,
  onRestore,
  undoFor,
}: CaptureGridProps) {
  const counts = useMemo(() => {
    const out: Record<CaptureFilter, number> = { all: 0, pending: 0, hidden: 0, trash: 0, failed: 0 };
    for (const capture of captures) {
      for (const name of CAPTURE_FILTERS) if (matchesFilter(capture, name)) out[name] += 1;
    }
    return out;
  }, [captures]);

  // Newest first, which is the order the list endpoint already uses; the filter
  // narrows that order, it never reorders it.
  const shown = useMemo(
    () => captures.filter((capture) => matchesFilter(capture, filter)),
    [captures, filter],
  );

  const gridRef = useRef<HTMLDivElement>(null);
  const metrics = useGridMetrics(gridRef);

  return (
    <>
      <ToolbarFrame aria-label="Capture filter">
        {CAPTURE_FILTERS.map((name) => (
          <Button
            key={name}
            size="sm"
            variant={name === filter ? 'primary' : 'default'}
            aria-pressed={name === filter}
            onClick={() => onFilter(name)}
          >
            {FILTER_LABEL[name]} {counts[name]}
          </Button>
        ))}
      </ToolbarFrame>

      {shown.length === 0 ? (
        <p className="host-quiet">
          {captures.length === 0 ? 'No captures yet.' : `Nothing in ${FILTER_LABEL[filter]}.`}
        </p>
      ) : null}

      <div ref={gridRef} className="host-captures-window">
        {metrics.ready ? (
          <VirtualRows
            shown={shown}
            metrics={metrics}
            filter={filter}
            assetUrl={assetUrl}
            busy={busy}
            onHide={onHide}
            onDelete={onDelete}
            onRestore={onRestore}
            undoFor={undoFor}
          />
        ) : null}
      </div>
    </>
  );
}

/**
 * Mounted only once the runway has been measured.
 *
 * `scrollMargin` moving under a live virtualiser makes it correct the window
 * scroll to compensate — a page that jumps under the host's thumb the instant
 * the grid appears. Deferring the mount means the virtualiser is born with the
 * right offset and never has to.
 */
function VirtualRows({
  shown,
  metrics,
  filter,
  assetUrl,
  busy,
  onHide,
  onDelete,
  onRestore,
  undoFor,
}: {
  shown: HostCaptureView[];
  metrics: GridMetrics;
  filter: CaptureFilter;
} & Pick<CaptureGridProps, 'assetUrl' | 'busy' | 'onHide' | 'onDelete' | 'onRestore' | 'undoFor'>) {
  const { columns, rowHeight, scrollMargin } = metrics;
  const rows = Math.ceil(shown.length / columns);

  const virtualizer = useWindowVirtualizer({
    count: rows,
    estimateSize: () => rowHeight + 8,
    overscan: 3,
    scrollMargin,
  });

  /**
   * Measure the rows that are actually on screen, so the estimate only has to
   * be right for rows nobody has reached yet.
   *
   * Only where the browser can measure: `measureElement` reads `offsetHeight`,
   * which is 0 under jsdom, and a measured height of zero collapses the whole
   * runway. `ResizeObserver` is the honest test for "this is a real layout".
   */
  const measureRow =
    typeof ResizeObserver === 'function' ? virtualizer.measureElement : undefined;

  // A filter change shortens the list under the scroller; without this the
  // virtualiser keeps offsets from the old, longer one.
  useEffect(() => virtualizer.measure(), [filter, rowHeight, columns, virtualizer]);

  return (
    <div className="host-captures-runway" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
      {virtualizer.getVirtualItems().map((row) => {
        const start = row.index * columns;
        return (
          <div
            key={row.key}
            className="host-captures-row"
            data-index={row.index}
            ref={measureRow}
            style={{
              gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
              transform: `translateY(${String(row.start - virtualizer.options.scrollMargin)}px)`,
            }}
          >
            {shown.slice(start, start + columns).map((capture) => (
              <CaptureTile
                key={capture.captureId}
                capture={capture}
                assetUrl={assetUrl}
                busy={busy}
                onHide={onHide}
                onDelete={onDelete}
                onRestore={onRestore}
                undo={undoFor === capture.captureId}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function CaptureTile({
  capture,
  assetUrl,
  busy,
  onHide,
  onDelete,
  onRestore,
  undo,
}: {
  capture: HostCaptureView;
  assetUrl: (assetId: string) => string;
  busy: boolean;
  onHide: (captureId: string, next: 'hide' | 'unhide') => void;
  onDelete: (captureId: string) => void;
  onRestore: (captureId: string) => void;
  undo: boolean;
}) {
  const poster = posterOf(capture);
  const deleted = capture.deletedAt !== null;
  const state = tileState(capture);
  const time = new Date(capture.capturedAt).toLocaleTimeString();
  return (
    <article
      data-capture-id={capture.captureId}
      data-muted={!capture.visible || deleted}
      data-state={state}
      className="host-capture"
      // The state used to be carried by loose text next to the tile, which a
      // screen reader read as a stray word belonging to nothing.
      aria-label={`${capture.mode} capture at ${time} — ${state}`}
    >
      {poster === null || !capture.visible || deleted ? (
        <div className="host-capture-placeholder">{state}</div>
      ) : (
        <SafeImage className="roll-media" src={assetUrl(poster)} alt="" loading="lazy" />
      )}
      <div className="host-capture-meta">
        <strong>{capture.mode}</strong> · {time}
      </div>
      {deleted ? (
        <ToolbarFrame aria-label={`Restore ${capture.mode} capture`}>
          <Button size="sm" disabled={busy} onClick={() => onRestore(capture.captureId)}>
            {undo ? 'Undo delete' : 'Restore'}
          </Button>
        </ToolbarFrame>
      ) : (
        <ToolbarFrame aria-label={`Moderate ${capture.mode} capture`}>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onHide(capture.captureId, capture.visible ? 'hide' : 'unhide')}
          >
            {capture.visible ? 'Hide' : 'Unhide'}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => onDelete(capture.captureId)}>
            Delete
          </Button>
        </ToolbarFrame>
      )}
    </article>
  );
}
