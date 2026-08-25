# uvc-preview — look at one camera module over USB-C

Bench firmware. It makes a XIAO ESP32-S3 Sense present itself as an ordinary
USB webcam, so a module plugged into a hub can be judged in any camera app with
no harness, no P4, no Wi-Fi and no host tooling. It never ships in a camera.

`camnode` cannot do this job. It serves the node link on UART1 and captures one
JPEG when asked, and a still frame is the wrong instrument for the things that
are actually wrong with a bad module: soft focus, the OV3660's colour cast,
framing, and frames it fails to produce under load. Those are watched, not
sampled.

## Flash one board

```bash
# From the repository root. Docker is the one canonical build environment.
docker run --rm -v "$PWD:/project" -w /project/firmware/uvc-preview \
  espressif/idf:v5.5.1 bash -lc "idf.py set-target esp32s3 && idf.py build"

# Then flash from the host, with the board in download mode (see below).
esptool --chip esp32s3 -p <PORT> write_flash \
  0x0     firmware/uvc-preview/build/bootloader/bootloader.bin \
  0x8000  firmware/uvc-preview/build/partition_table/partition-table.bin \
  0x10000 firmware/uvc-preview/build/kino-uvc-preview.bin
```

### Download mode — read this before you flash

TinyUSB owns the ESP32-S3's single USB PHY while this firmware runs, so **the
USB-C port is a webcam, not a serial port.** A board running uvc-preview will
not appear as a COM port, and `idf.py flash` will not find it.

To get back into download mode: **hold BOOT, tap RESET, release BOOT.** The ROM
bootloader takes the USB PHY back and the board enumerates as a serial device
again. This is the first thing that catches people, and it catches them after
the firmware works, not before.

## Check a module

1. Flash, then plug the board into the hub on its own USB-C cable.
2. Watch the LED. **Three slow blinks** means the sensor answered and the USB
   device came up. A **fast blink that never stops** means the sensor never
   answered — with no console on this port, that blink is the only thing
   telling you so, and re-seating the camera FPC is the usual fix.
3. Open the camera in a viewer. [`viewer.html`](viewer.html) is the one that
   ships with this tool — serve it over `http://127.0.0.1` (getUserMedia needs
   a secure context, and `file://` is not one):

   ```bash
   python -m http.server 8099 --bind 127.0.0.1   # from this directory
   ```

   It picks the module by name, refuses to silently show a different camera,
   and carries the **Measure** button below. It appears as **`UVC CAM1`** — not as the
   `CONFIG_TUSB_PRODUCT` string, because Windows names a camera from the
   video interface descriptor, which the component hardcodes. All four boards
   therefore look identical in the device list, so do them one at a time.

   **Use a Chromium browser — Edge or Chrome, not Firefox.** This device
   offers MJPEG only (uncompressed VGA needs roughly ten times the bandwidth
   full-speed USB has), and Firefox on Windows will not open an MJPEG-only
   UVC device: it fails with `NotReadableError`, which is also what a dead
   module and a busy device look like. Windows Camera, OBS and `ffplay` work
   too, but only one application can hold the device at a time.

   Beware **virtual cameras** — iVCam, DroidCam, OBS Virtual Camera. They
   enumerate whether or not anything is behind them, they are often first in
   the list, and one with no source fails with the same `NotReadableError` as
   a broken module. Pick the device by name, never by position.
4. Look for, in this order:
   - **A picture at all.** No picture with a healthy LED is a USB or host
     problem, not a module problem.
   - **Colour.** A strong pink, magenta or green cast across the whole frame is
     the classic sign of an OV3660 that came up with the wrong register set.
     Note it — it is a firmware conversation, not a dead module.
   - **Focus.** These are fixed-focus modules. Check a target about a metre out
     and then something close. A module that is soft everywhere is soft
     everywhere; that is the module, and it will be soft in the camera too.
   - **Framing.** All four modules must see the same field of view. One that is
     visibly tighter or wider is a different lens, however identical the label.
   - **Dead pixels and blemishes.** Cap the lens: the frame should be black,
     not speckled. Point at a white wall: no blotches.
5. Close the viewer. The board logs the run to UART0 — frames, elapsed time,
   frames per second and the count of empty frame buffers. Read it with a
   USB-serial adapter on GPIO43/44 if you want the numbers.

Record the result per board in Studio's Bring-Up worksheet under **CAMERA
MODULE INCOMING CHECK**, and label each physical module. Which module ends up
as CAM1..CAM4 is decided by the harness, but *which module is which* has to
survive the trip to the harness.

## Measure, do not squint

The viewer's **Measure** button reads 40 frames and prints numbers, because the
three things that go wrong here are all statistical and none of them can be
judged from a screenshot:

