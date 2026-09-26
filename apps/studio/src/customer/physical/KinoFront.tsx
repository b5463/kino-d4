import { useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import { KINO_MARK_HEIGHT_MM, KINO_MARK_POLYGONS } from '../../assets/kino-d4-mark';
import { bodyGeometry, LENS_POSITIONS } from './fieldBody';
import type { BodyGeometry } from './fieldBody';

export type CellRing = 'none' | 'wiggle' | 'selected' | 'drag';

export interface CellSpec {
  /** A photograph clipped into the cell, or null for paper and the bore. */
  url: string | null;
  /** CSS filter for the look the cell carries. */
  filter?: string;
  ring?: CellRing;
  /** Shift of the photograph inside the cell, px. Align uses it; nothing else does. */
  nudge?: { x: number; y: number };
  /** What a screen reader calls this cell: "Centre-left lens, Motion look". */
  label?: string;
  onClick?: () => void;
  onHover?: (over: boolean) => void;
  /** A one-word hint under the cell while it is hovered ("Start here."). */
  hint?: string | null;
}

/**
 * The front of KINO, drawn from the field-body geometry at one scale. The
 * slab, the raised lens bar, four cells nearly touching, the sliding cover
 * with the wordmark on it, the identity line where the serial is engraved.
 * Nothing else: no texture, no shutter, no shading.
 *
 * The cells are the interface. Their outline, rings, hover, focus and
 * accessible names live on HTML overlays so they behave like buttons; the
 * SVG underneath only holds the photographs and the ink.
 */
export function KinoFront({
  pxPerMm,
  pitchMm,
  cover,
  cells,
  identity,
  showUsb = false,
  faint = false,
  reduced = false,
  children,
}: {
  pxPerMm: number;
  pitchMm?: number;
  cover: 'open' | 'closed';
  /** Four cells, or null to draw the cells as paper with bores. */
  cells: CellSpec[] | null;
  identity?: string | null;
  showUsb?: boolean;
  faint?: boolean;
  /** Reduced motion: the cover cuts between positions. */
  reduced?: boolean;
  /** Extra HTML positioned against the body (a leader, a hint). */
  children?: ReactNode;
}) {
  const id = useId();
  const g = useMemo(() => bodyGeometry(pxPerMm, pitchMm), [pxPerMm, pitchMm]);
  const markPath = useMemo(() => markPathFor(g), [g]);
  const coverPos = cover === 'open' ? g.cover.open : g.cover.closed;
  const interactive = cells?.some((c) => c.onClick) ?? false;

  return (
    <div className={`c-front${faint ? ' is-faint' : ''}`} style={{ width: g.w, height: g.h }}>
      <svg
        className="c-front-svg"
        width={g.w}
        height={g.h}
        viewBox={`0 0 ${g.w} ${g.h}`}
        aria-hidden={interactive ? true : undefined}
        role={interactive ? undefined : 'img'}
        aria-label={interactive ? undefined : 'The front of KINO: four lenses in a row on a raised bar, the cover below them'}
      >
        <defs>
          {g.cellXs.map((cx, i) => (
            <clipPath key={i} id={`${id}-cell-${i}`}>
              <circle cx={cx} cy={g.cellY} r={g.cellD / 2 - 0.6} />
            </clipPath>
          ))}
        </defs>
        <rect className="c-front-slab" x={0.625} y={0.625} width={g.w - 1.25} height={g.h - 1.25} rx={g.cornerRadius} />
        <rect className="c-front-bar" x={g.bar.x} y={g.bar.y} width={g.bar.w} height={g.bar.h} rx={g.bar.radius} />
        {cover === 'open' || cells !== null
          ? g.cellXs.map((cx, i) => {
              const cell = cells?.[i];
              return cell?.url ? (
                <image
                  key={i}
                  href={cell.url}
                  x={cx - g.cellD / 2 + (cell.nudge?.x ?? 0)}
                  y={g.cellY - g.cellD / 2 + (cell.nudge?.y ?? 0)}
                  width={g.cellD}
                  height={g.cellD}
                  preserveAspectRatio="xMidYMid slice"
                  clipPath={`url(#${id}-cell-${i})`}
                  style={{ filter: cell.filter ?? 'none' }}
                />
              ) : (
                <circle key={i} className="c-front-bore" cx={cx} cy={g.cellY} r={g.boreD / 2} />
              );
            })
          : null}
        <g
          className={`c-front-cover${reduced ? ' is-cut' : ''}`}
          style={{ transform: `translate(${coverPos.x}px, ${coverPos.y}px)` }}
        >
          <rect x={0.5} y={0.5} width={coverPos.w - 1} height={coverPos.h - 1} rx={g.cover.radius} />
          <path className="c-front-mark" d={markPath} transform={`translate(${(coverPos.w - g.mark.w) / 2} ${(coverPos.h - g.mark.h) / 2 - g.ridge.h})`} />
          <rect
            className="c-front-ridge"
            x={(coverPos.w - g.ridge.w) / 2}
            y={coverPos.h - g.ridge.h * 1.8}
            width={g.ridge.w}
            height={g.ridge.h}
          />
        </g>
        {identity ? (
          <text className="c-front-identity" x={g.w / 2} y={g.serialY} textAnchor="middle" fontSize={pxPerMm >= 4 ? 14 : 12}>
            {identity}
          </text>
        ) : null}
        {showUsb ? (
          // Field-body port position; the production location is provisional.
          <rect className="c-front-usb" x={g.usb.x - g.usb.w / 2} y={g.h - 2} width={g.usb.w} height={4} />
        ) : null}
      </svg>
      {cover === 'open' && cells !== null ? (
        <div className="c-front-cells">
          {g.cellXs.map((cx, i) => (
            <CellOverlay key={i} index={i} cell={cells[i]} geometry={g} cx={cx} />
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function CellOverlay({ index, cell, geometry: g, cx }: { index: number; cell: CellSpec | undefined; geometry: BodyGeometry; cx: number }) {
  const ring = cell?.ring ?? 'none';
  const style = { left: cx - g.cellD / 2, top: g.cellY - g.cellD / 2, width: g.cellD, height: g.cellD };
  const className = `c-cell is-${ring}`;
  const label = cell?.label ?? `${LENS_POSITIONS[index]} lens`;
  if (!cell?.onClick) {
    return <div className={className} style={style} aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      className={className}
      style={style}
      aria-label={label}
      onClick={cell.onClick}
      onMouseEnter={() => cell.onHover?.(true)}
      onMouseLeave={() => cell.onHover?.(false)}
      onFocus={() => cell.onHover?.(true)}
      onBlur={() => cell.onHover?.(false)}
    >
      {cell.hint ? <span className="c-cell-hint">{cell.hint}</span> : null}
    </button>
  );
}

/** The wordmark's outlines as one SVG path, scaled to the drawing. Y is flipped once here. */
function markPathFor(g: BodyGeometry): string {
  const s = g.pxPerMm;
  return KINO_MARK_POLYGONS.map(
    (poly) =>
      poly
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${(x * s).toFixed(2)} ${((KINO_MARK_HEIGHT_MM - y) * s).toFixed(2)}`)
        .join(' ') + ' Z',
  ).join(' ');
}
