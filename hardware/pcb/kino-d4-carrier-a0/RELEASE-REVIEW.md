# A0.1 review — DO NOT ORDER

Reviewed against the user-supplied [ODD JOBS standard V1.0](ODD-JOBS-STANDARD.txt), 29 September 2026. This is a **pre-EVT engineering draft**, not an approved engineering prototype. The `Routed` filename identifies the working layout; it does not mean routing is complete. No manufacturing release exists.

## Rejecting findings

| Priority | Evidence | Consequence and required resolution |
|---|---|---|
| P0 | R1104/R1105 divide charger REGN by 100/(453+100). At 6 V this gives 1.085 V; at 5 V it gives only 0.904 V. | Roughly 100 mA input clamp at nominal 6 V REGN cannot supply the system. Below 1 V the divider does not satisfy the switching restart threshold. Redesign the USB-source/current-limit/startup policy before routing this power stage for manufacture. Firmware alone is not a demonstrated cold-start solution. |
| P0 | Charger CE is pulled high; `CHARGE_ARM` depends on the switched logic supply and expander. TS network is DNP pending pack selection. | Charging with the product off or with a depleted battery is not established. Select the protected pack/NTC and resolve autonomous charging and boot sequencing. Do not bypass temperature sensing to obtain a nominal pass. |
| P0 | Charger switch nets each travel through three vias and inner layers. CHG_SW1 is 16.872 mm; CHG_SW2 is 18.126 mm. Both include approximately 0.20 mm necks. | Reject this autorouted power-stage layout. Re-place the charger, inductor, bootstrap and bypass capacitors using the manufacturer reference layout; route the switching loops manually. Width classes did not enforce adequate final geometry. |
| P0 | 457 track segments occupy In1.Cu, intended as the ground reference. One camera ground thermal connects to an isolated island. | The nominal layer stack is not a continuous reference plane. Re-route signals and power off In1, refill and inspect return paths. Adding stitching vias does not repair arbitrary ground-plane cuts. |
| P0 | 67 unconnected DRC items; four USB pad-to-locator-hole errors, one starved thermal and one dangling trace. | Routing and DRC fail. USB stock footprint has 0.1944 mm clearance against the 0.20 mm target. Resolve against the connector drawing and fabricator process without silently weakening the rules. |
| P0 | Battery, high-current boost inductor, fuse and many passive order codes remain unselected. No measured simultaneous-load budget, voltage-drop or temperature-rise qualification. | BOM cannot be ordered. Complete exact MPN/package/rating/DC-bias/stock review and source-to-load current budget, including every connector, diode, narrow neck and via. |
| P0 | P4 power connects to the host's existing power circuitry. Camera USB shares node supply. | Multiple-source/backfeed behaviour is unqualified. Removable service links are a procedure, not automatic source arbitration. Validate all combinations before release. |
| P0 | TCA9539 defaults camera requests off; current firmware does not implement this carrier's power sequencing. | Existing firmware will not operate the new carrier as drawn. Implement and test expander, charger and power-controller behaviour, including reset and recovery. |
| P0 | Insert pattern position is drawing-derived; no assembled stack, exact socket heights, battery tray or antenna placement has been qualified. | Physical fit is not established. Check actual inserts, spacer/thread engagement, underside parts, USB insertion and optical alignment in the revised enclosure. |

