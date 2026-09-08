# KINO D4 Mainboard Rev 1.0 release checklist

No checked box may rely only on a render, vendor listing or unrecorded bench
observation. Attach the evidence record, instrument setup and unit serial.

## Gate A — architecture to detailed schematic

- [x] Measured Guition JP1 table reconciled with ECN-0002 and ECN-0003.
- [x] Four UART directions and XIAO GPIO43/GPIO44 endpoints recorded.
- [x] SYNC source GPIO32 / JP1 pin 19 recorded.
- [x] GPIO35 / JP1 pin 15 marked do-not-connect.
- [x] First-pass typical, capture, conservative and source budgets calculated.
- [x] Preferred PD/charger/boost topology documented with trade-offs.
- [x] Independent camera control route defined without consuming another P4 GPIO.
- [ ] Production battery datasheet and PCM limits received.
- [ ] Battery TEMP resistance and curve measured/identified.
- [ ] Guition/camera current ladder measured on assembled hardware.
- [ ] Existing Guition I2C addresses, pull-ups and cable capacitance measured.
- [ ] Preferred major ICs checked against PCBWay part/assembly capability.

Gate A status: **OPEN**. Detailed sheet capture may proceed provisionally, but
charger TS values, final current limits and protection parts cannot be frozen.

## Gate B — schematic release

- [ ] All important parts have exact manufacturer and MPN.
- [ ] STUSB4500 PDO/NVM image, checksum and programming method released.
- [ ] BQ25798 autonomous defaults and host configuration table released.
- [ ] Cell charge voltage/current and JEITA thresholds match the cell datasheet.
- [ ] Battery protection/PCM coordination and reverse-polarity behavior reviewed.
- [ ] 5 V regulator calculations cover battery minimum, 4 A rail and thermal derating.
- [ ] USB 5 V default/1.5 A/3 A and 9 V/2 A behavior reviewed.
- [ ] Every I2C address and reset/default state reviewed.
- [ ] Every connector pin and cable direction independently reviewed.
- [ ] Per-camera ILIM and bulk capacitance selected from measured inrush.
- [ ] Hardware forced-off timing worst case remains within 8–10 s.
- [ ] ERC passes with no unexplained exclusions.

## Gate C — placement and layout release

- [ ] Enclosure datum and maximum component heights imported.
- [ ] Final board outline, cut-outs and keep-outs approved.
- [ ] Mounting holes and fastener keep-outs approved.
- [ ] USB-C and side-switch opening/actuator drawings approved.
- [ ] Battery, P4 and camera harness bend radii reviewed in 3D.
- [ ] High-current and thermal placement reviewed before signal routing.
- [ ] L2 is a continuous ground plane; unavoidable splits reviewed.
- [ ] Pours and via arrays meet the verified current/temperature target.
- [ ] All current shunts use Kelvin routing.
- [ ] UART and sync paths have uninterrupted ground reference and branch test pads.
- [ ] Bottom-side pogo field is accessible in the fixture and enclosure.
- [ ] DRC passes with no unexplained exclusions.

## Gate D — manufacturing release

- [ ] Schematic PDF and PCB 3D review signed off.
- [ ] Gerbers, drills, IPC/netlist where required, BOM and CPL regenerated together.
- [ ] Fabrication and double-sided assembly drawings generated.
- [ ] Pin-1, polarity, connector, test point, revision and product markings verified.
- [ ] `KINO D4`, `MAINBOARD` and `REV 1.0` are visible in silkscreen.
- [ ] Serial-number and QR/UID areas are readable after assembly.
- [ ] PCBWay DFM/assembly review closed.
- [ ] Pricing recorded at 5, 20, 50 and 200 units with date and substitutions.
- [ ] Golden manufacturing archive checksum recorded.

## Gate E — Rev 1.0 validation

- [ ] Unpowered polarity, resistance and isolation checks pass.
- [ ] Current-limited bench bring-up passes unloaded, P4-only and one-camera steps.
- [ ] USB attach/detach is stable at 5 V fallback and 9 V PD.
- [ ] Operate-and-charge behavior passes at typical and capture loads.
- [ ] Four independent camera power cycles and fault isolations pass.
- [ ] Four UARTs pass concurrent 921600-baud soak with recorded error counts.
- [ ] SYNC master and four branches meet measured edge/skew target.
- [ ] Fuel gauge, total current and four branch currents correlate to instruments.
- [ ] Software shutdown completes storage writes before power removal.
- [ ] Frozen-P4 8–10 s hold forces hardware shutdown.
- [ ] Closed-enclosure thermal test and battery connector temperature pass.
- [ ] Five-unit validation build issues are closed before the 20-unit pilot.
