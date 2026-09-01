// Computer→Studio photo import: open a folder of KINO frames that are already
// on this computer and inspect them with no camera attached. The layout read
// here is the one Gallery › TETHER writes (device/tether.ts) — one subfolder
// per capture, the camera's own JPEG names inside it, plus META.JSON holding
// `JSON.stringify(CaptureInfo)`. Nothing is uploaded and nothing is stored:
// the frames live in memory until the tab is closed.

import type { CaptureInfo, CaptureKind } from '@kino/kdp';

/** One JPEG exactly as it sits on disk. Object URLs are the caller's job. */
export interface LocalFrame {
  name: string;
  data: Uint8Array;
}

/**
 * What the inspector reads off a summary. A folder on disk cannot prove
 * resolution or total size, and without META.JSON it cannot prove when the
 * shutter fired either — so those are absent or explicitly null here.
 * `CaptureSummary` from the device satisfies this shape unchanged.
 */
export interface InspectorSummary {
  id: string;
  kind: CaptureKind;
  /** Epoch ms; null when nothing on disk records the capture time. */
  ts: number | null;
  favorite: boolean;
}

export interface LocalCapture {
  summary: InspectorSummary;
  /** Parsed META.JSON, or null when the folder carries none that survives
   * validation. Null makes the inspector print no capture metadata at all,
   * which is the only honest alternative to inventing rows. */
  info: CaptureInfo | null;
  frames: LocalFrame[];
  /** What the folder could not prove, one blunt line each. Empty when
   * META.JSON parsed and four frames were found. */
  warnings: string[];
}

export const CAPTURE_META = 'META.JSON';
const JPEG_NAME = /\.jpe?g$/i;
const EXPECTED_FRAMES = 4;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/**
 * `sha256` is optional here because it is optional on the wire: the firmware
 * that writes META.JSON omits the digest rather than hash four
 * multi-megabyte JPEGs (contract D20), so requiring it rejected the metadata
 * of every folder tethered off a real body and dropped the inspector to "no
 * META.JSON". A malformed digest is still a rejection — a wrong digest is
 * worse than none.
 */
function isCaptureFile(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!isStr(f.name) || !isNum(f.sizeBytes)) return false;
  return f.sha256 === undefined || (isStr(f.sha256) && /^[0-9a-f]{64}$/i.test(f.sha256));
}

function isExposure(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return isStr(e.cam) && isStr(e.shutter) && isNum(e.gain);
}

/**
 * Validate every field the inspector renders, not just the envelope: a
 * half-written META.JSON that passed a loose check would crash the metadata
 * table instead of falling back to "no metadata".
 */
export function parseCaptureMeta(text: string | null): CaptureInfo | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  /* A document may carry no `meta` block at all: the firmware attaches it
   * only when META.JSON parsed (contract D20). That is not an unreadable
   * document — the id, kind, timestamp and file list are still evidence, and
   * the metadata table prints a dash and the reason for the rows `meta`
   * would have filled. A `meta` that is present must still be complete;
   * half a block would crash those rows instead of skipping them. */
  if (c.meta !== undefined && (typeof c.meta !== 'object' || c.meta === null)) return null;
  const meta = (c.meta ?? {}) as Record<string, unknown>;
  const metaOk =
    c.meta === undefined ||
    (typeof meta.flash === 'boolean' &&
      isNum(meta.batteryV) &&
      isStr(meta.p4Firmware) &&
      isStrArray(meta.cameraFirmware) &&
      isNum(meta.gpioSkewUs) &&
      Array.isArray(meta.exposure) &&
      meta.exposure.every(isExposure));
  const ok =
    metaOk &&
    isStr(c.id) &&
    (c.kind === 'wiggle' || c.kind === 'quad') &&
    isNum(c.ts) &&
    isStrArray(c.recipeIds) &&
    typeof c.favorite === 'boolean' &&
    (c.resolution === '1600x1200' || c.resolution === '2048x1536') &&
    isNum(c.totalKB) &&
    Array.isArray(c.files) &&
    c.files.every(isCaptureFile);
  return ok ? (raw as CaptureInfo) : null;
}

