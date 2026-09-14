// The device screen, drawn by the device's own firmware.
//
// firmware/p4/twin_ui builds the P4's ui.c to WebAssembly (kino-ui.wasm). This
// module loads it, steps its loop, feeds it the simulated camera's state, hands
// it the touch point, and plays the frames it presents onto one 800x480
// canvas that both the inspector panel and the 3D glass draw from. What the
// screens do comes back through host imports and lands on the mock device the
// same way a KDP command would - a shutter press runs the capture pipeline,
// a setting goes through the config store, a delete removes the capture.
//
// Nothing here draws a pixel of UI. When the module is not loaded (a build
// without the artifact, a browser without WebAssembly, the seconds before SIM
// READY) the consumers fall back to deviceUi.ts, which still knows how to draw
// POWER OFF and the boot ladder.
import type { CamId, KinoConfig } from '@kino/kdp';
import { CAM_IDS } from '@kino/kdp';
import type { MockKinoDevice, MockMediaStore, TwinTelemetry } from '@kino/test-fixtures';
import { profileById } from '@kino/test-fixtures';
import { getTwinRuntime, useSimStore } from '../state/simStore';
import { useRollBridge } from '../roll/bridge';
import { getDisplayPreview } from '../scene/displayPreview';
import { DISPLAY_H, DISPLAY_W } from './deviceUi';
import {
  BUTTON,
  CAPTURE_STAGE,
  GALLERY_PAGE,
  GALLERY_TILE_H,
  GALLERY_TILE_W,
  NET_REASON,
  NET_STATE,
  POWER_STAGE,
  SD_CAPACITY_BYTES,
  SERVER,
  TILE,
  VF_H,
  VF_W,
  dottedPatch,
  flattenConfig,
  leafValue,
  rgbaToRgb565,
} from './firmwareUiState';

/** The exports of kino-ui.wasm this module calls. Pointers are numbers. */
interface Kui {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  kui_init(): number;
  kui_boot(nowMs: number): void;
  kui_pass(nowMs: number, down: number, lx: number, ly: number): number;
  kui_pass_elapsed_ms(): number;
  kui_canvas(): number;
  kui_frame_count(): number;
  kui_frame_ptr(i: number): number;
  kui_frame_at_ms(i: number): number;
  kui_rgba(src: number): number;
  kui_screen(): number;
  kui_version(): number;
  kui_icons_placeholder(): number;
  kui_scratch(i: number): number;
  kui_scratch_cap(): number;
  kui_button(id: number, longPress: number): void;
  kui_set_audio_ready(ready: number): void;
  kui_cfg_clear(): void;
  kui_cfg_set(key: number, val: number): void;
  kui_set_serial(s: number): void;
  kui_looks_clear(): void;
  kui_look_add(id: number, name: number): void;
  kui_sounds_clear(): void;
  kui_sound_add(id: number, name: number): void;
  kui_vf_ptr(cam: number): number;
  kui_set_vf_dead(mask: number): void;
  kui_vf_wanted(): number;
  kui_set_capture_stage(stage: number): void;
  kui_set_capture_count(n: number): void;
  kui_set_capture_report(ok: number, id: number, stored: number, online: number, bytes: number, totalMs: number, err: number): void;
  kui_gallery_set(total: number, page: number, pages: number, loading: number): void;
  kui_gallery_deleting(deleting: number, done: number, total: number): void;
  kui_gallery_slot(i: number, id: number, label: number, mode: number, frames: number, partial: number, favorite: number, state: number): void;
  kui_gallery_tile_ptr(i: number): number;
  kui_photo_frame_ptr(i: number, gen: number): number;
  kui_photo_frames_done(gen: number, have: number): void;
  kui_set_power(stage: number, idleS: number, displayOn: number, camBankOn: number, usb: number): void;
  kui_set_cam(cam: number, online: number, fw: number, sensor: number, tempC: number, latencyMs: number): void;
  kui_set_storage(present: number, mounted: number, capacity: number, free: number, lastError: number): void;
  kui_set_net(state: number, reason: number, routed: number, ssid: number, ip: number, rssi: number, channel: number, saved: number): void;
  kui_set_roll(active: number, rollId: number, slug: number, guestUrl: number, name: number, role: number, joinedAtMs: number): void;
  kui_set_queue(pending: number, uploading: number, failed: number, uploaded: number, scanComplete: number, draining: number, halted: number, server: number, lastUploadMs: number, burstDone: number, lastError: number): void;
}

