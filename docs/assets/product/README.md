# Product media

Three kinds of file belong here, and each is labelled so nobody has to guess which they are looking at.

**Captures of the running application.** A screenshot of Studio, Twin or Roll actually running. If the data behind it came from the simulator or the test uploader rather than a camera, the filename says `demo` or `simulated` and so does the caption.

**Firmware screen renders.** The camera's own screens, drawn by the firmware's own code on a workstation. Named `firmware-*-render.png`. These are not photographs of the panel and the caption must say so. Regenerate them with

```bash
make -C firmware/p4/host_preview && firmware/p4/host_preview/preview out/
```

which writes 190 screens as PPM, including the failure states and the frames of every transition. Convert the ones you need to PNG:

```bash
sips -s format png firmware/p4/host_preview/menu.ppm --out docs/assets/product/firmware-menu-render.png
```

The renderer is also a gate: it exits non-zero if any screen sets type outside the page margin, so a render that came out of a passing run is a render whose type is inside its own margins.

**Photographs of the hardware.** None yet. The shot list is below.

## Current assets

| File | What it is | Captured |
|---|---|---|
| `firmware-menu-render.png` | The D4 home screen: the SHOOT card and five rows, 800 × 480 | 2026-09-20 |
| `firmware-boot-field-render.png` | The boot field, all four cameras answering | 2026-09-20 |
| `firmware-boot-field-two-silent-render.png` | The same body with cameras 2 and 4 silent | 2026-09-20 |
| `firmware-look-render.png` | LOOK: the recipe, what it does at capture, and its three modifiers | 2026-09-20 |
| `firmware-roll-active-render.png` | The ROLL screen: QR, code, connection word, count | 2026-09-20 |
| `firmware-about-render.png` | ABOUT: the unit, the four cameras, and the studio | 2026-09-20 |
| `roll-feed-demo.png` | Roll guest feed at 1280 × 800, 12 test-uploader captures | 2026-09-09 |
| `roll-photo-demo.png` | Roll photo page at 1280 × 800, same captures | 2026-09-09 |
| `studio-connected.png` | Studio connected to Twin | 2026-08, **stale** |
| `twin-workbench-demo.png` | Twin at 1280 × 800, simulator powered on | 2026-08, **stale** |

The firmware renders were all retaken on 2026-09-20, the day the interface stopped being a Windows 98 shell. The previous pair showed four-tone bevels, a navy title bar, six icon tiles and 1-bit Tahoma; none of that is in the product any more, so they were replaced rather than kept as history. The four new files are screens the old set had no equivalent of.

**The boot pair is one picture in two states, and the pairing is the point.** The field's reach is how many of the four cameras have answered, a quadrant each; its colour is the look the camera will shoot with. Showing only the healthy one would make it look like decoration. Both come from `boot_field_all_four` and `boot_field_two_silent`, which exist in the renderer for exactly this reason.

The two marked stale predate work that changed what they show. Recapture them the way the Roll pair was recaptured: `npm run dev:all`, then drive a browser at 1280 × 800. They are not wrong enough to pull, and they are not current.

The Roll pair was recaptured on the day the tile geometry was repaired — the previous versions showed a flat four-column grid with `40 min ago` under every tile, which is two UI generations old.

### What the test uploader's frames look like

A flat colour field with a white bar that shifts position between the four frames. That is deliberate: it makes parallax visible and makes a wrong frame order obvious. It is not a photograph and it does not pretend to be, which is why every caption on those files says demo.

## Physical shot list

Still needed, and only a real camera can produce them:

| Filename | Required content |
|---|---|
| `d4-front.jpg` | Straight front view, the four lenses and the sliding cover visible |
| `d4-back.jpg` | Display, controls, ports, and something for scale |
| `d4-internals.jpg` | Open body with labelled boards, battery and harness routing |
| `d4-camera-bar.jpg` | Lens spacing and how rigidly the row is mounted |
| `real-wiggle.gif` | A genuine four-camera capture, with consent from anyone in it |

`d4-front.jpg` used to ask for the flash. There is no flash: `ECN-0003` dropped the assembly and gave its enable pin to the shutter, so do not go looking for one to photograph.

Do not commit empty placeholders or generated product photography.

## Capture rules

- Strip EXIF location and device-owner metadata.
- Remove serial numbers, Wi-Fi names, tokens, and private Roll details.
- Get consent from every recognisable person.
- Keep originals outside the repository; commit a sensibly sized derivative.
- Say whether a result came from D4 hardware, KINO Twin, the Studio simulator, or a firmware render.
- Preserve aspect ratio. Do not stretch a logo or a UI capture.
