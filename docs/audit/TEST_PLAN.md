# Test plan — automated and bench

## Automated, running today

CI (`.github/workflows/ci.yml`) runs version/license checks, lint, and the full workspace suites: eleven service-free workspaces plus API and worker against real PostgreSQL/Redis/MinIO services. Current coverage of record: protocol framing/CRC/HELLO/resync, capability gating, device scenarios (28 flags + 6 per-cam faults), firmware update states **including real sha256 rejection of a corrupt image**, choreography/boot/power/thermal/flash-risk models, deterministic record/replay, Twin↔Studio raw-KDP integration, Roll upload dedupe/resume/races, originals immutability, retention/purge, gallery scale (0/60/2 000/10 000 device-side), production preview harness, backup redaction.

## Required additions (tracked)

1. **Shared cross-transport contract suite** — one parameterized command sequence (connect → HELLO → capabilities → config read/write → capture → storage → network/Roll → firmware) run against mock transport, Twin BroadcastChannel, and recorded real-device sessions. Today the two transports run different bespoke tests.
2. **Transport hostility parity** — duplicate frames, dropped bytes, baud mismatch, mid-frame disconnect, RX overflow scenarios; Twin transport must re-chunk at least as hostilely as the mock.
3. **First real config migration test** — the registry's migration engine has zero registered migrations; the first schema bump ships with one plus a downgrade-handling test.
4. **Capture-never-blocked test** — capture to SD succeeds while `rollServerUnreachable` is active; queue survives a simulated reboot.
5. **API-scale pagination test** — a 2 000-capture roll walked through the keyset cursor with four-camera timestamp ties.
6. **Studio DOM tests** for the gallery grid/lazy loader (suite currently runs in node env only).

## Bench plan (hardware-gated)

The full measurement list with methods and record destinations is `HARDWARE_VALIDATION_PLAN.md`; the plan's workstream WS7 rungs (real transport, bring-up ladder, sync soak, UART ladder, flash/power, production updates, on-device Roll queue) remain the hardware acceptance bar. Studio's bring-up, link-bench, timing-bench, and burn-in panels are the instruments; their JSON exports are the evidence format. Missing instruments to build before they're needed: flash-timing bench, SD write benchmark, power-load transient test, focus sweep (with AF hardware).

## Rules

Every fix ships with the test that fails without it. Simulation results never masquerade as hardware results — bench evidence is recorded with the measurement, and simulated values stay labelled `SIMULATED`/`ESTIMATED` in every UI and export.
