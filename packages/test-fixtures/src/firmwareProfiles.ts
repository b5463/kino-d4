// Firmware profiles for the reference device (issue #72).
//
// The mock has always been the demo of a finished KINO. Real firmware now
// exists, and honest emulation of it matters more than a lively demo: a
// Studio built against the demo device silently depends on commands the
// bench will NACK. A profile pins the mock to one firmware generation —
// versions, which cameras have live links, which capabilities are
// advertised, and which commands exist at all. The dispatcher and the
// capability report derive from the same profile, so they cannot drift.
import { Cmd } from '@kino/kdp';
import type { Capabilities } from '@kino/kdp';

/**
 * A profile's capability patch.
 *
 * The `Capabilities` half so a typo in a declared flag is a compile error;
 * `Record<string, boolean>` alongside it because a profile may also carry a
 * flag this build's `Capabilities` has not declared yet — `syncBench` is one
 * today. Both halves are needed: the plain record alone is what let `roll`
 * go missing from `M1B_CAPABILITIES` without anything noticing.
 *
 * `cameraCount` is omitted rather than made optional. It is the only
 * non-boolean member of `Capabilities`, so keeping it would give the
 * intersection a `number` under a `boolean` index signature and nothing would
 * assign — and a profile has no business setting it anyway: how many cameras
 * a body has is the mock's own report, not a firmware generation's claim.
 */
export type ProfileCapabilities = Partial<Omit<Capabilities, 'cameraCount'>> &
  Record<string, boolean>;

export type FirmwareProfileId =
  | 'd4-m1b'
  | 'd4-body-0-2'
  | 'd4-capture-0-3'
  | 'd4-roll-0-4'
  | 'd4-looks-0-4-8'
  | 'd4-settings-0-4-9'
  | 'd4-sim-full';

export interface FirmwareProfile {
  id: FirmwareProfileId;
  label: string;
  /** Brief §42: anything beyond the shipped firmware is a clearly labeled
   * simulated future, never presented as current firmware support. */
  simulatedFuture: boolean;
  p4Fw: string;
  camFw: string;
  /** CAM1..CAM4 — false reports the node offline, like an unwired UART. */
  camsOnline: [boolean, boolean, boolean, boolean];
  /** Merged over GET_CAPABILITIES.capabilities (last spread wins). Null
   * restores the mock's own derived capability report. */
  capabilities: ProfileCapabilities | null;
  maxUartBaud: number;
  /** Command ids this firmware implements; anything else answers
   * UNSUPPORTED_COMMAND. Null = the mock's full surface (demo device). */
  implementedCommands: readonly number[] | null;
}

/** The exact KDP surface of firmware/p4/main/kdp_server.c at 0.1.0 (M1B). */
export const M1B_COMMANDS: readonly number[] = [
  Cmd.HELLO,
  Cmd.GET_DEVICE_INFO,
  Cmd.GET_CAPABILITIES,
  Cmd.GET_STORAGE_STATUS,
  Cmd.GET_CAMERA_INFO,
  Cmd.CAMERA_STATUS,
  Cmd.CAMERA_TEST,
  Cmd.STORAGE_SELF_TEST,
  Cmd.CAMERA_LINK_STATS,
  Cmd.CAMERA_LINK_STATS_RESET,
  Cmd.CAMERA_SOAK_TEST,
  Cmd.GET_HW_VALIDATION,
  Cmd.GET_RUNTIME_STATS,
  Cmd.GET_LOGS,
  Cmd.CLEAR_LOGS,
  Cmd.SELF_TEST,
  Cmd.REBOOT,
];