```
640x480  6.0 fps | levels R 82.2 G 88.5 B 81.6 | neutral error R -2.2% G 5.2% B -2.9%
                 | artifact 0/40 frames | temporal noise 0.78
```

- **artifact N/40** counts frames carrying a chroma-damaged column, scored
  against each column's own neighbourhood so a green subject does not register.
  This is the only honest way to tell a corrupt frame from a sensor defect: a
  real column defect sits at a fixed x in every frame, corruption wanders
  within a zone and changes colour between frames.
- **neutral error** is a white-balance figure **only against a neutral, well-lit
  subject**. Fill the frame with a white wall. A grey shirt close up measured
  mean level 9 of 255 — essentially black — and its channel ratios were
  black-level offsets, not colour.
- **temporal noise** is frame-to-frame difference over a centre patch, so it is
  a noise figure only if the scene is still. It rises in dim scenes because
  gain rises; that is physics, not a fault.

Levels and neutral error are scene dependent, so compare runs only against the
same target. Repeat the measurement several times before believing it: the
frame corruption below read 0/40 twice and then 30/40 on an unchanged build.

## What the numbers mean

The stream closes with a line like:

```
stream closed: 412 frames in 27440 ms (15.0 fps), 0 empty
```

- **fps at or near the configured rate** with **0 empty** is a healthy module.
- **Empty frame buffers climbing** means the sensor or the DVP bus is
  struggling. Suspect the FPC seating and the XCLK before the sensor.
- **fps well under the rate with no empty buffers** is the USB link, not the
  camera. The S3 is full-speed only (12 Mbit/s), which is why this build
  defaults to VGA at 15 fps rather than the component's 720p.

## Findings worth not rediscovering

**XCLK 20 MHz corrupts frames on this sensor.** 77 of 160 frames (48%) carried
a damaged band in a fixed ~12-pixel zone around x=498, JPEG MCU column 31. At
16 MHz, 1 of 200 (0.5%). `board_xiao_s3.h` now carries 16 MHz with the
measurement; the residue is upstream
([esp32-camera#244](https://github.com/espressif/esp32-camera/issues/244)) and
the next lever is the OV3660 PCLK register fix in
[#220](https://github.com/espressif/esp32-camera/issues/220). This is a product
finding: `camnode` captures over the same bus and was set to the same 20 MHz.

**The OV3660 ships over-saturated.** Espressif's own example sets
`saturation -2` for this part. Raising saturation instead turns a slight green
bias into grey-reads-olive: measured G +1.9% untuned, +6.6% to +12.0% with a
saturation lift, +5.2% at -2. Do not copy that example's `vflip` — it is there
for how the sensor sits on an AI-Thinker board, and on the XIAO Sense the frame
arrives upright already.

**A board that will not take a flash may be write-protected.** Three flashes in
a row silently did nothing: `write-flash` reported success, `MD5 of file does
not match data in flash` followed, and an 8 MB chip erase claimed to finish in
0.0 seconds. `esptool read-flash-status` returned `0x001c` — block-protect
bits BP0-BP2, whole chip protected. `write-flash-status --non-volatile --bytes 2 0`
cleared it. **Check `read-flash-status` first** whenever a write verifies wrong;
the failure mode is a board that looks dead, with no LED and no USB, because the
bootloader is refusing a corrupt image.

**Do not put the UVC transfer buffer in PSRAM.** USB DMA streams out of it and
reads corrupt from PSRAM: the artifact count went from 0/80 to 40/40. It stays
in internal RAM.

**Getting back into download mode:** hold BOOT, unplug, replug while still
holding, release. Tapping RESET while holding BOOT is fiddly on these buttons
and frequently boots the app instead. Or hold BOOT and replug into **console
mode** (below), where the serial port stays available.

## Console mode — reading the device's own log

Hold **BOOT** while the board powers up and it skips UVC entirely, keeps the
USB-Serial-JTAG port, redirects `ESP_LOG` onto it, and reports what each
captured frame actually is:

```
idf.py -p <PORT> monitor      # or any serial terminal at 115200
```

It prints the sensor identity and every setter this model does not implement,
then per-frame JPEG sizes and a **SOI/EOI check performed on the device**, before
USB has touched the data. That is the difference between "the host sees a
corrupt frame" and "the sensor produced one". Normal operation has no serial
port at all, which is why a whole debugging session was spent inferring
firmware behaviour from rendered video.

## Configuration

Resolution, frame rate and the USB product string are in
[`sdkconfig.defaults`](sdkconfig.defaults), with the reasoning beside each. The
descriptors also offer the larger sizes, so a host may request more than the
default; `on_stream_start` honours whatever it asks for.

Every GPIO comes from camnode's `board_xiao_s3.h`. This app does not define a
single pin of its own — one file owns the XIAO pin map, and a bench tool
disagreeing with the product firmware about a pin would be worse than useless.
