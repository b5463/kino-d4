# Studio device integration

How Studio talks to any KINO (issue #72).

## One contract, three transports

```text
Studio page → KinoDevice facade → KinoProtocolClient → Transport
                                            ├─ SerialTransport   (physical D4, Web Serial)
                                            ├─ BroadcastTransport (KINO Twin, same origin)
                                            └─ MockTransport      (in-tab demo device)
```

There is no `if (twin)` anywhere in device operations: the connect screen
offers `CONNECT KINO TWIN` when a Twin tab is detected on the origin, and
everything after `connectWith()` is transport-blind. Telemetry provenance is
carried by the transport kind (`· TWIN`, `· DEMO DEVICE`, `· USB` suffixes)
and by per-value labels (`SIMULATED`, `MEASURED`, `NOT REPORTED`).

## Working against current firmware

Milestone 1B firmware implements a narrow surface. `populateAll`
(`apps/studio/src/app/session.ts`) now tolerates `UNSUPPORTED_COMMAND` on
each optional read individually — power, config, recipes, calibration and
runtime stats degrade to "absent" instead of failing the connection. Studio
therefore connects to the real M1B build (or the Twin `d4-m1b` profile) and
renders what exists: camera health, storage, bench diagnostics, logs, self
test; everything else shows its capability-gated "not supported by firmware
x.y.z" state.

The conformance suite (Developer → CONFORMANCE) is the acceptance harness:
its bench-diagnostics cases run against Twin today and against physical
firmware unchanged; unsupported classifications are expected states, not
failures.

## Captures

Twin captures arrive exactly like camera captures: `Evt.CAPTURE` → gallery
merge notice → `MEDIA_LIST/THUMB/READ`. With the Twin stage running, the
bytes Studio downloads are the actual virtual-sensor renders (verified by
the integration contract test). Under the `d4-m1b` profile the gallery is
honestly unsupported — the real M1B build has no media surface yet.

## Firmware

Updates flow: package (built locally via the FIRMWARE BUILDER, downloaded
from the Roll catalog, or loaded from disk) → compatibility check against
the connected device → maintenance mode → `FW_BEGIN/CHUNK/END` per target →
device-side SHA-256 → reboot → reconnect → health check. Twin runs this
end-to-end; physical OTA is milestone 7 (`docs/FIRMWARE_BUILDER.md`).
