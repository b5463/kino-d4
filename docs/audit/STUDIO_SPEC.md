# Studio specification — production functionality

What Studio is (the professional companion for KINO hardware, in the 2000s-utility design language defined by `PRODUCT.md` and `kino_dev_spec_pack/06`), what exists, and what the audit found missing. Normative: `apps/studio/src`.

## Module inventory (audited)

| Module | Status |
|---|---|
| Device connection (USB / Twin / demo) | PASS — one connect path, three transports; Twin needs no simulator screens |
| Device overview + health | PASS — MAIN/CAM1–4/BATTERY/SD/SYNC, plus 5 V rail, WIFI and ROLL rows. Each of the three prints NOT AVAILABLE (no capability), NOT REPORTED (unanswered) or the device's own value; the three are never collapsed |
| Camera status | PASS — per-cam state, fw, sensor, stats, temperature on the camera cards, and `armed` as its own lamp (exits: the capture, or the arm window) |
| Capture / sensor config | PASS — wiggle/quad/shoot with per-slot recipes |
| Focus | MISSING end to end — arrives with OV5640/AF |
| Flash | PASS (policy, per-mode, level/distance calibration); no timing bench |
| Sync calibration | PASS — Skew Bench + sensor phase |
| Camera / color calibration | PASS (see `CALIBRATION.md`), including report export/import |
| Firmware management | PASS with gaps — per-target versions/progress/verify/retry/abort + catalog and a downgrade guard; **no rollback, stable channel only** |
| Backup/restore | PASS — schema-versioned `.kino`; as of this audit it strips Roll identity and records camera firmware, protocol, and config schema version; restore still lacks a serial/hardware match confirmation |
| Diagnostics | PARTIAL — self test, developer runtime/protocol counters, frame trace, serial console, exportable report; health gaps above |
| Storage | PASS (presence/capacity/free) plus the `STORAGE_BENCH` write/read benchmark, reporting `worstBlockMs` first. Reserved in P4 firmware — the reference device answers it, the M1B build NACKs `UNSUPPORTED_COMMAND` (`firmware-contract/commands.md`) |
| Wi-Fi / Roll | PASS — capability-gated, credential-safe |
| Photo import | PASS — device→computer tether, plus computer→Studio: Gallery → IMPORT FOLDER… opens a folder of already-transferred frames (the tether layout) in the inspector with no camera attached. Session-only, not a library and not an upload path; alignment offsets come from the capture's META.JSON, else live calibration, else unmeasured and labelled so |
| Gallery | PASS at target scale — paged 24/page, lazy thumbs with cache, 5000-row index windows, tested at 0/60/2 000/10 000 |
| Post-processing | PARTIAL — align/match/look preview; re-render pipeline is the worker's gap |
| Export | PASS — per-frame, ZIP, GIF (client), MP4; aligned-crop toggle |
| Hardware testing | PASS — bring-up ladder, link bench, timing bench, burn-in, flash timing, SD write (`STORAGE_BENCH`) and the power-load ladder (MEASURED sag against `computePower`'s ESTIMATE, one model, not two) |
| Logs / developer diagnostics | PASS — 1500-line ring, filters, export |

## Studio ↔ Twin equivalence

Studio connects to Twin through the same HELLO/populate path as hardware, gates on capabilities, and has no Twin-only screens. As of this audit the transport is honestly labelled (`· USB` / `· KINO TWIN` / `· DEMO DEVICE`) and the Overview FLASH lamp is device-reported (capability) instead of a hardcoded green. Twin presents as `KD4-SIM-0001`.

## Design language

Verified against the register: silver-blue chrome, 1 px bevels, Tahoma/Consolas, 24 px controls, 12 px base, dense toolbars/tabs/lamps, Alt mnemonics, beveled scrollbars — no SaaS drift beyond one soft shadow on the connect card. State is never color-only. The bar stays: "software that came on the CD with an unusually cool 2005 digital camera."

## Required next (tracked as issues)

A firmware rollback decision · restore identity check · the focus surface (arrives with OV5640/AF) · the worker's re-render pipeline · a P4 `STORAGE_BENCH` handler (the opcode is reserved and honestly NACKed until one exists).
