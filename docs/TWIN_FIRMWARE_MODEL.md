# Twin firmware model

How KINO Twin models firmware generations (issue #72).

## Profiles

`packages/test-fixtures/src/firmwareProfiles.ts` — the profile pins the
reference device to one firmware generation. The dispatcher, the capability
report, per-target versions, camera-link availability, and the advertised
UART ceiling all derive from the same profile object, so what the device
claims and what it answers cannot drift apart.

**Seven profiles, six of them real generations.** Pick the one that matches the
firmware you are validating against. `d4-m1b` models **0.1.0** and is two
generations stale — it is not "the current firmware", and a Studio feature
validated only against it has been validated against a device from before the
capture pipeline, the Roll surface, looks and settings all landed.

| Profile | Models | Meaning |
|---|---|---|
| `d4-m1b` | 0.1.0 | Honest Milestone 1B: CAM1 only, `benchDiagnostics` the sole capability, the 17-command surface `kdp_server.c` had at 0.1.0; everything else NACKs `UNSUPPORTED_COMMAND` with the firmware version in the message. No `FW_*` surface — that build had none |
| `d4-body-0-2` | 0.2.0 | Body, settings and power: the config store answers and persists, `mediaIndex` lists captures it cannot hand over |
| `d4-capture-0-3` | 0.3.0 | Capture pipeline and gallery: `wiggle`/`quad` capture and `gallery` pixels |
| `d4-roll-0-4` | 0.4.0 – 0.4.7 | Network and Roll commands present, **no radio route** — the handlers answer with a reason rather than `UNSUPPORTED_COMMAND` |
| `d4-looks-0-4-8` | 0.4.8 | Looks and sounds on the card: `recipes` and `customSounds` go true |
| `d4-settings-0-4-9` | 0.4.9 – 0.4.53 | Settings reach the hardware. **The closest profile to today's firmware.** Every release from 0.4.10 on maps here because none of them adds a KDP command or a capability |
| `d4-sim-full` | — | SIMULATED FUTURE: the full demo device — all cameras, all capability groups, OTA, gallery, network/Roll. Labeled SIMULATED FUTURE everywhere it surfaces (brief §42) |

`FirmwareProfileId` and `PROFILE_FOR_VERSION` in
`packages/test-fixtures/src/firmwareProfiles.ts` are the source for this table.
`PROFILE_FOR_VERSION` maps every shipped release — 0.1.0 through the current
`firmware/VERSION` — onto one of the six, and `npm run version:check` fails if a
firmware bump does not add its entry. Read the mapping there rather than
inferring a profile from a version number.

Switching: Twin → FIRMWARE tab (simulation control), or programmatically
`device.setFirmwareProfile(id)`. Like a flashed image, the profile survives
reboot and factory reset.

## Firmware install → profile

The `d4-sim-full` OTA path is real end-to-end: maintenance gate, 8 KB
chunks, device-side SHA-256 (`SHA256_MISMATCH` on corruption), staged
apply/reboot timeline. On a successful P4 apply,
`PROFILE_FOR_VERSION[version]` maps the installed release to a profile —
flashing the repository's current artifact lands on `d4-settings-0-4-9`, and
flashing an old `0.1.0` artifact turns the Twin into the honest M1B device,
including losing the OTA surface itself, exactly as that build would. Studio then reconnects and sees the new version and
the narrowed capabilities (covered by
`packages/test-fixtures/tests/firmwareIntegration.test.ts`).

## Per-target versions

`FW_QUERY`/`GET_DEVICE_INFO`/the Twin FIRMWARE tab report MAIN + CAM1..CAM4
versions independently; camera-node updates apply per target, and the
`nodeFwMismatch` scenario models a stale CAM4 that Studio must flag.

## Boundaries

- Profile switching is SIMULATION CONTROL, never a KDP command.
- Capability extraction is not hand-maintained per panel: profiles feed
  `overrideCapabilities` AND the dispatcher gate from one table (brief §37).
- The Twin cannot execute the C firmware; the profile emulates its contract
  behavior. The contract test keeps the emulation honest; divergences found
  later get recorded in `docs/audit/STUDIO_TWIN_FIRMWARE_INTEGRATION_AUDIT.md`.
