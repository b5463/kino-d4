// The reference device's screen, for the Screen group (#246): GET_SCREEN,
// SCREEN_PLATE, UI_TAP and UI_KEY, as firmware/p4/main/kdp_ui.c answers them.
//
// The pictures are plausible, not the camera's: flat RGB565 blocks where the
// real screens have their rows, card and header, so a host can page, decode
// and save an 800x480 image and see which screen it is on. The plate is the
// firmware's own layout (ui.c draw_plate()), because a panel photo is compared
// against it. Taps move between screens on the right-hand layout the bench
// walk (scripts/kino-ui-walk.mjs) uses, so the walk runs end to end against
// this device.

import { SCREEN_CHUNK_MAX, SCREEN_H, SCREEN_W } from '@kino/kdp';
import type { ScreenId, ScreenShotInfo, UiKey } from '@kino/kdp';

/** A move's length: GET_SCREEN answers BUSY this long after a screen change. */
export const MOCK_SCREEN_MOVE_MS = 300;
const BYTES = SCREEN_W * SCREEN_H * 2;

export type ScreenReply =
  | { kind: 'json'; body: unknown }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'error'; code: string; message: string };

const rgb = (r: number, g: number, b: number) => ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);

/* firmware/p4/main/ui_palette.h, generated from kino-device-palette.json. */
const K = {
  ground: rgb(0x08, 0x08, 0x0a),
  scrim: 0,
  surface: rgb(0x10, 0x10, 0x10),
  row: rgb(0x18, 0x18, 0x18),
  rule: rgb(0x28, 0x28, 0x28),
  off: rgb(0x30, 0x30, 0x30),
  edge: rgb(0x82, 0x80, 0x7b),
  ink: rgb(0xf1, 0xec, 0xe2),
  inkQuiet: rgb(0x8f, 0x8b, 0x85),
  accentInk: rgb(0x2a, 0x0e, 0x1c),
  fault: rgb(0xe5, 0x48, 0x4d),
  faultInk: rgb(0xf2, 0x6a, 0x60),
};
const COLOURS = [
  K.ground, K.scrim, K.surface, K.row, K.rule, K.off,
  K.edge, K.ink, K.inkQuiet, K.accentInk, K.fault, K.faultInk,
];
const LAUNCH = [
  rgb(0xf3, 0xa2, 0xc4), rgb(0xef, 0xa2, 0xc6), rgb(0xef, 0xa6, 0xce), rgb(0xef, 0xa2, 0xce),
  rgb(0xef, 0xa2, 0xd6), rgb(0xe7, 0xa6, 0xd6), rgb(0xe7, 0xa2, 0xd6), rgb(0xe7, 0xa6, 0xde),
];
const LAUNCH_DOWN = [
  rgb(0xc6, 0x7d, 0x9c), rgb(0xc6, 0x79, 0x9c), rgb(0xc6, 0x7d, 0xa5), rgb(0xc6, 0x79, 0xa5),
  rgb(0xc6, 0x7d, 0xad), rgb(0xbd, 0x7d, 0xad), rgb(0xbd, 0x79, 0xad), rgb(0xbd, 0x7d, 0xb5),
];

/** Where a screen goes back to: SCREEN_PARENT in ui.c. */
const PARENT: Record<ScreenId, ScreenId> = {
  menu: 'menu', shoot: 'menu', look: 'menu', gallery: 'menu', photo: 'gallery', roll: 'menu',
  settings: 'menu', display: 'settings', sound: 'settings', connection: 'settings',
  storage: 'settings', about: 'settings', status: 'settings', power: 'menu',
};
const MENU_ROWS: ScreenId[] = ['look', 'gallery', 'roll', 'settings', 'power'];
/* STATUS is the sixth row only while the body reports a condition
 * (settings_rows() in ui.c); a healthy body has five. */
const SETTINGS_ROWS: ScreenId[] = ['display', 'sound', 'connection', 'storage', 'about', 'status'];
const LIST_SCREENS = new Set<ScreenId>(['settings', 'display', 'sound', 'connection', 'storage', 'about', 'status', 'power', 'roll']);

/* The right-hand layout, from ui.c: HEAD_H 62, list rows from y 79 at 64 px,
 * the menu card on the hand side and five rows on the other. */
const HEAD_H = 62;
const LIST_TOP = 79;
const ROW_PITCH = 64;
const CARD_X = 396;
const MENU_ROW_Y0 = 16;
const MENU_ROW_PITCH = 91;

class Picture {
  readonly px = new Uint16Array(SCREEN_W * SCREEN_H);
  fill(x: number, y: number, w: number, h: number, c: number) {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(SCREEN_W, x + w), y1 = Math.min(SCREEN_H, y + h);
    for (let r = y0; r < y1; r++) this.px.fill(c, r * SCREEN_W + x0, r * SCREEN_W + x1);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(BYTES);
    for (let i = 0; i < this.px.length; i++) {
      out[i * 2] = this.px[i] & 0xff;
      out[i * 2 + 1] = this.px[i] >> 8;
    }
    return out;
  }
}

