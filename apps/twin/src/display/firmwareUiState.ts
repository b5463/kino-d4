// The pure half of the firmware-UI bridge: how the simulator's documents map
// onto what ui.c's modules answer. Kept free of the DOM and of WebAssembly so
// it can be tested on its own (tests/firmwareUi.test.ts).

/**
 * The config document as dotted paths, which is how config_store.h is read:
 * `config_str("shoot.flashMode", ...)`, `config_int("body.autoDimS", ...)`.
 * Booleans become "true"/"false" and numbers their decimal form - the same
 * text a JSON store holds - so the harness's config_int()/config_bool() parse
 * them the way the firmware's do.
 */
export function flattenConfig(value: unknown, prefix = '', out: [string, string][] = []): [string, string][] {
  if (value === null || value === undefined) return out;
  if (typeof value !== 'object' || Array.isArray(value)) {
    out.push([prefix, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)]);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flattenConfig(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/**
 * The inverse, for one leaf: "shoot.flashMode" + "on" is the patch
 * `{ shoot: { flashMode: "on" } }` that SET_CONFIG would carry.
 */
export function dottedPatch(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.').filter(Boolean);
  const root: Record<string, unknown> = {};
  let cursor = root;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      cursor[key] = value;
    } else {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    }
  });
  return root;
}

/** What meta_patch_path() hands over: kind 0 string, 1 number, 2 bool. */
export function leafValue(kind: number, num: number, str: string): string | number | boolean {
  if (kind === 1) return num;
  if (kind === 2) return num !== 0;
  return str;
}

/** RGBA8888 pixels to the RGB565 a tile, a viewfinder pane or a frame is. */
export function rgbaToRgb565(rgba: Uint8ClampedArray | Uint8Array, out: Uint16Array): void {
  const n = Math.min(out.length, rgba.length >> 2);
  for (let i = 0, s = 0; i < n; i++, s += 4) {
    out[i] = ((rgba[s] & 0xf8) << 8) | ((rgba[s + 1] & 0xfc) << 3) | (rgba[s + 2] >> 3);
  }
}

/** net_state_t, the subset the Twin can be in. */
export const NET_STATE = { C6_NOT_ROUTED: 0, WIFI_IDLE: 5, IP_READY: 10 } as const;
/** net_reason_t. */
export const NET_REASON = { NONE: 0, TRANSPORT_UNKNOWN: 1 } as const;
/** capture_stage_t. */
export const CAPTURE_STAGE = { IDLE: 0, TRIGGERING: 1, READING: 2, WRITING: 3, DONE: 4 } as const;
/** tile_state_t. */
export const TILE = { EMPTY: 0, PENDING: 1, READY: 2, NO_IMAGE: 3 } as const;
/** power_stage_t. */
export const POWER_STAGE = { AWAKE: 0, DIM: 1, ASLEEP: 2 } as const;
/** upload_server_state_t. */
export const SERVER = { UNKNOWN: 0, REACHABLE: 1, UNREACHABLE: 2 } as const;
/** button_id_t. */
export const BUTTON = { SHUTTER: 0, FN: 1 } as const;

/** The gallery's page geometry, as gallery.h has it. */
export const GALLERY_PAGE = 6;
export const GALLERY_TILE_W = 252;
export const GALLERY_TILE_H = 189;
/** The viewfinder tile, as viewfinder.h has it. */
export const VF_W = 320;
export const VF_H = 240;

/** The card the simulated body carries: the same 32 GB part the bench has. */
export const SD_CAPACITY_BYTES = 31_914_983_424;