export type FirmwareUiVariant = 'placeholder' | 'w98';

interface Compiled {
  module: WebAssembly.Module;
  variant: FirmwareUiVariant;
}

/** How often the viewfinder panes are refreshed from the virtual sensor while SHOOT is up. */
const VF_REFRESH_MS = 120;
/** The temperature a node reports when it has none: CAMLINK_TEMP_UNKNOWN. */
const TEMP_UNKNOWN = -2147483648;
const CAMLINK_TEMP_C = 36;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Find the module. The private variant with the real menu artwork lives in
 * public/ (gitignored, `npm run twin:ui:bake -- --w98`) and wins when present;
 * the committed build with placeholder tiles is bundled with the app.
 */
async function compileModule(): Promise<Compiled | null> {
  if (typeof WebAssembly === 'undefined' || typeof fetch === 'undefined') return null;
  const candidates: [URL, FirmwareUiVariant][] = [];
  try {
    const base = (import.meta.env?.BASE_URL as string | undefined) ?? './';
    candidates.push([new URL('kino-ui.w98.wasm', new URL(base, window.location.href)), 'w98']);
  } catch {
    /* no window: nothing to prefer */
  }
  candidates.push([new URL('./firmware/kino-ui.wasm', import.meta.url), 'placeholder']);
  for (const [url, variant] of candidates) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const type = response.headers.get('content-type') ?? '';
      const module =
        type.includes('application/wasm') && typeof WebAssembly.compileStreaming === 'function'
          ? await WebAssembly.compileStreaming(response)
          : await WebAssembly.compile(await response.arrayBuffer());
      return { module, variant };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

interface QueuedFrame {
  atMs: number;
  image: ImageData;
}

export class FirmwareUi {
  /** The latest presented frame, 800x480. Consumers drawImage() it. */
  readonly screen: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private compiled: Compiled | null | undefined;
  private compiling: Promise<Compiled | null> | null = null;
  private x: Kui | null = null;
  private running = false;
  private passTimer: ReturnType<typeof setTimeout> | null = null;
  private frameTimers: ReturnType<typeof setTimeout>[] = [];
  private inPass = false;
  private touch = { down: false, x: 0, y: 0 };
  private touchSeen = true;
  private listeners = new Set<() => void>();
  private statusListeners = new Set<() => void>();
  private unsubscribeTelemetry: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private galleryPage = 1;
  private galleryGen = 0;
  private galleryIds = '';
  private lastVfMs = 0;
  private captureCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  version: string | null = null;
  variant: FirmwareUiVariant | null = null;

  constructor() {
    this.screen = document.createElement('canvas');
    this.screen.width = DISPLAY_W;
    this.screen.height = DISPLAY_H;
    this.ctx = this.screen.getContext('2d');
    this.unsubscribeStore = useSimStore.subscribe((state, prev) => {
      if (state.bootStage === 'READY' && prev.bootStage !== 'READY') void this.start();
      if (!state.running && prev.running) this.stop();
    });
    if (useSimStore.getState().bootStage === 'READY') void this.start();
  }

  /** True while the firmware screen is what the display shows. */
  available(): boolean {
    return this.running && this.x !== null;
  }

  /** A new frame was presented; redraw whatever shows `screen`. */
  onFrame(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The module came up or went away. */
  onStatus(cb: () => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /** The touch panel, in logical landscape pixels. */
  setTouch(down: boolean, x: number, y: number): void {
    const changed = down !== this.touch.down || (down && (x !== this.touch.x || y !== this.touch.y));
    // ui.c paints a press on the pass that sees the finger and acts on the
    // pass that sees it lift. A finger is down for many passes; a click
    // dispatched by a test or a trackpad tap can land its down and its up
    // in one task, before any pass ran. Run the press pass now, so the lift
    // has something to release.
    if (!down && this.touch.down && !this.touchSeen && this.running && !this.inPass) this.runPass();
    if (down && !this.touch.down) this.touchSeen = false;
    this.touch = { down, x, y };
    // A press or a lift is acted on at the next pass; do not make a finger
    // wait out the 60 ms the SHOOT screen sleeps between frames.
    if (changed && this.running && !this.inPass) this.kick();
  }

  /** A physical key: BUTTON.SHUTTER or BUTTON.FN, as the buttons task reports it. */
  button(id: number, longPress = false): void {
    if (!this.x || !this.running) return;
    this.x.kui_button(id, longPress ? 1 : 0);
    if (!this.inPass) this.kick();
  }

  private notifyStatus(): void {
    for (const cb of this.statusListeners) cb();
  }

  private async ensureCompiled(): Promise<Compiled | null> {
    if (this.compiled !== undefined) return this.compiled;
    if (!this.compiling) this.compiling = compileModule();
    this.compiled = await this.compiling;
    return this.compiled;
  }

  /** Bring the screen up: instantiate, feed the state, run the boot. */
  async start(): Promise<void> {
    if (this.running) return;
    const compiled = await this.ensureCompiled();
    if (!compiled) return;
    if (useSimStore.getState().bootStage !== 'READY' || this.running) return;
    const instance = await WebAssembly.instantiate(compiled.module, {
      env: this.imports(),
      wasi_snapshot_preview1: this.wasi(),
    });
    const x = instance.exports as unknown as Kui;
    x._initialize?.();
    if (x.kui_init() !== 0) return;
    this.x = x;
    this.variant = compiled.variant;
    this.version = this.cstr(x.kui_version());
    this.running = true;
    this.galleryPage = 1;
    this.galleryIds = '';
    this.touch = { down: false, x: 0, y: 0 };
    this.subscribeTelemetry();
    this.syncState();
    void this.refreshGallery();
    const now = performance.now();
    x.kui_boot(now);
    const last = this.playFrames(now);
    this.passTimer = setTimeout(() => void this.runPass(), Math.max(1, last - (performance.now() - now)));
    this.notifyStatus();
  }

  /** Take the screen down: the module goes with the boot it belonged to. */
  stop(): void {
    if (this.passTimer) clearTimeout(this.passTimer);
    this.passTimer = null;
    for (const t of this.frameTimers) clearTimeout(t);
    this.frameTimers = [];
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.unsubscribeTelemetry?.();
    this.unsubscribeTelemetry = null;
    const was = this.running;
    this.running = false;
    this.x = null;
    if (was) this.notifyStatus();
  }

  dispose(): void {
    this.stop();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }

  private kick(): void {
    if (this.passTimer) clearTimeout(this.passTimer);
    this.passTimer = setTimeout(() => void this.runPass(), 0);
  }

  private runPass(): void {
    const x = this.x;
    if (!x || !this.running) return;
    this.inPass = true;
    try {
      this.syncState();
      const now = performance.now();
      const delay = x.kui_pass(now, this.touch.down ? 1 : 0, this.touch.x, this.touch.y);
      this.touchSeen = true;
      const last = this.playFrames(now);
      const elapsed = x.kui_pass_elapsed_ms();
      const due = Math.max(last, elapsed) + delay;
      this.passTimer = setTimeout(() => void this.runPass(), Math.max(1, due - (performance.now() - now)));
    } finally {
      this.inPass = false;
    }
  }

  /**
   * Draw the frames the pass presented, each at its virtual time relative to
   * `base`. Returns the last frame's offset. The ring is reused by the next
   * pass, so every frame is copied out now and drawn later.
   */
  private playFrames(base: number): number {
    const x = this.x;
    const ctx = this.ctx;
    if (!x || !ctx) return 0;
    const n = x.kui_frame_count();
    let last = 0;
    const queue: QueuedFrame[] = [];
    for (let i = 0; i < n; i++) {
      const at = x.kui_frame_at_ms(i);
      last = at;
      const ptr = x.kui_rgba(x.kui_frame_ptr(i));
      const rgba = new Uint8ClampedArray(x.memory.buffer, ptr, DISPLAY_W * DISPLAY_H * 4);
      queue.push({ atMs: at, image: new ImageData(new Uint8ClampedArray(rgba), DISPLAY_W, DISPLAY_H) });
    }
    for (const frame of queue) {
      const wait = frame.atMs - (performance.now() - base);
      const draw = () => {
        ctx.putImageData(frame.image, 0, 0);
        for (const cb of this.listeners) cb();
      };
      if (wait <= 0) draw();
      else this.frameTimers.push(setTimeout(draw, wait));
    }
    if (this.frameTimers.length > 64) this.frameTimers = this.frameTimers.slice(-32);
    return last;
  }

  // ---- strings across the boundary ----

  private str(slot: number, s: string): number {
    const x = this.x!;
    const ptr = x.kui_scratch(slot);
    const cap = x.kui_scratch_cap();
    const bytes = encoder.encode(s);
    const n = Math.min(bytes.length, cap - 1);
    const view = new Uint8Array(x.memory.buffer, ptr, cap);
    view.set(bytes.subarray(0, n));
    view[n] = 0;
    return ptr;
  }

  private cstr(ptr: number): string {
    const x = this.x;
    if (!x || !ptr) return '';
    const mem = new Uint8Array(x.memory.buffer);
    let end = ptr;
    while (mem[end] !== 0) end++;
    return decoder.decode(mem.subarray(ptr, end));
  }

  private device(): MockKinoDevice {
    return getTwinRuntime().sim.device;
  }

  private media(): MockMediaStore {
    return this.device().mediaStore();
  }

  // ---- the state the screens read ----

  private syncState(): void {
    const x = this.x;
    if (!x) return;
    const sim = useSimStore.getState();
    const snapshot = sim.snapshot;
    const device = this.device();

    x.kui_cfg_clear();
    for (const [k, v] of flattenConfig(device.readConfig())) x.kui_cfg_set(this.str(0, k), this.str(1, v));

    x.kui_looks_clear();
    for (const look of device.recipesForBody()) x.kui_look_add(this.str(0, look.id), this.str(1, look.name));
    x.kui_sounds_clear();
    for (const clip of device.soundsForBody()) x.kui_sound_add(this.str(0, clip.id), this.str(1, clip.name));

    x.kui_set_serial(this.str(0, 'KD4-SIM-0001'));
    x.kui_set_power(POWER_STAGE.AWAKE, 0, 1, 1, sim.studioConnected ? 1 : 0);
    x.kui_set_audio_ready(1);
    x.kui_set_capture_count(this.captureCount);

    const profile = profileById(snapshot?.firmwareProfile);
    let dead = 0;
    CAM_IDS.forEach((id: CamId, index) => {
      const cam = snapshot?.cams[id];
      const online = !!snapshot && (cam?.fault ?? null) !== 'offline' && cam?.fault !== 'power-open';
      if (!online) dead |= 1 << index;
      x.kui_set_cam(index, online ? 1 : 0, this.str(0, cam?.fw ?? ''), this.str(1, online ? 'OV3660' : ''),
                    online ? CAMLINK_TEMP_C : TEMP_UNKNOWN, online ? 4 : 0);
    });
    x.kui_set_vf_dead(dead);

    const sdPresent = snapshot?.sdPresent ?? true;
    x.kui_set_storage(sdPresent ? 1 : 0, sdPresent ? 1 : 0, SD_CAPACITY_BYTES,
                      (snapshot?.sdFreeMB ?? 0) * 1024 * 1024, this.str(0, ''));

    // The radio: the honest profiles have no route to the C6 (network:false),
    // which is exactly what the CONNECTION screen has a state for.
    const radio = profile?.capabilities?.network !== false;
    if (!radio) {
      x.kui_set_net(NET_STATE.C6_NOT_ROUTED, NET_REASON.TRANSPORT_UNKNOWN, 0, this.str(0, ''), this.str(1, ''), 0, 0, 0);
    } else if (snapshot?.wifi === 'connected') {
      x.kui_set_net(NET_STATE.IP_READY, NET_REASON.NONE, 1, this.str(0, 'KINO-BENCH'), this.str(1, '192.168.1.74'), -57, 6, 1);
    } else {
      x.kui_set_net(NET_STATE.WIFI_IDLE, NET_REASON.NONE, 1, this.str(0, ''), this.str(1, ''), 0, 0, 1);
    }

    const bridge = useRollBridge.getState();
    const joined = snapshot?.roll.joined ?? false;
    const roll = bridge.roll;
    x.kui_set_roll(joined || roll ? 1 : 0, this.str(0, roll?.rollId ?? ''), this.str(1, roll?.slug ?? ''),
                   this.str(2, roll?.guestUrl ?? ''), this.str(3, roll?.title ?? snapshot?.roll.name ?? ''), 0, Date.now());
    const uploads = snapshot?.uploads;
    x.kui_set_queue(uploads?.pending ?? bridge.queued, uploads?.uploading ?? (bridge.uploading ? 1 : 0),
                    uploads?.failed ?? bridge.failed, uploads?.uploaded ?? bridge.uploaded, 1,
                    (uploads?.uploading ?? 0) > 0 || bridge.uploading ? 1 : 0, 0,
                    roll ? (bridge.online ? SERVER.REACHABLE : SERVER.UNREACHABLE) : SERVER.UNKNOWN, 0, 0,
                    this.str(4, bridge.lastError ?? ''));

    this.syncViewfinder();
  }

  /** The SHOOT panes: the virtual sensor's preview, for every camera that is up. */
  private syncViewfinder(): void {
    const x = this.x;
    if (!x || !x.kui_vf_wanted()) return;
    const now = performance.now();
    if (now - this.lastVfMs < VF_REFRESH_MS) return;
    const preview = getDisplayPreview();
    if (!preview) return;
    const source = preview as HTMLCanvasElement;
    const ctx = source.getContext?.('2d');
    if (!ctx || source.width !== VF_W || source.height !== VF_H) return;
    this.lastVfMs = now;
    const rgba = ctx.getImageData(0, 0, VF_W, VF_H).data;
    for (let cam = 0; cam < 4; cam++) {
      const ptr = x.kui_vf_ptr(cam);
      rgbaToRgb565(rgba, new Uint16Array(x.memory.buffer, ptr, VF_W * VF_H));
    }
  }

  // ---- the gallery ----

  private async decodeInto(bytes: Uint8Array, w: number, h: number): Promise<Uint8ClampedArray | null> {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return ctx.getImageData(0, 0, w, h).data;
    } catch {
      return null;
    }
  }

  private async refreshGallery(): Promise<void> {
    const x = this.x;
    if (!x) return;
    const gen = ++this.galleryGen;
    const media = this.media();
    const all = media.list();
    const pages = Math.max(1, Math.ceil(all.length / GALLERY_PAGE));
    if (this.galleryPage > pages) this.galleryPage = pages;
    if (this.galleryPage < 1) this.galleryPage = 1;
    const page = all.slice((this.galleryPage - 1) * GALLERY_PAGE, this.galleryPage * GALLERY_PAGE);
    const ids = page.map((c) => `${c.id}:${c.favorite ? 1 : 0}`).join(',') + `#${all.length}`;
    const unchanged = ids === this.galleryIds;
    this.galleryIds = ids;
    x.kui_gallery_set(all.length, this.galleryPage, pages, unchanged ? 0 : 1);
    if (unchanged) return;
    for (let i = 0; i < GALLERY_PAGE; i++) {
      const c = page[i];
      if (!c) {
        x.kui_gallery_slot(i, this.str(0, ''), this.str(1, ''), this.str(2, ''), 0, 0, 0, TILE.EMPTY);
        continue;
      }
      x.kui_gallery_slot(i, this.str(0, c.id), this.str(1, c.id), this.str(2, c.kind), 4, 0, c.favorite ? 1 : 0, TILE.PENDING);
    }
    for (let i = 0; i < page.length; i++) {
      const c = page[i];
      const [thumb, info] = await Promise.all([media.thumb(c.id), media.info(c.id)]);
      if (gen !== this.galleryGen || this.x !== x) return;
      const frames = info?.files.length ?? 4;
      const partial = frames < 4 ? 1 : 0;
      const rgba = thumb ? await this.decodeInto(thumb, GALLERY_TILE_W, GALLERY_TILE_H) : null;
      if (gen !== this.galleryGen || this.x !== x) return;
      if (rgba) rgbaToRgb565(rgba, new Uint16Array(x.memory.buffer, x.kui_gallery_tile_ptr(i), GALLERY_TILE_W * GALLERY_TILE_H));
      x.kui_gallery_slot(i, this.str(0, c.id), this.str(1, c.id), this.str(2, c.kind), frames, partial,
                         c.favorite ? 1 : 0, rgba ? TILE.READY : TILE.NO_IMAGE);
    }
    x.kui_gallery_set(all.length, this.galleryPage, pages, 0);
    if (!this.inPass) this.kick();
  }

  private async provideFrames(id: string, w: number, h: number, gen: number): Promise<void> {
    const x = this.x;
    if (!x) return;
    const media = this.media();
    let have = 0;
    for (let cam = 0; cam < 4; cam++) {
      const bytes = await media.fileBytesByIndex(id, cam);
      if (this.x !== x) return;
      const ptr = x.kui_photo_frame_ptr(cam, gen);
      if (!ptr) return; // a newer request superseded this one
      const rgba = bytes ? await this.decodeInto(bytes, w, h) : null;
      if (this.x !== x) return;
      const again = x.kui_photo_frame_ptr(cam, gen);
      if (!again) return;
      if (rgba) {
        rgbaToRgb565(rgba, new Uint16Array(x.memory.buffer, again, w * h));
        have |= 1 << cam;
      }
    }
    x.kui_photo_frames_done(gen, have);
    if (!this.inPass) this.kick();
  }

  // ---- what the device does ----

  private subscribeTelemetry(): void {
    this.unsubscribeTelemetry?.();
    this.unsubscribeTelemetry = this.device().onTelemetry((e: TwinTelemetry) => {
      const x = this.x;
      if (!x) return;
      if (e.t === 'capture') {
        if (e.phase === 'begin') {
          x.kui_set_capture_stage(CAPTURE_STAGE.READING);
        } else {
          this.captureCount++;
          const cams = Object.values(e.cams);
          const bytes = cams.reduce((sum, c) => sum + (c?.jpegKB ?? 0) * 1024, 0);
          const totalMs = cams.reduce((max, c) => Math.max(max, c?.durationMs ?? 0), 0);
          const online = CAM_IDS.filter((id) => (useSimStore.getState().snapshot?.cams[id].fault ?? null) !== 'offline').length;
          x.kui_set_capture_report(1, this.str(0, e.capId ?? ''), cams.length, online, bytes, totalMs, this.str(1, ''));
          x.kui_set_capture_stage(CAPTURE_STAGE.DONE);
          setTimeout(() => void this.refreshGallery(), 50);
        }
        if (!this.inPass) this.kick();
      } else if (e.t === 'reboot') {
        // The device rebooted underneath the screen: the screen boots too.
        this.restartScreen();
      }
    });
  }

  private restartScreen(): void {
    if (this.restartTimer) return;
    this.stop();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (useSimStore.getState().bootStage === 'READY') void this.start();
    }, 400);
  }

  private imports(): WebAssembly.ModuleImports {
    const self = this;
    return {
      js_log(level: number, ptr: number, len: number) {
        const x = self.x;
        if (!x) return;
        const text = decoder.decode(new Uint8Array(x.memory.buffer, ptr, len));
        const tag = String.fromCharCode(level);
        if (tag === 'E') console.error(`[kino-ui] ${text}`);
        else if (tag === 'W') console.warn(`[kino-ui] ${text}`);
        else console.debug(`[kino-ui] ${tag} ${text}`);
      },
      js_capture_request(ptr: number): number {
        return self.device().requestCapture(self.cstr(ptr) || 'shutter') ? 1 : 0;
      },
      js_config_write(pathPtr: number, kind: number, num: number, strPtr: number) {
        const path = self.cstr(pathPtr);
        if (!path) return;
        self.device().applyConfigPatch(dottedPatch(path, leafValue(kind, num, self.cstr(strPtr))) as Partial<KinoConfig>);
      },
      js_config_save() {
        /* the mock's SAVE_CONFIG is a log line; the merge above already persisted for this boot */
      },
      js_restart() {
        self.device().requestReboot('body-restart');
        self.restartScreen();
      },
      js_delete_all() {
        const media = self.media();
        for (const c of media.list()) media.delete(c.id);
        self.galleryPage = 1;
        void self.refreshGallery();
      },
      js_capture_delete(ptr: number) {
        self.media().delete(self.cstr(ptr));
        void self.refreshGallery();
      },
      js_favorite_set(ptr: number, fav: number) {
        self.media().setFavorite(self.cstr(ptr), fav !== 0);
        void self.refreshGallery();
      },
      js_frames_request(ptr: number, w: number, h: number, gen: number) {
        void self.provideFrames(self.cstr(ptr), w, h, gen >>> 0);
      },
      js_gallery_turn(delta: number) {
        self.galleryPage += delta;
        void self.refreshGallery();
      },
      js_gallery_refresh() {
        void self.refreshGallery();
      },
      js_net(op: number, ptr: number): number {
        console.debug(`[kino-ui] radio op ${op} ${self.cstr(ptr)} - the Twin has no C6 route`);
        return 0;
      },
      js_queue_retry_all(): number {
        return 0;
      },
      js_audio(_kind: number) {
        /* the body's piezo; the Twin's soundscape is the SOUND panel's business */
      },
    };
  }

  /** wasi-libc asks for a clock and a place to write; it gets the host clock and /dev/null. */
  private wasi(): WebAssembly.ModuleImports {
    const self = this;
    return {
      clock_time_get(_id: number, _precision: bigint, out: number): number {
        const x = self.x;
        if (!x) return 0;
        new DataView(x.memory.buffer).setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
        return 0;
      },
      fd_write(_fd: number, _iovs: number, _len: number, nwritten: number): number {
        const x = self.x;
        if (x) new DataView(x.memory.buffer).setUint32(nwritten, 0, true);
        return 0;
      },
      fd_close(): number {
        return 0;
      },
      fd_seek(): number {
        return 0;
      },
      proc_exit(code: number): void {
        throw new Error(`kino-ui exited (${code})`);
      },
    };
  }
}

let singleton: FirmwareUi | null = null;

/** The one screen. Created on first use; the display consumers ask for it on mount. */
export function firmwareUi(): FirmwareUi {
  if (!singleton) singleton = new FirmwareUi();
  return singleton;
}

export { BUTTON };
