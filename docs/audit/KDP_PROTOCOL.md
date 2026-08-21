# KDP protocol — current specification summary

Normative source: `packages/kdp/src/protocol/*` and `firmware-contract/` (which records deviations). This document summarizes what is implemented and names the verified gaps; when it disagrees with the code, the code wins.

## Framing

14-byte header, CRC-32 (`crc32_le`), sequence-number correlation, `RESPONSE|ERROR` flag for NACKs with `{code, message}` payloads. Partial packets buffer in `FrameDecoder`; resync scans for the magic after garbage. Unknown commands NACK `UNSUPPORTED_COMMAND` (the device-side default), which the client raises as `KinoUnsupportedError`.

## Session

HELLO: 3 attempts, 500 ms timeout, 150 ms gap, fresh nonce per attempt, protocol range negotiation (out-of-range = hard fail, never a guess). Boot spew is expected and resynced out of. `sessionId` changes on every reboot; Studio fails in-flight jobs and re-HELLOs, and periodically rechecks the session to catch an in-place device restart behind an open port.

## Capability negotiation

`GET_CAPABILITIES` (0x06) is implemented and Studio gates features on it (Roll pages, flash lamp, sensor controls, sync bench, firmware). The mock can override or null capabilities. Verified caveats:

- **Fail-open gate**: with no capabilities loaded, `supports()` returns `true` — a device whose capability query times out gets the full feature surface. Must become fail-closed once connect-time capability fetch is guaranteed.
- **Two capability models**: the typed wire `Capabilities` interface and the persisted `kino.device-capabilities` schema (open `features` record) have drifted; three keys the mock emits are absent from the typed interface.
- The spec's target vocabulary (`camera.count`, `camera.ov5640`, `camera.autofocus`, `camera.focus_lock`, `camera.manual_focus`, …) is not yet in either model; it lands with the OV5640/AF work.

## Configuration versioning

Every config document travels in a `ConfigEnvelope { schemaVersion, device, configRevision, config }`; `CONFIG_SCHEMA_VERSION = 1`. The schema registry supports stepwise migrations — but **zero migration functions exist yet**, and Studio rejects only *newer* versions; an older envelope is accepted unmigrated. The first real schema bump must ship with a real migration and a test, or every existing document breaks.

## Firmware update

`FW_BEGIN → FW_CHUNK* → FW_END`, per-target (`p4`, `cam1..4`), maintenance-mode-gated, sizes bounded, one session at a time. **As of this audit the reference device actually verifies sha256 at `FW_END`** — a mismatched image is rejected with `SHA256_MISMATCH` and nothing is flashed (previously it answered `verified: true` without hashing). Retry resumes from the failed target; `FW_ABORT` exits cleanly. Not implemented: `FW_ROLLBACK` (no protocol recovery for a node bricked mid-apply — recovery is the documented ROM-loader path), per-chunk retry, `FW_PROGRESS`/`STATUS` events (allocated ids, no producer), any C6 target.

## Transport realism

The mock transport re-chunks (split/coalesced frames), corrupts CRCs, delays responses, drops HELLOs, and boot-spews. Missing modes, in severity order: duplicate/retransmitted frames, dropped bytes, baud mismatch, explicit mid-frame disconnect, RX buffer overflow. The Twin BroadcastChannel path does no re-chunking at all — it is currently *less* hostile than the mock, which inverts the intent.

## Request resilience

There is **no retry policy above HELLO** — every request is one-shot per sequence and failure surfaces as UI error text. Acceptable on a lossless mock; not on a real UART. A bounded idempotent-read retry policy is required before hardware integration.

## Cross-transport contract

Both transports are exercised in tests, but by different bespoke sequences. The target state — one parameterized command-sequence suite run against mock, Twin, and recorded real-device transports — does not exist yet. Recording/replay (`kino.sim-session`) exists and verifies byte-for-byte, Twin-side only.