Charger evidence: [TI BQ25798 datasheet](https://www.ti.com/lit/ds/symlink/bq25798.pdf), §7.3.4.3, describes the 1 V offset, 0.8 ohm relationship, minimum 100 mA clamp and restart threshold. These divider calculations are a design review, not measurements. Review the complete pin table and default configuration as part of the power redesign, including VAC2.

## What has been checked

- Exported schematic and working PCB agree on 878 physical pads; existing P4 firmware header mapping agrees. This does not independently validate every manufacturer's pin table.
- Four front XIAO socket centres have 22 mm pitch / 66 mm outer span and common orientation. Socket rows are 15.24 mm apart, with 2.54 mm pin pitch. Optical lens offset remains a CAD datum, not a measured assembled tolerance.
- Outline is 117.01 × 69.41 mm. Four 2.2 mm holes follow the 61.9 × 54.8 mm insert pattern; fastener exclusions are checked on both faces. Absolute insert offset and stack height still need physical confirmation.
- 39 front and 208 back footprints. Functional connector labels and the supplied ODD JOBS symbol are on front silk. `A0.1 DRAFT` identifies this layout revision.
- Zero reported schematic ERC violations. DRC counts above are failures, not accepted waivers. Default ignored KiCad check categories are recorded in the JSON and still require review.
- Black-mask aperture check found no separate pad-aperture gaps below 0.13 mm; four coincident, same-net USB pad pairs are intentional shared apertures. This is not a complete fabrication DFM pass. [JLCPCB capabilities](https://jlcpcb.com/capabilities/pcb-capabilities) give 0.13 mm for black/white at 1 oz. Selected nominal stack/render colours are black mask, white silk and ENIG; the final fabricator stack remains unselected.
- General ground-via grid removed. Added vias now identify their local ground-pad or camera-signal transition purpose in `outputs/GROUND-VIA-PURPOSES.json`. Through-hole ground pours use thermal relief. Remaining thermal starvation is explicitly reported.
- Native top/bottom/side rendering provides a board-level visual review. Missing XIAO/socket/battery/enclosure models prevent a complete assembled 3D fit check.

## Additional open review areas

Every net class requires manual review; the autorouter is a draft aid. Eleven exposed right-angle bends remain after conservative bevel cleanup. Decoupling loop length, switch-node exclusion on other layers, current-monitor Kelvin connections, input ESD paths, boost compensation and enable loading are not signed off. No trace-width setting substitutes for a thermal calculation.

XIAO radio antennas attach externally. The enclosure must locate the actual antennas and their cables with explicit RF clearance from the display, battery, screws, inductors and the user's grip. Do not invent an on-module PCB-antenna keepout for the XIAO's external-antenna connector. The final antenna manufacturer's guidance must determine the physical exclusion volumes.

Current-monitor shunt sensing needs verified Kelvin routing. The TMP117 measures PCB temperature, not ambient air. IMU axis labels must follow the exact package orientation and firmware transform; they are not yet added. Test access, boot/reset reach with the four Sense boards installed, cable strain, connector polarity and diode orientation require assembled review. Stock 3D representations do not certify footprints.

USB-C is charging-only: data pins are NC, so a carrier USB data differential pair is not present. CC termination is supplied by the PD controller, not an assumed extra pair of 5.1 kohm resistors. Internal camera/SD buses remain on the XIAO Sense assemblies; the carrier's principal fast signals are UART and sync. Qualification must include the 3 Mbaud preferred UART rate.

## Release gates

| Gate | State |
|---|---|
| Can it boot? | **Unproven / rejecting:** power defaults, source limits and firmware incomplete. |
| Can it be flashed? | Individual board USB/service access provisioned; assembled access unverified. |
| Can it be recovered? | Board boot/reset and C6 service concepts exist; assembled procedures untested. |
| Can it be measured? | Rail/test/breakout access exists; probe reach and current isolation unverified. |
| Can it physically fit? | XY placement checked; Z stack, battery retention and actual enclosure unverified. |
| EVT | Not accepted: electrical and routing blockers remain. |
| DVT / PVT / PROD | Not reached. No implied promotion from a render or ERC pass. |

After electrical rework and routing: repeat ERC/DRC, independently review exported Gerber/drill/mask/paste data, finish exact BOM/assembly review, check physical components against a 1:1 print, and validate the mechanical stack. First power-up must use a current-limited bench supply with rails checked before connecting a full-current battery. Physical and thermal validation cannot be certified from software alone.

Acceptance work remains in [issue #232](https://github.com/b5463/kino-d4/issues/232). This document is the review evidence, not a separate backlog. **No order approval and no claim of first-build success.**