const M1B_CAPABILITIES: ProfileCapabilities = {
  wiggle: false,
  quad: false,
  gallery: false,
  flashControl: false,
  vsyncTelemetry: false,
  phaseCalibration: false,
  xiaoProxyUpdate: false,
  linkBench: false,
  customSounds: false,
  recipes: false,
  autofocus: false,
  focusLock: false,
  manualFocus: false,
  /**
   * All three of the Network/Roll group, spelled out. `roll` was missing here
   * and inherited by every profile built on this one, so a Twin flashed with
   * 0.1.0..0.3.0 answered a capability report with no `roll` key at all —
   * which is the same thing a newer camera's unknown flag looks like on the
   * wire, and Studio's gate could not tell the two apart.
   */
  network: false,
  roll: false,
  rollUpload: false,
  syncBench: false,
  benchDiagnostics: true,
};

/**
 * The exact KDP surface of `firmware/p4/main/kdp_server.c` at 0.2.0.
 *
 * M1B plus the settings store, power status, shooting modes and the read side
 * of the gallery — the commands Studio and Twin were already calling against a
 * firmware that answered `UNSUPPORTED_COMMAND` to all of them.
 */
export const BODY_0_2_COMMANDS: readonly number[] = [
  ...M1B_COMMANDS,
  Cmd.GET_POWER_STATUS,
  Cmd.GET_CONFIG,
  Cmd.SET_CONFIG,
  Cmd.SAVE_CONFIG,
  Cmd.RESET_CONFIG,
  Cmd.GET_MODES,
  Cmd.SET_MODE,
  Cmd.MEDIA_LIST,
  Cmd.MEDIA_INFO,
  Cmd.MEDIA_DELETE,
  Cmd.MEDIA_FAVORITE,
];

const BODY_0_2_CAPABILITIES: ProfileCapabilities = {
  ...M1B_CAPABILITIES,
  configStore: true,
  /** Idle dim/sleep and camera-bank power-down are implemented. */
  powerManagement: true,
  /**
   * Battery telemetry is not, and cannot be on this body: no sense divider
   * reaches the P4 and the SW6106 carrier carries no gauge, so `batteryV` and
   * `batteryPct` are null. See firmware-contract D10.
   */
  powerTelemetry: false,
  /**
   * Listing, inspecting, deleting and favouriting captures work. `gallery`
   * stays false because MEDIA_READ and MEDIA_THUMB do not exist — a client
   * that needs pixels still cannot get them.
   */
  mediaIndex: true,
};

export const CAPTURE_0_3_COMMANDS: readonly number[] = [
  ...BODY_0_2_COMMANDS,
  Cmd.CAMERA_CAPTURE,
  Cmd.MEDIA_READ,
  Cmd.MEDIA_THUMB,
];

const CAPTURE_0_3_CAPABILITIES: ProfileCapabilities = {
  ...BODY_0_2_CAPABILITIES,
  /** MEDIA_READ and MEDIA_THUMB return bytes, so pixels can leave the camera. */
  gallery: true,
  /**
   * One press captures every online camera into one folder. Both modes use
   * the same four sensors and differ only in how a host presents the frames
   * it already has, so they are true together or not at all.
   */
  wiggle: true,
  quad: true,
  /** The flash window is held across the exposure. It drives no pin on D4 V1:
   * GPIO28 / JP1 21 went to the shutter under ECN-0003 and the flash becomes
   * an external module (BOARD_FLASH_EN is BOARD_GPIO_NONE) — a hardware fact,
   * not a firmware one. */
  flashControl: true,
  /**
   * Still false, and this is the one worth reading twice. The body pulses
   * SYNC_OUT (GPIO32, JP1 pin 19) on every capture and reports how far apart the four commands went
   * out, but the nodes expose on command arrival rather than on that edge,
   * and their rolling shutters free-run. All three skews in `kino.capture`
   * stay null with a reason. Dispatch spread is not exposure skew.
   */
  vsyncTelemetry: false,
};

