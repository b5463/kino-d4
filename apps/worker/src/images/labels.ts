/**
 * The `CAM1..CAMn` labels on a contact sheet, drawn from a bitmap font that
 * ships in this file.
 *
 * ## Why not SVG text
 *
 * The obvious way to put text on a sharp image is to composite an SVG `<text>`
 * element. That renders through librsvg → pango → **fontconfig**, which means
 * the label's existence, size and shape depend on which fonts the host happens
 * to have installed. A worker container without a font renders nothing at all;
 * a developer machine and CI render different glyph widths from the same code.
 * A contact sheet whose labels vanish on one deployment is not a cosmetic
 * problem — the labels are the only thing that says which cell is which camera.
 *
 * Thirteen glyphs is the entire requirement (`C`, `A`, `M`, `0`–`9`), so the
 * font is a 5×7 bitmap table, drawn into a raw RGBA buffer that sharp composites
 * like any other image. No system dependency, byte-identical output everywhere,
 * and the labels cannot silently disappear.
 *
 * The plate under the glyphs is not decoration: a white label over a blown-out
 * frame is invisible, and a contact sheet is exactly where a blown-out frame
 * turns up.
 */

/** Every glyph is 5 wide and 7 tall, `#` on and anything else off. */
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['#...#', '#...#', '#...#', '#####', '....#', '....#', '....#'],
  '5': ['#####', '#....', '#....', '####.', '....#', '....#', '####.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
};

/** Gap between two glyphs, in font pixels. */
const GLYPH_GAP = 1;

/** Border of plate around the text, in output pixels. */
const PLATE_PADDING = 5;

/**
 * The plate's opacity. High enough that a white frame behind it still leaves the
 * glyphs readable, low enough that it reads as a label and not a sticker.
 */
const PLATE_ALPHA = 200;

/** A raw RGBA image, in the shape sharp's `composite` takes as an input. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
}

/** How wide `text` will be drawn at `scale`, including the plate. */
export function labelWidth(text: string, scale: number): number {
  const glyphs = text.length;
  if (glyphs === 0) return 0;
  return PLATE_PADDING * 2 + scale * (glyphs * GLYPH_WIDTH + (glyphs - 1) * GLYPH_GAP);
}

/** How tall any label is at `scale`, including the plate. */
export function labelHeight(scale: number): number {
  return PLATE_PADDING * 2 + scale * GLYPH_HEIGHT;
}

/**
 * Draws `text` as white glyphs on a dark plate.
 *
 * A character with no glyph in the table is drawn as a blank cell rather than
 * throwing: the callers here only ever pass `CAM<n>`, and a label with a hole in
 * it is a better contact sheet than no contact sheet.
 */
export function renderLabel(text: string, scale: number): RawImage {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`label scale must be a positive integer, got ${String(scale)}`);
  }

  const width = labelWidth(text, scale);
  const height = labelHeight(scale);
  const data = Buffer.alloc(width * height * 4);

  // The plate first, over the whole buffer: every pixel that is not a glyph.
  for (let at = 0; at < data.length; at += 4) {
    data[at + 3] = PLATE_ALPHA;
  }

  for (const [index, character] of [...text].entries()) {
    const glyph = GLYPHS[character.toUpperCase()];
    if (glyph === undefined) continue;

    const originX = PLATE_PADDING + index * scale * (GLYPH_WIDTH + GLYPH_GAP);
    for (const [row, bits] of glyph.entries()) {
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if (bits[column] !== '#') continue;
        paint(
          data,
          width,
          originX + column * scale,
          PLATE_PADDING + row * scale,
          scale,
        );
      }
    }
  }

  return { data, width, height, channels: 4 };
}

/** One opaque white font pixel, `scale` × `scale` output pixels. */
function paint(data: Buffer, width: number, left: number, top: number, scale: number): void {
  for (let y = top; y < top + scale; y += 1) {
    for (let x = left; x < left + scale; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = 255;
    }
  }
}
