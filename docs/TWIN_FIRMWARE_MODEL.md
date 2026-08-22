# Twin firmware model

How KINO Twin models firmware generations (issue #72).

## Profiles

`packages/test-fixtures/src/firmwareProfiles.ts` — the profile pins the
reference device to one firmware generation. The dispatcher, the capability
report, per-target versions, camera-link availability, and the advertised
UART ceiling all derive from the same profile object, so what the device
claims and what it answers cannot drift apart.

| Profile | Meaning |
|---|---|
| `d4-m1b` — CURRENT FIRMWARE 0.1.0 | Honest Milestone 1B: CAM1 only, `benchDiagnostics` the sole capability, exactly the 17-command surface of `firmware/p4/main/kdp_server.c`; everything else NACKs `UNSUPPORTED_COMMAND` with the firmware version in the message. No FW_* surface — the real build has none |
| `d4-sim-full` — SIMULATED FUTURE | The full demo device: all cameras, all capability groups, OTA, gallery, network/Roll. Labeled SIMULATED FUTURE everywhere it surfaces (brief §42) |

Switching: Twin → FIRMWARE tab (simulation control), or programmatically
`device.setFirmwareProfile(id)`. Like a flashed image, the profile survives
reboot and factory reset.

## Firmware install → profile

The `d4-sim-full` OTA path is real end-to-end: maintenance gate, 8 KB
chunks, device-side SHA-256 (`SHA256_MISMATCH` on corruption), staged
apply/reboot timeline. On a successful P4 apply,
`PROFILE_FOR_VERSION[version]` maps the installed release to a profile —
flashing the repository's real `0.1.0` artifact turns the Twin into the
honest M1B device, including losing the OTA surface itself, exactly as the
physical build would. Studio then reconnects and sees the new version and
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
