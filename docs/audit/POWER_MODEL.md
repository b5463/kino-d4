# Power model

What the Twin power model computes today, what the numbers rest on, and where it diverges from the hardware direction. Normative code: `packages/simulator-engine/src/power.ts`, profile data `packages/hardware-profiles/src/profiles/d4-v1.json` (`power` section). UI: Twin POWER panel.

## Battery and harness — the governing limits

| Value | Model | Confidence |
|---|---|---|
| Cell | 505573 LiPo, 3.7 V nominal, 3000 mAh, 11.1 Wh | `SELLER_SPEC` |
| Cell C-rating | 2C (≈6 A theoretical) — deliberately **not** modeled as usable | `SELLER_SPEC` |
| System continuous limit | `safeContinuousA: 3` — 24 AWG harness + PH2.0 connector govern, not the cell | `SELLER_SPEC`, enforced in `power.ts` (`SUSTAINED_OVER_3A` after 5 s) |
| Short transient | `shortPulseMaxA: 6`, `CRITICAL_OVER_6A` immediately | `SELLER_SPEC` |
| Fuse | F3A fast; dwell approximation (warm after 10 s over limit), **no i²t curve** | `PROVISIONAL` — blow times need the bench (validation plan) |
| Charge preferred | 0.6 A (0.2C) | `SELLER_SPEC` |
| Charge max | 1.5 A (0.5C); 1C is never acceptable | `SELLER_SPEC` |
| Internal resistance | 0.08 Ω | `ESTIMATED` |
| Boost efficiency | 0.85, single constant | `ESTIMATED` |

The model never presents this as a 6 A continuous system. That limit hierarchy (connector < harness < cell) is the point.

## What the model computes

`computePower(profile, loads, activity, dwell)` produces a `PowerSample`: battery V (IR sag), battery A, 5 V bus V/A, per-tag provenance (`MEASURED`/`MANUFACTURER`/`SELLER`/`ESTIMATED`/`SIMULATED`), and warnings (`SUSTAINED_OVER_3A`, `CRITICAL_OVER_6A`, `CHARGE_ABOVE_PREFERRED`, `CHARGE_OVER_MAX`). Activity presets cover idle / preview (CAM2 only) / quad capture / capture+flash / UART transfer / Wi-Fi upload / worst overlap. Flash draw is exactly the three configured drive levels: 0.35 / 0.5 / 0.65 A. Thermal zones (battery, SW6106, LED, heatsink, battery connector) are qualitative four-state estimates driven by electrical warnings.

## Known divergences (audit findings, tracked)

1. **Two power truths.** `GET_POWER_STATUS` in the mock device answers from its own linear 3.3–4.2 V model and never consults `computePower`. The engine sample is display truth in Twin; the device answer is protocol truth to Studio. They must converge on one model.
2. **No charge source.** `chargingA` is a manual UI input; there is no USB-inserted/charger-attached state, so charger warnings are exercised only synthetically.
3. **No SW6106 light-load shutdown.** The known-risk behavior (§12) is unmodeled; threshold and timing are `NEEDS_HARDWARE_VALIDATION`, but an injectable fault must exist before then.
4. **No SoC drain.** SOC is fixed at 0.8; capacity (3000 mAh) has no consumer. Runtime estimation is absent.
5. **5 V droop is a cliff.** The rail droops only past 6 A; there is no dropout curve, and the 18 W SW6106 class is descriptive, never enforced.
6. **Fuse is dwell-only.** Warm/blown by time-over-threshold, not i²t.

Each divergence is either scheduled (issues) or gated on bench measurements (see `HARDWARE_VALIDATION_PLAN.md`). Simulated values carry `SIMULATED`/`ESTIMATED` tags in the UI; the model refuses to imply measurement it does not have.

## Backup power

The 4 × 16340 cells + 2 shields are experimental bench hardware. They live in the D4-V1 profile only as `alternatePower["16340-bench"]` — a schema whose `experimental: true` literal makes a production alternate unrepresentable. The Twin never defaults to it: the POWER panel's PACK selector must pick it, a permanent EXPERIMENTAL banner shows while it is active, the live sim applies it only at POWER ON, and recorded sessions carry the pack id (`powerProfileId`) so a bench-pack session can never pass as stock. Pack geometry (cells + shields) is not modeled in the scene.
