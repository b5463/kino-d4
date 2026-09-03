# Isolating a node power fault

Two nodes have taken spontaneous power-on resets on this bench: CAM1 (recovering
from a nine-minute wedge, about 23:47 on 2026-09-03) and CAM4 (independently,
between 23:56 and 00:15). This is the procedure that says whether the cause is
one channel's own power path or something they share.

Kept deliberately separate from the `shortRead` preview-drop question in
`CAM3_SWAP_MATRIX.md`. A reset and a dropped preview frame are different
observables with different causes until something proves otherwise.

## What counts as evidence, and what does not

**The only reset evidence is the node session counter and `resetReason`**, both
from `GET_CAMERA_INFO`'s per-camera `node` object.

- `session` is `boot-<n>` from `next_boot_count()` in `camnode/main/main.c`,
  which keeps `n` in NVS and increments it every boot. It **survives an app
  flash**, so the absolute value is a lifetime total including bring-up and
  every reflash - CAM1 reads far higher than its siblings for that reason
  alone. **Only the delta across a window means anything.**
- `resetReason` is `esp_reset_reason()` mapped in `node_server.c`. It is
  **sticky**: it names the last reset whenever that happened, so a node reads
  `power-on` indefinitely after one power cycle. It classifies a reset; it does
  not date one.
- `ESP_RST_BROWNOUT` maps to `"brownout"` separately, so `"power-on"` means the
  rail actually went below the power-on-reset threshold rather than the
  brownout detector firing.

**Never infer a reset from `timeout`, `shortRead`, `crcErrors` or a preview
frame counter.** Those move for contention reasons that have nothing to do with
power, and reading them as reset evidence is how the two hypotheses get
conflated.

## The problem this procedure has to solve

The observed rate is roughly **one spontaneous reset per node per few hours**.
A one-hour run therefore has a low chance of catching one, and *absence of a
reset in a single window is not evidence that a configuration fixed anything*.
Two consequences shape the whole design:

1. **The bank is its own control.** All four nodes run simultaneously under the
   same load off the same infrastructure. If one channel resets repeatedly and
   the others do not, that is a per-channel fault with three built-in negative
   controls, and it needs no A/B run at all. If two or more reset close
   together, the shared path is implicated.
2. **Swap, do not just re-run.** Because absence proves little, each step moves
   the *suspect channel* onto known-good infrastructure and a known-good
   channel onto the suspect infrastructure. Then a fault that follows the part
   is positive evidence in one window rather than an absence over many.

## The continuous watcher

Run this for the whole of any power investigation. It samples every 15 s, logs
only changes, and timestamps every session change on every node so
cross-node correlation is a matter of reading the file:

```powershell
& node_reset_watch.ps1 -Hours 8
```

It records, per sample: session, resetReason, online, sensorDetected. It writes
a line only when one of those changes, plus a heartbeat every 30 minutes so a
quiet log is distinguishable from a dead script.

Correlation rule, applied to that log:

- **two or more nodes changing session within about a minute of each other →
  `SHARED_POWER_PATH_SUSPECT`**
- **one node changing session repeatedly while the others do not →
  `NODE_POWER_PATH_SUSPECT` for that channel**
- **no session change across a clean multi-hour soak → `NOT REPRODUCED`**,
  and the run becomes the new baseline

## The isolation matrix

One variable per step. Stop at the first step that makes the fault follow the
part. Do not open a XIAO USB CDC console at any point - on native USB that is
itself a reset, and it would forge exactly the event being counted.

### Step 1 — USB cable

Swap the suspect node's USB cable with a known-good channel's. Nothing else
moves: same hub port, same power source, same XIAO, same position in the body.

- Resets **follow the cable** to the other channel → the cable. Replace it.
- Resets **stay** with the original channel → continue.

Cheapest first because a USB cable is the single most likely intermittent in
any bench, and it costs one plug.

### Step 2 — hub port

Swap which hub output each of the two channels uses. Same cables as now, same
source, same XIAOs.

- Resets **follow the port** → that hub output. Move both nodes off it and mark
  the hub.
- Resets **stay** with the channel → continue.

### Step 3 — the common source

Move the suspect node alone onto an independent supply - a different powered
hub, or a wall PSU into its own USB port - so it no longer shares the source
with the other three.

- Resets **stop** on the isolated node → the shared source cannot carry four
  nodes plus four streaming cameras. That is a bench infrastructure fix, and it
  also explains two different channels resetting on different evenings.
- Resets **continue** on the isolated node → the source is exonerated and the
  fault is in the node itself. Go to step 4.

This is the step that separates rule A from rule B, so it is worth doing even
if steps 1 and 2 look clean.

### Step 4 — the XIAO

Swap the suspect XIAO with a known-good one, carrying nothing else: the camera
assembly, the cable, the hub port and the position all stay.

- Resets **follow the XIAO** → that board. Its own regulator or USB input is
  suspect; replace it.
- Resets **stay** with the position → nothing about the node is at fault and
  the remaining candidate is the body wiring at that position: the JP1 supply
  and ground run to it.

### What is deliberately not in this matrix

The P4 UART path, the camera ribbon and the OV3660 module. None of them can
cause an `ESP_RST_POWERON` on the node - the node's reset is about its own
supply. Those belong to `CAM3_SWAP_MATRIX.md` and the `shortRead` question.

## Reading the result

A power fault confirmed at any step should be re-verified by putting the
suspect part back and showing the resets return. A fault that cannot be made to
return on demand is not isolated, however satisfying the first result looked -
at roughly one event per node per few hours, one clean window is chance rather
than proof.
