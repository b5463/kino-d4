# Release trust: signing, verification, and firmware rollback

The written contract that has to exist before signing or rollback is implemented (issue #14). Nothing here describes shipped behaviour unless it says so; each section marks what exists today and what a future implementation must do.

## What is signed, and by whom

| Artifact | Signer | Where the signature lives |
|---|---|---|
| Firmware package (`kino.firmware-manifest` + images) | The KINO release key | `manifest.sig` beside `manifest.json`, detached, over the manifest bytes |
| Studio bundle | The KINO release key | `SHA256SUMS.sig`, detached, over `SHA256SUMS` |
| Individual images | Not signed separately | Their SHA-256 is inside the signed manifest; signing the manifest signs the set |

One key signs both, because a KINO release is one decision. Ed25519, because the verifier is a browser (Web Crypto supports it natively) and an ESP32 (mbedTLS supports it) and neither should carry an X.509 stack for this.

**Signing happens off the build machine.** `npm run release` produces the unsigned bundle and its `SHA256SUMS`; the signing step takes that directory, verifies the sums itself, and writes the `.sig` files. A build machine that could sign would make every CI compromise a supply-chain compromise.

## Where verification keys live

- **Studio** ships the public key as a compile-time constant, not a fetched document. A key that can be fetched can be replaced by whoever controls the fetch.
- **Firmware** carries the same public key in its image. The bootloader-level trust chain (ESP-IDF Secure Boot) is a separate decision, recorded below as out of scope for V1.
- **The Roll catalog API** stores the signature alongside the package and serves it; it never validates on the client's behalf. Verification happens where the bytes are installed.

## Verification order, before anything is flashed

Studio's updater must reject in this order, and must say which check failed:

1. **Manifest signature** — invalid or missing signature: refuse. (Not implemented; see below.)
2. **Hardware compatibility** — `compatibleHardware` must contain the string the connected camera reports in `GET_DEVICE_INFO.hardware`. *Implemented*: `checkCompatibility` in `apps/studio/src/firmware/manifest.ts`, which is also why the build daemon declares `V1` rather than the `D4-V1` design label (issue #90).
3. **Protocol range** — the camera's protocol version must sit within `protocolMin..protocolMax`. *Implemented*.
4. **Image digests** — every image's SHA-256 must match its manifest entry, recomputed from the loaded bytes. *Implemented*: `loadPackageFromFiles`, and re-verified by `daemonClient` for daemon-built packages.
5. **Downgrade** — an older version than the installed one is allowed but requires the explicit downgrade confirmation. *Implemented*: `isDowngrade` + the UPDATE KINO confirm.

The device repeats step 4 for itself: `FW_END` hashes the received bytes against the declared digest and refuses a corrupted image rather than reporting `verified: true` unconditionally. *Implemented.*

**Not implemented: step 1.** Signature verification is the one gate in this list with no code behind it. It is deliberately specified first so that adding it cannot be mistaken for a UI feature: the verifier belongs in `apps/studio/src/firmware/manifest.ts` beside the other refusals, and in the firmware's `FW_END` beside the digest check.

## Firmware rollback

### The state machine

An OTA slot is in exactly one of four states, and the device owns the transition:

```
  PENDING_VERIFY ──(self test passes)──▶ CONFIRMED
        │
        └────(self test fails, or no confirmation before the watchdog)──▶ ROLLED_BACK ──▶ previous slot runs
```

- **PENDING_VERIFY** — the new image booted but has not proven itself. Set by the bootloader on first boot of a freshly flashed slot.
- **CONFIRMED** — the image ran its self test successfully and marked itself valid. Only a confirmed image survives a power cycle.
- **ROLLED_BACK** — the device returned to the previous slot on its own. The reason is recorded and reported.

The rule that makes this safe: **an unconfirmed image never becomes permanent.** A firmware that boots, answers HELLO, and then fails its self test must not be the image that runs tomorrow.

### The KDP surface

`FW_ROLLBACK` is **reserved, not implemented** — the opcode is defined here so that a UI can never be built against an invented shape:

| Command | Value | Payload |
|---|---|---|
| `FW_ROLLBACK` | `0x66` | → `{}` ← **inline** `{ "ok": true, "rebooting": true }`, then the device reboots into the previous slot. NACKs `NO_PREVIOUS_IMAGE` when there is nothing to roll back to, `UNSUPPORTED_COMMAND` on firmware without A/B slots. |

The value is reserved in both `packages/kdp/src/protocol/commands.ts` and `firmware/components/kdp_core/include/kdp/protocol.h` — an opcode that exists only in prose gets reused by the next person who needs a number.

`FW_STATUS` (`0x65`, already defined) gains `slot` and `slotState` fields carrying the state machine above, so Studio can show what is running before offering anything.

**Studio must not offer a rollback button until `FW_STATUS` reports a real `slotState`.** A button that reports success against firmware with one slot is worse than no button.

### Why V1 ships without it

Milestone 1B firmware has a single application partition (`firmware/p4/partitions.csv`), so there is no previous slot to return to. The recovery path for a bad image is the documented ROM-loader procedure — which is why the connection-failure notice carries those steps inline (issue #86) rather than pointing at a UI that needs a working device.

Implementing rollback means changing the partition table, which changes the flash layout, which invalidates every existing unit's OTA path. That is a hardware-milestone decision, not a patch.

## Key rotation and loss

- **Rotation.** A new key is added to Studio and firmware as an *additional* accepted key, one release before it starts signing. Verifiers accept the old and the new key during that window; the following release drops the old one. A rotation that flips both ends at once bricks every camera whose firmware predates the change.
- **Compromise.** Revoke by shipping a Studio release whose accepted-key set excludes the compromised key, and a firmware release signed by the new key. Cameras already in the field must be updated over the *old* key one last time — which is why the window above exists, and why a compromise is recoverable only if rotation was practised before it was needed.
- **Loss.** A lost signing key cannot be recovered; it can only be replaced by the rotation path, which requires shipping one release signed by the lost key. **Therefore the private key is escrowed offline before its first use**, and the escrow is tested by performing one rotation on a throwaway key before the first real signed release.
- **Never** put a signing key in CI secrets, in this repository, or on a machine that builds artifacts.

## Test matrix (before signing or rollback is called done)

| Path | Expected |
|---|---|
| Interrupted update (cable pulled mid-`FW_CHUNK`) | Device stays on the old image; Studio reports the failure and offers retry from the start |
| Bad digest | `FW_END` refuses; no slot switch; the old image still runs |
| Invalid signature | Studio refuses before the first chunk is sent |
| Wrong hardware | Studio refuses at load, naming the mismatch |
| Failed boot of a new image | Device returns to the previous slot without host involvement |
| Rollback then reconnect | Studio detects the changed boot/session id and re-reads device state |

The first four are implementable and testable today against the reference device; the last two need A/B slots and therefore real hardware.
