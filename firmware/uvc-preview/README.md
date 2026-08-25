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
3. Open the camera in any viewer. It appears as **KINO D4 camera preview**.
   Windows Camera, QuickTime, OBS, `ffplay`, or a browser page calling
   `getUserMedia` all work.
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

## Configuration

Resolution, frame rate and the USB product string are in
[`sdkconfig.defaults`](sdkconfig.defaults), with the reasoning beside each. The
descriptors also offer the larger sizes, so a host may request more than the
default; `on_stream_start` honours whatever it asks for.

Every GPIO comes from camnode's `board_xiao_s3.h`. This app does not define a
single pin of its own — one file owns the XIAO pin map, and a bench tool
disagreeing with the product firmware about a pin would be worse than useless.
