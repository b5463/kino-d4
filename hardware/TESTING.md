# D4 V1 hardware acceptance

Copy the record section for each physical unit. Keep raw measurements and scope captures with the unit record.

## Unit record

| Field | Value |
|---|---|
| Unit serial | |
| Hardware revision | D4 V1 |
| Build date | |
| Builder | |
| P4 firmware | |
| Camera firmware | |
| Studio version or commit | |
| Battery identifier | |
| microSD identifier | |

## Visual and mechanical

- [ ] No damage to the LiPo pouch, insulation, or leads.
- [ ] Fuse is fitted near battery positive.
- [ ] Every connector is keyed or clearly labelled.
- [ ] Pin 1 is marked on the 26-pin ribbon.
- [ ] USB-C ports and microSD remain accessible.
- [ ] Harnesses have strain relief and cannot touch sharp edges.
- [ ] Camera bar is rigid and lens order is CAM1 through CAM4 from left to right.
- [ ] Flash thermal stack has full contact and clearance from plastic.

## Unpowered electrical checks

| Check | Result | Reading or note |
|---|---|---|
| Battery polarity | | |
| 5 V rail to ground resistance | | |
| Camera harness polarity, all four | | |
| UART crossover, all four | | |
| Sync continuity, all four | | |
| No short across flash output | | |
| Ground continuity | | |

## Power

Record with the bench supply first, then the fitted battery.

| State | Input V | 5 V rail | Input A | Lowest rail V | Reset or fault |
|---|---:|---:|---:|---:|---|
| Main unit idle | | | | | |
| One camera on | | | | | |
| Four cameras on | | | | | |
| Four-camera capture | | | | | |
| Parallel transfer | | | | | |
| Flash at 350 mA | | | | | |

- [ ] Each camera power channel switches independently.
- [ ] Power cycling one camera does not reset the other controllers.
- [ ] Protection behavior was tested without exceeding the battery harness limit.
- [ ] USB and battery operation both complete a capture.

## Camera links and capture

- [ ] All four modules report the expected sensor and firmware.
- [ ] Repeated status polling completes without decoder or CRC growth.
- [ ] A WIGGLE capture stores four originals.
- [ ] A QUAD capture stores four originals with four requested recipes.
- [ ] Parallel transfer completes with all four cameras connected.
- [ ] A disconnected camera produces a named fault and leaves existing originals intact.
- [ ] A full or missing microSD produces a named storage fault.

## Synchronization

Run at least 250 triggers.

| Metric | Mean | Median | P95 | Max | Available reason or instrument |
|---|---:|---:|---:|---:|---|
| GPIO distribution skew | | | | | |
| VSYNC phase skew | | | | | |
| Effective exposure skew | | | | | |

- [ ] Studio shows all three metrics separately.
- [ ] Missing telemetry is `null` with a reason.
- [ ] The pass decision uses effective exposure when available.
- [ ] Scope or image evidence is attached to the unit record.

## Flash and thermal

| Test | Start °C | Peak °C | Rail minimum | Result |
|---|---:|---:|---:|---|
| 10 single flashes | | | | |
| Repeated capture sequence | | | | |
| Closed-enclosure sequence | | | | |

- [ ] LED current was measured at the driver output.
- [ ] No diffuser, wire, adhesive, or printed part softened or discoloured.
- [ ] The main unit and camera nodes did not reset.
- [ ] Flash exposure was checked for rolling-shutter bands.

## Recovery

- [ ] Unplug during an idle Studio session, then reconnect.
- [ ] Reboot the main controller and verify the new session is detected.
- [ ] Interrupt a media read and retry from a new offset.
- [ ] Interrupt a firmware update only on a recoverable test build.
- [ ] Confirm the documented recovery path returns the unit to a known build.

## Soak

Run the closed unit for the intended party duration or the longest practical bench session. Exercise idle, shooting, gallery reads, uploads, flash, and repeated reconnects.

| Duration | Captures | Resets | Link faults | Peak temperature | Battery start/end |
|---:|---:|---:|---:|---:|---|
| | | | | | |

## Sign-off

| Decision | Name | Date | Notes |
|---|---|---|---|
| Electrical | | | |
| Firmware and protocol | | | |
| Optical and sync | | | |
| Mechanical | | | |

A blank row is untested. It is not a pass.