/** The plate, laid out as ui.c draw_plate() lays it out. */
function drawPlate(): Picture {
  const p = new Picture();
  p.fill(0, 0, SCREEN_W, SCREEN_H, K.scrim);
  for (let i = 0; i < 32; i++) {
    const v = Math.min(255, Math.round((i * 255) / 31));
    p.fill(i * 25, 0, 25, 80, rgb(v, v, v));
  }
  const cw = Math.floor(SCREEN_W / COLOURS.length);
  COLOURS.forEach((c, i) => p.fill(i * cw, 80, i === COLOURS.length - 1 ? SCREEN_W - i * cw : cw, 80, c));
  LAUNCH.forEach((c, i) => p.fill(i * 100, 160, 100, 40, c));
  LAUNCH_DOWN.forEach((c, i) => p.fill(i * 100, 200, 100, 40, c));
  for (let x = 0; x < SCREEN_W; x += 20) p.fill(x, 240, 1, 240, K.ink);
  p.fill(SCREEN_W - 1, 240, 1, 240, K.ink);
  for (let y = 240; y < SCREEN_H; y += 20) p.fill(0, y, SCREEN_W, 1, K.ink);
  p.fill(0, SCREEN_H - 1, SCREEN_W, 1, K.ink);
  return p;
}

function drawScreen(screen: ScreenId, settingsRows: number): Picture {
  const p = new Picture();
  p.fill(0, 0, SCREEN_W, SCREEN_H, K.ground);
  if (screen === 'menu') {
    p.fill(CARD_X, 16, SCREEN_W - 8 - CARD_X, SCREEN_H - 32, LAUNCH[0]);
    for (let i = 0; i < MENU_ROWS.length; i++) p.fill(8, MENU_ROW_Y0 + i * MENU_ROW_PITCH, 372, 84, K.row);
    return p;
  }
  if (screen === 'shoot') {
    for (let i = 0; i < 4; i++) {
      p.fill((i % 2) * 400 + 2, Math.floor(i / 2) * 214 + 2, 396, 210, rgb(0x30 + i * 16, 0x30 + i * 12, 0x38));
    }
    p.fill(0, SCREEN_H - 52, SCREEN_W, 52, K.surface);
    p.fill(700, 5, 64, 52, K.off);
    return p;
  }
  p.fill(0, 0, SCREEN_W, HEAD_H, K.surface);
  p.fill(0, HEAD_H, SCREEN_W, 1, K.rule);
  p.fill(720, 5, 64, 52, K.off);
  if (screen === 'settings') {
    for (let i = 0; i < settingsRows; i++) p.fill(16, LIST_TOP + i * ROW_PITCH, 768, 56, K.row);
  } else if (LIST_SCREENS.has(screen)) {
    for (let i = 0; i < 4; i++) p.fill(16, LIST_TOP + i * ROW_PITCH + 55, 768, 1, K.rule);
  } else if (screen === 'gallery') {
    for (let i = 0; i < 8; i++) p.fill(16 + (i % 4) * 193, 79 + Math.floor(i / 4) * 197, 189, 189, K.off);
  } else if (screen === 'look' || screen === 'photo') {
    p.fill(16, 79, 500, 380, K.off);
  }
  return p;
}

export class MockScreen {
  private screen: ScreenId = 'menu';
  private plate = false;
  /** Bumped by every redraw of the canvas; a page names the one it reads. */
  private gen = 1;
  private shotGen = 0;
  private shotBytes: Uint8Array | null = null;
  private movingUntil = 0;

  constructor(
    private readonly now: () => number,
    private readonly log: (msg: string) => void,
    /** Whether the device reports a condition, which adds the STATUS row. */
    private readonly hasConditions: () => boolean = () => false,
  ) {}

  private settingsRows(): number {
    return this.hasConditions() ? SETTINGS_ROWS.length : SETTINGS_ROWS.length - 1;
  }

  /** The screen the body is on, for tests and the Twin. */
  get current(): { screen: ScreenId; plate: boolean } {
    return { screen: this.screen, plate: this.plate };
  }

  private go(to: ScreenId) {
    if (to === this.screen) return;
    this.screen = to;
    this.gen++;
    this.movingUntil = this.now() + MOCK_SCREEN_MOVE_MS;
  }

  private setPlate(on: boolean) {
    if (on === this.plate) return;
    this.plate = on;
    this.gen++;
  }

