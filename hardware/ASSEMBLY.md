# D4 V1 assembly

This is the intended build order for a bench prototype. Stop at each checkpoint. A later stage assumes the earlier measurement was recorded.

## Tools

- current-limited bench supply;
- digital multimeter;
- oscilloscope or logic analyser for UART and sync work;
- temperature probe or thermal camera for the flash and power path;
- calipers;
- soldering and rework tools suited to the carrier;
- eye protection and a non-flammable LiPo work surface.

## 1. Record the loose parts

Check every line in [`BOM.csv`](BOM.csv). Photograph both sides of each board beside a scale. Record exact markings, connector orientation, and measured dimensions. Seller photos do not settle the part you received.

Reject a swollen, punctured, hot, or damaged LiPo. Keep its leads insulated while working.

**Checkpoint:** the component manifest identifies the actual parts on the bench and every unresolved dimension remains marked unresolved.

## 2. Dry-fit the mechanical stack

Arrange the display module, battery, power board, carrier, speaker, flash thermal stack, and camera bar without wiring them. Check USB-C access, microSD access, ribbon bend radius, battery lead exit, and service access to connectors.

The acrylic panels are skins and windows. The PETG skeleton carries the camera bar and fasteners.

**Checkpoint:** no board or pouch is forced into the provisional 126 × 80 × 36 mm envelope.

## 3. Build the protected power path

Install the F3A fuse near battery positive, then the 1S protection board and SW6106 module. Use 20 AWG silicone wire for the main path. Keep exposed battery conductors short and insulated.

Leave the display, cameras, and flash disconnected. Power from a current-limited bench supply first. Verify polarity and the unloaded 5 V rail.

**Checkpoint:** record input voltage, rail voltage, idle current, and protection behavior.

## 4. Bring up the main controller

Connect the display module and its ribbon with pin 1 visible. Keep both USB-C ports and the microSD slot accessible. Confirm stable boot, touch input, storage detection, and USB communication before adding camera loads.

**Checkpoint:** Studio can connect, identify the main unit, and read power and storage status without resets.

## 5. Build one camera channel

Assemble one high-side switch and one PH2.0 camera harness. Check MOSFET orientation, NPN pinout, diode direction, pull resistors, UART crossover, and connector polarity.

Fit one XIAO ESP32-S3 Sense to the rigid camera bar. Power-cycle it through the P4-controlled channel. Establish UART communication before adding shared sync.

**Checkpoint:** CAM1 can power on, identify its sensor, answer repeated requests, capture one frame, and power off cleanly.

## 6. Replicate the camera channel

Build CAM2 through CAM4 from the proven channel. Label every harness at both ends. Mount the lenses at the current 22 mm default pitch, keeping the bar adjustable from 20 to 24 mm until the optical setup is measured.

Bring up each camera alone, then all four together. Record rail sag and boot behavior.

**Checkpoint:** all four cameras remain addressable during repeated status reads and parallel transfers.

## 7. Add shared sync

Route one 28 AWG sync branch to each camera node. Keep this line separate from the four-pin UART and power harnesses. Verify the edge at every node with a scope or logic analyser.

Run the sync bench. Record GPIO distribution, VSYNC phase, and effective exposure separately. A tight GPIO result does not pass exposure alignment.

**Checkpoint:** at least 250 triggers complete with the three timing fields reported or explicitly unavailable with reasons.

## 8. Add controls, storage, and sound

Install the tactile switches, mode slide switch, speaker, and final microSD card. Exercise every control in Studio or firmware diagnostics. Format and destructive storage tests require an expendable card.

**Checkpoint:** the self-test and a complete capture-to-card cycle pass without loose connections or unexpected resets.

## 9. Add the flash last

Assemble the LED star, 0.5 mm thermal pad, 20 × 20 × 7 mm copper heatsink, diffuser, and constant-current driver. Set the driver to 350 mA before connecting the LED. Confirm the P4 only controls enable.

Begin with short pulses. Record rail sag, LED current, heatsink temperature, nearby plastic temperature, and recovery between flashes. Do not test 500 mA until the 350 mA record is stable.

**Checkpoint:** the flash test completes without rail collapse, thermal damage, banding claims, or resets.

## 10. Close the enclosure

Add strain relief, insulation, service loops, and labels. Confirm the fuse, battery connector, microSD card, and USB ports remain serviceable. Keep screws and sharp printed edges away from the LiPo pouch.

Run the final acceptance sheet in [`TESTING.md`](TESTING.md) after the enclosure is closed. Thermal and radio behavior can change after the open-bench test.