export const ROLL_0_4_COMMANDS: readonly number[] = [
  ...CAPTURE_0_3_COMMANDS,
  /**
   * The whole network/Roll/upload surface answers, and most of it answers for
   * real — credentials persist, a Studio-resolved Roll is stored and shown as
   * a QR, and captures are queued durably on the card.
   *
   * Two of them refuse on this body rather than being absent, and the
   * distinction matters to a host: `ROLL_CREATE` and the slug-only form of
   * `ROLL_JOIN` are HTTP calls to the Roll API, and the P4 has no route to
   * its radio. They answer `NETWORK_UNAVAILABLE` naming the radio state,
   * which a host can act on, instead of `UNSUPPORTED_COMMAND`, which cannot
   * tell an unimplemented command from an unrouted chip.
   */
  Cmd.NETWORK_LIST,
  Cmd.NETWORK_SET,
  Cmd.NETWORK_DELETE,
  Cmd.NETWORK_STATUS,
  Cmd.ROLL_STATUS,
  Cmd.ROLL_CREATE,
  Cmd.ROLL_JOIN,
  Cmd.ROLL_LEAVE,
  Cmd.UPLOAD_QUEUE_STATUS,
  Cmd.UPLOAD_QUEUE_RETRY,
  Cmd.UPLOAD_ENQUEUE,
  /** Read-only version reporting for all six images, including the C6's.
   * The rest of the FW_* group stays absent: one `factory` partition, no OTA
   * slots, and a query is not an update path. */
  Cmd.FW_QUERY,
];

const ROLL_0_4_CAPABILITIES: ProfileCapabilities = {
  ...CAPTURE_0_3_CAPABILITIES,
  /**
   * The ESP32-C6 is on the Guition carrier. Reported separately from whether
   * the firmware can reach it, the same way `flashControl` is reported
   * separately from `flashHardware`: one boolean answering both is what
   * produced the old "NETWORK: NOT FITTED" display, which sent people looking
   * for a component that was already soldered on.
   */
  radioFitted: true,
  /**
   * False for THIS profile, which describes the default build. The radio is a
   * build-time opt-in, and a radio build answers true - the firmware reads
   * the flag from the same place NETWORK_STATUS does, so the two cannot
   * disagree again. The routing itself is measured now: slot 1 on GPIO14-19
   * enumerated the onboard C6 on 2026-08-29 (firmware/HARDWARE_VALIDATION.md).
   */
  radioRouted: false,
  /**
   * Still false with every command implemented, and deliberately so. Studio's
   * supports() gate is fail-closed, so setting these true makes it render the
   * Network and Roll pages and issue commands that must then refuse — a broken
   * panel instead of an absent one. They flip when the commands answer for
   * real, which needs the transport, not more firmware.
   */
  network: false,
  roll: false,
  rollUpload: false,
};

/**
 * The exact KDP surface of `firmware/p4/main/kdp_server.c` at 0.4.8.
 *
 * The two families Studio has been speaking to a NACK since it was written:
 * looks and sounds. Eleven factory looks are compiled into the image from
 * `firmware/p4/main/factory_recipes.json`, custom looks live on the card
 * under `/sdcard/KINO/RECIPES`, custom clips under `/sdcard/KINO/SOUNDS`,
 * and both survive a power cut because an upload is written to a temporary
 * file and renamed at the end.
 *
 * `SET_RECIPE` takes the optional `cam` field this firmware adds. It selects
 * a look and writes config; the camera still does no grading, and a look is
 * applied at import as it always has been.
 */
export const LOOKS_0_4_8_COMMANDS: readonly number[] = [
  ...ROLL_0_4_COMMANDS,
  Cmd.GET_RECIPES,
  Cmd.SET_RECIPE,
  Cmd.UPLOAD_RECIPE,
  Cmd.DELETE_RECIPE,
  Cmd.GET_SOUNDS,
  Cmd.SOUND_BEGIN,
  Cmd.SOUND_CHUNK,
  Cmd.SOUND_END,
  Cmd.SOUND_READ,
  Cmd.SOUND_DELETE,
];

