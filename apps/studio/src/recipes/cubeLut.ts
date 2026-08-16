// Adobe `.cube` 3D LUT reader (02 §14).
//
// Studio accepts the format the grading apps export and checks it against
// what KINO can actually load: a 17×17×17 device LUT. A 33³ or 65³ cube is a
// perfectly valid file that this camera cannot hold, and saying so at import
// time is the whole point — the alternative is a look that silently does
// nothing on the card.
//
// Nothing here interpolates or resamples. Down-sampling a 33³ cube to 17³ is
// a colour decision, not a parsing one, and inventing it quietly would be
// worse than refusing the file.

/** Grid edge KINO's firmware is specified for (02 §14). */
export const DEVICE_LUT_SIZE = 17;

export interface CubeLut {
  /** `TITLE` from the file, if it carried one. */
  title: string | null;
  /** Grid edge — always `DEVICE_LUT_SIZE` for a LUT this parser returns. */
  size: number;
  /**
   * `size³` RGB triplets, red varying fastest, exactly as the file orders
   * them. Values are kept as written: `.cube` allows entries outside 0–1 and
   * clamping them here would quietly change the look.
   */
  data: Float32Array;
}

/** Everything this parser refuses says which line, and why, in one sentence. */
function fail(message: string): never {
  throw new Error(message);
}

/**
 * Parse a `.cube` file into a device LUT.
 *
 * Throws with a message meant for the import notice — `Error.message` is
 * printed to the user verbatim, so it names the file's size, not a code.
 */
export function parseCubeLut(text: string): CubeLut {
  const lines = text.split(/\r?\n/);

  let title: string | null = null;
  let size: number | null = null;
  const values: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].split('#')[0].trim();
    if (line === '') continue;

    const upper = line.toUpperCase();

    if (upper.startsWith('TITLE')) {
      const quoted = line.match(/"([^"]*)"/);
      title = quoted ? quoted[1] : line.slice(5).trim() || null;
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      fail('This is a 1D LUT (LUT_1D_SIZE). KINO takes a 3D cube — export LUT_3D_SIZE 17.');
    }
    if (upper.startsWith('LUT_3D_SIZE')) {
      const n = Number(line.slice('LUT_3D_SIZE'.length).trim());
      if (!Number.isInteger(n) || n < 2) fail(`LUT_3D_SIZE on line ${i + 1} is not a grid size`);
      size = n;
      continue;
    }
    // DOMAIN_MIN / DOMAIN_MAX and any other keyword are metadata this device
    // has no use for. Skipping them beats refusing a file over a header.
    if (/^[A-Z_]/.test(upper)) continue;

    const parts = line.split(/\s+/);
    if (parts.length !== 3) {
      fail(`Line ${i + 1} has ${parts.length} values; a cube row is three (R G B)`);
    }
    const rgb = parts.map(Number);
    if (rgb.some((v) => !Number.isFinite(v))) {
      fail(`Line ${i + 1} is not three numbers: "${line}"`);
    }
    values.push(rgb[0], rgb[1], rgb[2]);
  }

  if (size === null) fail('No LUT_3D_SIZE in this file — it is not a 3D .cube LUT');
  if (size !== DEVICE_LUT_SIZE) {
    fail(
      `This LUT is ${size}×${size}×${size}. KINO loads ${DEVICE_LUT_SIZE}×${DEVICE_LUT_SIZE}×${DEVICE_LUT_SIZE} ` +
        `cubes — re-export it at LUT_3D_SIZE ${DEVICE_LUT_SIZE}.`,
    );
  }

  const expected = size * size * size;
  const found = values.length / 3;
  if (found !== expected) {
    fail(`LUT_3D_SIZE ${size} needs ${expected} rows; this file has ${found}`);
  }

  return { title, size, data: Float32Array.from(values) };
}