/**
 * No META.JSON: the folder name is the only id there is, and the id prefix is
 * the only evidence of kind (WG_ / QD_, `CaptureSummary` in @kino/kdp).
 * Anything else reads as a quad set — four stills side by side claim nothing
 * about viewpoint order, which wiggle playback would.
 */
function synthesiseSummary(dirName: string): InspectorSummary {
  const id = dirName.trim() || 'IMPORTED';
  return { id, kind: /^wg[_-]/i.test(id) ? 'wiggle' : 'quad', ts: null, favorite: false };
}

function orderFrames(jpegs: LocalFrame[], info: CaptureInfo | null): LocalFrame[] {
  const byName = [...jpegs].sort((a, b) => a.name.localeCompare(b.name));
  if (info === null) return byName;
  // META.JSON lists the files in CAM order; a directory listing is in whatever
  // order the filesystem hands back.
  const rest = new Map(byName.map((f) => [f.name, f]));
  const ordered: LocalFrame[] = [];
  for (const want of info.files) {
    const hit = rest.get(want.name);
    if (hit) {
      ordered.push(hit);
      rest.delete(want.name);
    }
  }
  return [...ordered, ...rest.values()];
}

/** Pure half of the import: bytes already read, no File System Access API. */
export function parseLocalCapture(
  dirName: string,
  files: LocalFrame[],
  metaJson: string | null,
): LocalCapture {
  const info = parseCaptureMeta(metaJson);
  const frames = orderFrames(
    files.filter((f) => JPEG_NAME.test(f.name)),
    info,
  );
  const warnings: string[] = [];
  if (metaJson === null) warnings.push('NO META.JSON — TIME, LOOKS AND EXPOSURE UNKNOWN');
  else if (info === null) warnings.push('META.JSON UNREADABLE — TIME, LOOKS AND EXPOSURE UNKNOWN');
  else if (info.meta === undefined) warnings.push('META.JSON CARRIES NO CAPTURE BLOCK — EXPOSURE, SKEW AND BATTERY UNKNOWN');
  if (frames.length !== EXPECTED_FRAMES) {
    warnings.push(`${frames.length} JPEG${frames.length === 1 ? '' : 'S'} IN FOLDER — A CAPTURE HAS ${EXPECTED_FRAMES}`);
  }
  if (info !== null && info.files.length !== frames.length) {
    warnings.push(`META.JSON LISTS ${info.files.length} FILES, FOLDER HOLDS ${frames.length}`);
  }
  return {
    summary:
      info !== null
        ? { id: info.id, kind: info.kind, ts: info.ts, favorite: info.favorite }
        : synthesiseSummary(dirName),
    info,
    frames,
    warnings,
  };
}

export function localImportSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

async function readCaptureDir(dir: FileSystemDirectoryHandle): Promise<LocalCapture> {
  const files: LocalFrame[] = [];
  let metaJson: string | null = null;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    if (name.toUpperCase() === CAPTURE_META) metaJson = await file.text();
    else if (JPEG_NAME.test(name)) files.push({ name, data: new Uint8Array(await file.arrayBuffer()) });
  }
  return parseLocalCapture(dir.name, files, metaJson);
}

/**
 * The picked folder is either one capture or a folder of them — the tether
 * target holds one subfolder per capture. Loose JPEGs at the top level decide
 * which it is.
 */
export async function readImportRoot(dir: FileSystemDirectoryHandle): Promise<LocalCapture[]> {
  const subdirs: FileSystemDirectoryHandle[] = [];
  let loose = false;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') subdirs.push(handle as FileSystemDirectoryHandle);
    else if (JPEG_NAME.test(name)) loose = true;
  }
  if (loose || subdirs.length === 0) return [await readCaptureDir(dir)];
  const found: LocalCapture[] = [];
  for (const sub of subdirs) {
    const capture = await readCaptureDir(sub);
    if (capture.frames.length > 0) found.push(capture);
  }
  found.sort((a, b) => a.summary.id.localeCompare(b.summary.id));
  return found;
}

/** Returns null when the picker was dismissed. */
export async function pickLocalCaptures(): Promise<LocalCapture[] | null> {
  if (!localImportSupported()) throw new Error('This browser has no folder picker.');
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker({ id: 'kino-import', mode: 'read' });
  } catch {
    return null;
  }
  return readImportRoot(dir);
}