const LOOKS_0_4_8_CAPABILITIES: ProfileCapabilities = {
  ...ROLL_0_4_CAPABILITIES,
  /**
   * Both flags are read off the same two functions the dispatcher gates on
   * (`kdp_recipes_capable()`, `kdp_sounds_capable()`), so the flag and the
   * handler cannot disagree the way D17 warned they would.
   */
  recipes: true,
  customSounds: true,
  /**
   * Unchanged, and worth saying out loud because looks invite the assumption:
   * `vsyncTelemetry` is still false, the network and Roll flags are still
   * false for want of a transport, and nothing here applies a look's capture
   * block to a sensor. Storing and selecting a look is not grading one.
   */
  vsyncTelemetry: false,
};

/**
 * 0.4.9 adds no KDP command. Everything it changes is behaviour behind
 * settings that were already on the wire — `previewQuality` reaches the
 * viewfinder, `displayAfterShotS` -1 holds, the warning tone plays, the body
 * can favourite a photograph, and per-camera exposure and gain reach the
 * sensor over the node link's own `NL_CMD_SENSOR`, which is not KDP.
 *
 * It gets a profile anyway, because a profile pins capabilities as well as
 * commands, and this firmware is the first to state one: `brightnessControl`.
 * Mapping 0.4.9 onto `d4-looks-0-4-8` would leave a Twin flashed with it
 * reporting no flag at all, and Studio reads a missing flag as "not a gate" —
 * the slider would stay live on a body that cannot dim.
 */
const SETTINGS_0_4_9_CAPABILITIES: ProfileCapabilities = {
  ...LOOKS_0_4_8_CAPABILITIES,
  /**
   * False, and it is hardware saying so: the Guition carrier drives the panel
   * backlight from a plain GPIO, so lit and dark are the only states
   * (firmware-contract D11). The firmware still stores and returns
   * `body.brightness` unchanged. Earlier profiles omit the flag rather than
   * setting it false — they describe firmware that never answered the
   * question, and absent is not the same claim as no.
   */
  brightnessControl: false,
};

