// The front of KINO, in millimetres, and the one conversion to pixels.
//
// Every number here is read off the released field body, design 0.1.4
// (hardware/cad/KINO_FIELD_BODY/README.md and twin/field-body-twin-datums.json).
// That body is a measured-fit test fixture, not the production enclosure: the
// lens pitch and the lens row are what the camera is, the slab outline and
// the port position are what this fixture is. Anything the production
// enclosure changes lands in this file and every drawing follows.
//
// Frame: X across the front, camera 1 at low X; Y up from the bottom edge.
// The SVG frame is Y down, so `toPx` flips it once, here, and nowhere else.

/** Front envelope, mm. Measured on the mesh. */
export const BODY_W_MM = 131;
export const BODY_H_MM = 90;

/** Lens centres X, mm, left to right. Measured on the released front half. */
export const LENS_XS_MM: readonly [number, number, number, number] = [32.5, 54.5, 76.5, 98.5];
/** Lens row height from the bottom edge, mm. */
export const LENS_Y_MM = 43;
/** Pitch of the released bar, mm. docs/HARDWARE.md: adjustable 20–24, 22 default. */
export const LENS_PITCH_MM = 22;
/** Web between neighbouring cells, mm. Cell diameter = pitch − web. */
export const CELL_WEB_MM = 3.6;
/** Bore for the Ø7.0 barrel, mm. Drawn only where a cell holds no photograph. */
export const BORE_MM = 7.1;

/** Raised lens bar on the face shell. Y from the README; X derived, ±2 mm. */
export const BAR_MM = { x0: 16.1, x1: 114.9, y0: 3.9, y1: 60.7, radius: 2 } as const;

/** Sliding cover: plate size, the two rest positions, the travel. Measured. */
export const COVER_MM = {
  x0: 21.3,
  w: 89.4,
  h: 20.4,
  /** Bottom edge, open (shooting): below the lenses. */
  openY0: 11.4,
  /** Bottom edge, closed: over the lenses. */
  closedY0: 32.8,
  travel: 21.4,
  radius: 0.6,
} as const;

/** The wordmark on the cover and the thumb ridge below it, mm. README "The sliding lens cover". */
export const MARK_MM = { w: 80.0, h: 10.745 } as const;
export const RIDGE_MM = { w: 22, h: 1.6 } as const;

/** Engraved identity line on the face shell: centred, above the bar. */
export const SERIAL_Y_MM = 68;

/**
 * USB-C on the field body: a 14 mm slot on the bottom wall at X 40. The
 * production body has not fixed a port position, so this is drawn on No KINO
 * only, faintly, as "roughly here" rather than as geometry.
 */
export const USB_MM = { x: 40, w: 14 } as const;

/** Plan-corner radius of the slab. Provisional: the README states R3 on the edge profile only. */
export const CORNER_RADIUS_MM = 8;

/** Cell diameter for a pitch: the dished opening, not the barrel. */
export function cellDiameterMm(pitchMm = LENS_PITCH_MM): number {
  return pitchMm - CELL_WEB_MM;
}

/** Lens centres for a pitch other than the released one, kept centred on the body. */
export function lensCentresMm(pitchMm = LENS_PITCH_MM): [number, number, number, number] {
  if (pitchMm === LENS_PITCH_MM) return [...LENS_XS_MM];
  const mid = (LENS_XS_MM[0] + LENS_XS_MM[3]) / 2;
  return [mid - 1.5 * pitchMm, mid - 0.5 * pitchMm, mid + 0.5 * pitchMm, mid + 1.5 * pitchMm];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Everything the drawing needs, in pixels, for one scale and one pitch. */
export interface BodyGeometry {
  pxPerMm: number;
  w: number;
  h: number;
  cornerRadius: number;
  bar: Rect & { radius: number };
  /** Cell centres, x, left to right. */
  cellXs: [number, number, number, number];
  /** The lens axis, y from the body's top edge. */
  cellY: number;
  cellD: number;
  boreD: number;
  cover: { open: Rect; closed: Rect; travel: number; radius: number };
  mark: { w: number; h: number };
  ridge: { w: number; h: number };
  serialY: number;
  usb: { x: number; w: number };
}

/** Y up in mm → y down in px, from the body's top edge. */
function yPx(yMm: number, s: number): number {
  return (BODY_H_MM - yMm) * s;
}

export function bodyGeometry(pxPerMm: number, pitchMm = LENS_PITCH_MM): BodyGeometry {
  const s = pxPerMm;
  const xs = lensCentresMm(pitchMm).map((x) => x * s) as [number, number, number, number];
  const cover = (y0: number): Rect => ({
    x: COVER_MM.x0 * s,
    y: yPx(y0 + COVER_MM.h, s),
    w: COVER_MM.w * s,
    h: COVER_MM.h * s,
  });
  return {
    pxPerMm: s,
    w: BODY_W_MM * s,
    h: BODY_H_MM * s,
    cornerRadius: CORNER_RADIUS_MM * s,
    bar: {
      x: BAR_MM.x0 * s,
      y: yPx(BAR_MM.y1, s),
      w: (BAR_MM.x1 - BAR_MM.x0) * s,
      h: (BAR_MM.y1 - BAR_MM.y0) * s,
      radius: BAR_MM.radius * s,
    },
    cellXs: xs,
    cellY: yPx(LENS_Y_MM, s),
    cellD: cellDiameterMm(pitchMm) * s,
    boreD: BORE_MM * s,
    cover: { open: cover(COVER_MM.openY0), closed: cover(COVER_MM.closedY0), travel: COVER_MM.travel * s, radius: COVER_MM.radius * s },
    mark: { w: MARK_MM.w * s, h: MARK_MM.h * s },
    ridge: { w: RIDGE_MM.w * s, h: RIDGE_MM.h * s },
    serialY: yPx(SERIAL_Y_MM, s),
    usb: { x: USB_MM.x * s, w: USB_MM.w * s },
  };
}

/** The scale that fits the body into `widthPx`, never above `maxPxPerMm`. */
export function scaleToFit(widthPx: number, maxPxPerMm = 5.5): number {
  return Math.min(maxPxPerMm, Math.max(1, widthPx / BODY_W_MM));
}

/** The positions, in the customer's words, left to right. */
export const LENS_POSITIONS = ['Left', 'Centre-left', 'Centre-right', 'Right'] as const;

/** "the left lens", "the centre-left lens". */
export function lensPhrase(index: number): string {
  return `the ${(LENS_POSITIONS[index] ?? 'left').toLowerCase()} lens`;
}
