# Isolating CAM3: the swap matrix

CAM3 has been called hardware-suspect four times. The reliability bench in
`HARDWARE_VALIDATION.md` ("CAM3 is not a streaming outlier", 2026-09-03) shows
the excess is real, load-dependent and small: nothing under pure streaming,
roughly two to four times the other channels under capture load, always
`shortRead` with `crcErrors` zero, always recovered by a retry.

That measurement cannot say *which part* is at fault. Five candidates sit in
series on that channel and only a physical swap separates them:

| | candidate |
|---|---|
| A | P4 UART channel — peripheral, pins, JP1 path |
| B | the XIAO ESP32-S3 |
| C | the OV3660 module |
| D | the camera ribbon |
| E | the connector and wiring between P4 and node |


## Reprioritised, 2026-09-03: power comes first, and CAM1 is now the worse channel

Read the node reset counters before doing anything else in this document. On
2026-09-03, before any node was reflashed:

| cam | node session | reset reason |
|---|---|---|
| **cam1** | **boot-85** | **power-on** |
| cam2 | boot-15 | usb |
| cam3 | boot-16 | usb |
| cam4 | boot-11 | usb |

Same image, same uptime, same number of bench flashes. CAM1 has taken about
seventy more power-on resets than its siblings, which is a **power integrity**
fault on that channel and is a different and more serious failure than CAM3's
load-dependent `shortRead` excess. CAM3's counter is normal, so CAM3 is not
power-cycling.

**So the order changes:**

### TEST 0 — CAM1 power path, before anything else

Reseat CAM1's USB feed and its JP1 supply and ground. Change nothing else. Then
`cam_reliability.ps1 -Config 'C1-power-reseat'` and, separately, read the node
session counter again after an hour of streaming: it should not advance at all.

- Counter stops advancing → the reseat fixed it; confirm over a longer soak.
- Counter keeps advancing → substitute that node's power path (different USB
  port and cable, then a different JP1 run) one change at a time.

A reset counter differential of 85 against 11 is diagnosable by substitution in
one step, and it should be closed before any timing or reliability measurement
is trusted: while CAM1 was wedged, the other three channels accumulated
`shortRead` drops fast, and with CAM1 healthy a 122 s window measured zero
drops of any kind on all four. **One wedged channel contaminates the whole
bank**, so every configuration in this document must be run with all four
channels healthy or the comparison means nothing.

### Then the CAM3 sequence below

Unchanged, and note the control condition is now camnode **0.4.38** on all
four rather than 0.4.31 - identical across the four, which is what the matrix
needs.

## The rules

- **One variable per configuration.** A swap that moves two things measures
  nothing.
- **Do not flash a node to test hardware.** All four are on camnode **0.4.38**
  and that is the control. If a node must be reflashed for an unrelated reason,
  the configuration before and after are not comparable and both need a run.
- **All four channels must be healthy for a run to count.** Measured: while one
  channel was wedged the other three accumulated drops fast, and with it back a
  122 s window gave zero drops on all four. Check `online` and the node session
  counters before starting, not after.
- **Never open a node's USB serial port.** On the XIAO's native USB CDC the
  host's line-state change at open resets the part; that already happened once
  on this bench and reset three nodes. Diagnose through the P4.
- **Power off the body before any swap.** Label what moved.
- Record the configuration name in the run, so the evidence and the hardware
  state cannot drift apart.

## The measurement, once per configuration

```powershell
& cam_reliability.ps1 -Config '<name>' -StreamMinutes 10 -Shots 100
```

10 minutes of live viewfinder with no captures, then 100 grouped captures. It
reports per camera: preview frames, `shortRead` / `oversize` / `noLink` /
`decode` drops, UART timeouts, retries, CRC errors, capture frames delivered,
frame errors, offline samples, node boot reason and rx monotonicity. Counters
come from `GET_CAMERA_INFO` and `CAMERA_LINK_STATS`; nothing is inferred from a
log line.

`C0-as-is` is already recorded and is the baseline every configuration below is
compared against.

## The sequence

Stop at the first configuration that clears CAM3, and record it.

### TEST A — reseat only

Reseat the CAM3 camera ribbon at both ends. Change nothing else: same XIAO,
same P4 UART, same module, same connector.

- CAM3 clears → **intermittent contact at the ribbon seat.** Reseat the other
  three as preventive work and re-run once to confirm it holds.
- CAM3 unchanged → continue.

### TEST B — camera and ribbon swap

Swap the CAM3 OV3660 module *with its ribbon, as one assembly* against a
known-good position, say CAM1. Everything else stays: the XIAO that was on
CAM3 stays on CAM3, the P4 UART assignments are untouched.

- The fault **follows the assembly** to CAM1 → candidate **C or D**. Split them
  by swapping only the ribbon next; if the fault stays with the module, mark
  the OV3660 module suspect and replace it.
- The fault **stays on CAM3** → the module and ribbon are exonerated; continue.

### TEST C — XIAO swap

Swap the CAM3 XIAO against a known-good position, carrying nothing else with
it. The camera assembly stays where it is, so this moves only the node
electronics.

- The fault **follows the XIAO** → mark that XIAO suspect. Note which of its
  parts is implicated is still open (UART pads, the module's own camera
  connector, its 3V3 rail); a second board settles it cheaply.
- The fault **stays on CAM3** → A or E. Continue.

### TEST D — the P4 side

Only reached when the fault stays on CAM3 through a module swap and a node
swap. Then it is the P4's CAM3 path: the UART peripheral, the GPIO pair, the
JP1 pins, or the harness between them.

Cheapest discriminator first, and it needs no soldering: swap the *harness
wires* for CAM3 and CAM1 at JP1, so the P4's CAM3 peripheral drives CAM1's
physical run and vice versa.

- The fault follows the **harness run** → connector or wiring, **E**. Re-crimp
  or replace that run.
- The fault stays with the **P4 CAM3 peripheral** → **A**. Then a P4-side
  firmware experiment is justified and is the one legitimate use of a test
  image here: reassign the CAM3 channel to a spare UART peripheral in
  `board.h` and re-run. If the fault follows the peripheral it is silicon or
  pin choice; if it stays on the pins it is the P4 board.

## Reading the result

CAM3 should stop being a statistically obvious outlier. Given the C0 counts —
4 shortReads against 0, 0 and 1 over 100 captures — a single run cannot
separate a two-fold difference from chance. Where a configuration looks
borderline, run it twice rather than believing it once; the bench is 20 minutes
and a wrong attribution costs a replaced part and the fault still present.

What would make CAM3 *not* a hardware fault at all: if the counts move with the
*position in the capture order* rather than with any swapped part. The P4
triggers and reads the four channels in a fixed order, so the last channel read
carries the most contention. That is a firmware and scheduling question, not a
component one, and the swap matrix will show it as "the fault never follows
anything".