export const FIRMWARE_PROFILES: Record<FirmwareProfileId, FirmwareProfile> = {
  'd4-m1b': {
    id: 'd4-m1b',
    label: 'CURRENT FIRMWARE 0.1.0 — Milestone 1B',
    simulatedFuture: false,
    p4Fw: '0.1.0',
    camFw: '0.1.0',
    camsOnline: [true, false, false, false],
    capabilities: M1B_CAPABILITIES,
    maxUartBaud: 921600,
    implementedCommands: M1B_COMMANDS,
  },
  'd4-body-0-2': {
    id: 'd4-body-0-2',
    label: 'CURRENT FIRMWARE 0.2.0 — body, settings and power',
    simulatedFuture: false,
    p4Fw: '0.2.0',
    camFw: '0.1.0',
    /* Still one wired node: the settings and power work changed nothing about
     * how many cameras are jumpered to the P4. */
    camsOnline: [true, false, false, false],
    capabilities: BODY_0_2_CAPABILITIES,
    maxUartBaud: 921600,
    implementedCommands: BODY_0_2_COMMANDS,
  },
  'd4-capture-0-3': {
    id: 'd4-capture-0-3',
    label: 'CURRENT FIRMWARE 0.3.0 — capture pipeline and gallery',
    simulatedFuture: false,
    p4Fw: '0.3.0',
    camFw: '0.1.0',
    /* Four channels are now greeted and four workers fetch frames, but the
     * bench harness still has one node on it. What changed is that the other
     * three report offline because nothing answered, not because nothing
     * asked. */
    camsOnline: [true, false, false, false],
    capabilities: CAPTURE_0_3_CAPABILITIES,
    maxUartBaud: 921600,
    implementedCommands: CAPTURE_0_3_COMMANDS,
  },
  'd4-roll-0-4': {
    id: 'd4-roll-0-4',
    label: 'CURRENT FIRMWARE 0.4.0 — network and Roll commands, no radio route',
    simulatedFuture: false,
    p4Fw: '0.4.0',
    camFw: '0.1.0',
    /* Unchanged from 0.3.0: the bench harness still has one node on it. */
    camsOnline: [true, false, false, false],
    capabilities: ROLL_0_4_CAPABILITIES,
    implementedCommands: ROLL_0_4_COMMANDS,
    maxUartBaud: 921600,
  },
  'd4-looks-0-4-8': {
    id: 'd4-looks-0-4-8',
    label: 'CURRENT FIRMWARE 0.4.8 — looks and sounds on the card',
    simulatedFuture: false,
    p4Fw: '0.4.8',
    camFw: '0.1.0',
    /* Unchanged again: looks and sounds are stored on the P4 and its card,
     * and no node was wired to add one. */
    camsOnline: [true, false, false, false],
    capabilities: LOOKS_0_4_8_CAPABILITIES,
    implementedCommands: LOOKS_0_4_8_COMMANDS,
    maxUartBaud: 921600,
  },
  'd4-settings-0-4-9': {
    id: 'd4-settings-0-4-9',
    label: 'CURRENT FIRMWARE 0.4.9 — settings reach the hardware',
    simulatedFuture: false,
    p4Fw: '0.4.9',
    /* The node image is built from the same firmware/VERSION, so a camera
     * node on this body reports 0.4.9 too — 0.4.9 is the first release where
     * the node has work of its own to do (NL_CMD_SENSOR). */
    camFw: '0.4.9',
    /* Unchanged: one node is jumpered to the bench harness. Per-camera
     * exposure reaches the one sensor that is wired. */
    camsOnline: [true, false, false, false],
    capabilities: SETTINGS_0_4_9_CAPABILITIES,
    /* Identical to 0.4.8 on purpose. Nothing here is a KDP command. */
    implementedCommands: LOOKS_0_4_8_COMMANDS,
    maxUartBaud: 921600,
  },
  'd4-sim-full': {
    id: 'd4-sim-full',
    label: 'SIMULATED FUTURE — full demo device',
    simulatedFuture: true,
    p4Fw: '0.1.0',
    camFw: '0.1.0',
    camsOnline: [true, true, true, true],
    capabilities: null,
    maxUartBaud: 3_000_000,
    implementedCommands: null,
  },
};

export const FIRMWARE_PROFILE_LIST: FirmwareProfile[] = Object.values(FIRMWARE_PROFILES);

/**
 * Look up a profile by an id that is only known to be a string.
 *
 * `FIRMWARE_PROFILES` is a `Record<FirmwareProfileId, …>`, and the id callers
 * actually hold comes off the wire — `snapshot.firmwareProfile` is a plain
 * `string`, because a device may report a profile this build has never heard
 * of. Indexing the record with that directly is a `TS7053`, and three Twin
 * call sites did it: `deviceUi.ts`, `Header.tsx` and `RollPanel.tsx`. It broke
 * `tsc -b` and therefore the `npm run build` step in CI.
 *
 * A cast at each site would have silenced it and kept the real hazard, which is
 * that the lookup can genuinely miss. This returns `undefined` instead, which
 * is what every one of those callers was already coded for — each used `?.` or
 * a truthiness check on the result.
 */
export function profileById(id: string | null | undefined): FirmwareProfile | undefined {
  if (!id) return undefined;
  return (FIRMWARE_PROFILES as Record<string, FirmwareProfile | undefined>)[id];
}

/**
 * Installed-artifact version → profile. Flashing the real repository build
 * (firmware/VERSION) onto the Twin makes it behave like that firmware —
 * including losing the FW_* surface itself, exactly as the physical M1B
 * build would.
 */