  getScreen(req: { shot?: unknown; offset?: unknown; length?: unknown }): ScreenReply {
    if (this.now() < this.movingUntil) {
      return { kind: 'error', code: 'BUSY', message: 'The screen is moving. Ask again.' };
    }
    if (req.shot === undefined) {
      this.gen++;
      this.shotGen = this.gen;
      this.shotBytes = (this.plate ? drawPlate() : drawScreen(this.screen, this.settingsRows())).bytes();
      const info: ScreenShotInfo = {
        shot: this.shotGen,
        width: SCREEN_W,
        height: SCREEN_H,
        format: 'rgb565le',
        bytes: BYTES,
        chunkMax: SCREEN_CHUNK_MAX,
        screen: this.screen,
        plate: this.plate,
      };
      return { kind: 'json', body: info };
    }
    const shot = Number(req.shot);
    const offset = req.offset === undefined ? 0 : Number(req.offset);
    const length = req.length === undefined ? SCREEN_CHUNK_MAX : Number(req.length);
    if (!Number.isInteger(shot) || !Number.isInteger(offset) || !Number.isInteger(length)) {
      return { kind: 'error', code: 'INVALID_ARGUMENT', message: 'shot, offset and length must be whole numbers' };
    }
    if (this.shotBytes === null || shot !== this.shotGen || this.gen !== this.shotGen) {
      return { kind: 'error', code: 'INVALID_STATE', message: 'The screen changed. Ask again.' };
    }
    if (offset < 0 || offset > BYTES) {
      return { kind: 'error', code: 'INVALID_ARGUMENT', message: 'offset is past the end of the screen' };
    }
    /* As pure_screen_page(): absent or 0 (or less) is a full page. */
    const want = length <= 0 ? SCREEN_CHUNK_MAX : length;
    const len = Math.min(want, SCREEN_CHUNK_MAX, BYTES - offset);
    return { kind: 'bytes', bytes: this.shotBytes.slice(offset, offset + len) };
  }

  screenPlate(req: { on?: unknown }): ScreenReply {
    if (typeof req.on !== 'boolean') {
      return { kind: 'error', code: 'INVALID_ARGUMENT', message: 'Expected {"on": true|false}' };
    }
    this.setPlate(req.on);
    this.log(`screen plate ${req.on ? 'on' : 'off'}`);
    return { kind: 'json', body: { ok: true, on: req.on } };
  }

  uiTap(req: { x?: unknown; y?: unknown; holdMs?: unknown }): ScreenReply {
    const { x, y } = req;
    const hold = req.holdMs === undefined ? 80 : req.holdMs;
    if (!Number.isInteger(x) || !Number.isInteger(y) || (x as number) < 0 || (x as number) >= SCREEN_W ||
        (y as number) < 0 || (y as number) >= SCREEN_H) {
      return { kind: 'error', code: 'INVALID_ARGUMENT', message: 'x must be 0..799 and y 0..479' };
    }
    if (!Number.isInteger(hold) || (hold as number) < 20 || (hold as number) > 4000) {
      return { kind: 'error', code: 'INVALID_ARGUMENT', message: 'holdMs must be 20..4000' };
    }
    /* Acted on at once, so the four-deep queue never fills here: the
     * reference device has no UI loop to wait for, and the move window above
     * is what a host has to wait out. */
    this.log(`tap ${x},${y} held ${hold} ms`);
    if (this.plate) this.setPlate(false);
    else if ((hold as number) <= 2500) this.tap(x as number, y as number);
    return { kind: 'json', body: { ok: true, queued: 1 } };
  }

  uiKey(req: { key?: unknown; longPress?: unknown }): ScreenReply {
    const key = req.key;
    if (key !== 'shutter' && key !== 'fn') {
      return { kind: 'error', code: 'INVALID_ARGUMENT', message: 'key must be shutter or fn' };
    }
    if (req.longPress !== undefined && typeof req.longPress !== 'boolean') {
      return { kind: 'error', code: 'INVALID_ARGUMENT', message: 'longPress must be true or false' };
    }
    this.log(`${key} pressed`);
    if (this.plate) this.setPlate(false);
    else if (key === 'shutter' && this.screen !== 'shoot') this.go('shoot');
    return { kind: 'json', body: { ok: true, key: key as UiKey } };
  }

  private tap(x: number, y: number) {
    const s = this.screen;
    if (s === 'menu') {
      if (x >= CARD_X) return this.go('shoot');
      const row = Math.floor((y - MENU_ROW_Y0) / MENU_ROW_PITCH);
      if (row >= 0 && row < MENU_ROWS.length) this.go(MENU_ROWS[row]);
      return;
    }
    if (s === 'shoot') {
      if (y < HEAD_H && x >= 680) this.go('menu');
      return;
    }
    if (y < HEAD_H) return this.go(PARENT[s]);
    if (s === 'settings') {
      const row = Math.floor((y - LIST_TOP) / ROW_PITCH);
      if (row >= 0 && row < this.settingsRows()) this.go(SETTINGS_ROWS[row]);
    }
  }
}