export const PROFILE_FOR_VERSION: Record<string, FirmwareProfileId> = {
  '0.1.0': 'd4-m1b',
  '0.2.0': 'd4-body-0-2',
  '0.3.0': 'd4-capture-0-3',
  '0.4.0': 'd4-roll-0-4',
  '0.4.1': 'd4-roll-0-4',
  '0.4.2': 'd4-roll-0-4',
  '0.4.3': 'd4-roll-0-4',
  '0.4.4': 'd4-roll-0-4',
  '0.4.5': 'd4-roll-0-4',
  '0.4.6': 'd4-roll-0-4',
  '0.4.7': 'd4-roll-0-4',
  '0.4.8': 'd4-looks-0-4-8',
  '0.4.9': 'd4-settings-0-4-9',
  // 0.4.10 adds no KDP command and no capability. Its changes are behaviour
  // behind existing surfaces (the viewfinder no longer overwrites the look's
  // JPEG quality, bounded TX writes, the boot sweep budget) plus the additive
  // GET_RUNTIME_STATS protocol.droppedTxFrames field, which the profile does
  // not model — so it maps onto the 0.4.9 profile the same way 0.4.1..0.4.7
  // map onto d4-roll-0-4.
  '0.4.10': 'd4-settings-0-4-9',
  // 0.4.11 is the gallery order index and DELETE ALL PHOTOS (#147) - all of
  // it device-side UI and card layout, no KDP command and no capability, so
  // it maps onto the 0.4.9 profile like 0.4.10 does.
  '0.4.11': 'd4-settings-0-4-9',
  // 0.4.12 fixes three 0.4.11 gallery defects found on the bench (a dropped
  // capture note, index-write card thrash under photography, a sleepless task
  // loop). Same surface, same profile.
  '0.4.12': 'd4-settings-0-4-9',
  // 0.4.13 is node-only (#149): a photograph is served only from a frame
  // armed after the last encoding-register write. No KDP surface change.
  '0.4.13': 'd4-settings-0-4-9',
  // 0.4.14 puts the upload record in the capture-delete list, so deleting a
  // queued capture no longer leaves its folder behind. Card behaviour only.
  '0.4.14': 'd4-settings-0-4-9',
  // 0.4.15 is the device-screen relayout (#151) - drawing only, no KDP
  // surface, no capability. Same profile.
  '0.4.15': 'd4-settings-0-4-9',
  // 0.4.16 is the Win98 chrome system (#152) - bevels, group boxes, wells,
  // focus and press states. Drawing only, same profile.
  '0.4.16': 'd4-settings-0-4-9',
  // 0.4.17 finishes the shooting screen (#153): a real back button, a status
  // bar carrying mode/flash/look/live count. Drawing only, same profile.
  '0.4.17': 'd4-settings-0-4-9',
  // 0.4.18 stops the camera lying about itself (#140, D21, D22): the STALLED
  // line reports on an edge, a card refusal names its holder, refused preview
  // frames are counted, and GET_MODES derives availability instead of
  // hardcoding it. Additive response fields only, so the same profile.
  '0.4.18': 'd4-settings-0-4-9',
  // 0.4.19: every camera channel answers CAMERA_STATUS for itself (#151-era
  // stub removed), and the OV3660 gain ceiling is written in the sensor's
  // 1/16-step units instead of the enum, which had capped AGC at 0.19x and
  // made every frame near-black (#156). Behaviour only, same profile.
  '0.4.19': 'd4-settings-0-4-9',
  // 0.4.20: the photo screen plays a wigglegram (#160), and the bench capture
  // path reaches all four channels (#159, committed unbumped by a concurrent
  // session and carried here). Device-side only, same profile.
  '0.4.20': 'd4-settings-0-4-9',  // 0.4.21: wiggle playback aligns each frame by its META calibration offset
  // and crossfades the steps (#161); also repairs #162's build break. Device
  // side only, same profile.
  '0.4.21': 'd4-settings-0-4-9',
  // 0.4.22: the crossfade is a short front-loaded fade, not a whole-dwell
  // dissolve - the snap is back (#161). Device side only, same profile.
  '0.4.22': 'd4-settings-0-4-9',
};
