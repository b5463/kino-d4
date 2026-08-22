# KINO Twin acceptance

Build both applications, then serve them from one origin:

```text
npm run build
npm run preview:all
```

Open `http://localhost:4400/dev/twin/` and `http://localhost:4400/studio/` in separate tabs. Keep this checklist blunt: record PASS, FAIL, or BLOCKED with evidence for every line.

- [ ] Open KINO Twin and confirm the D4 V1 scene renders without the recovery screen.
- [ ] Inspect components and confirm dimensions and provenance are visible.
- [ ] Change camera pitch and lens-FOV scenario; confirm the camera row and overlap change.
- [ ] Power on Twin; connect Studio with CONNECT KINO TWIN.
- [ ] Confirm HELLO, DEVICE_INFO, CAPABILITIES, and CONFIG_SCHEMA complete through KDP.
- [ ] Configure Wiggle, Quad, and looks in Studio.
- [ ] Perform a four-camera capture.
- [ ] Confirm boot, exposure, UART, SD, and transfer changes appear in Twin's 3D scene.
- [ ] Run the Studio UART stress test and exercise slow-uart and crc-noise faults.
- [ ] Run Skew Bench and compare separate GPIO, VSYNC, and effective-exposure rows.
- [ ] Browse the large simulated gallery without an unbounded load.
- [ ] Exercise Roll connectivity loss, recovery, and upload backlog.
- [ ] Run firmware update UX and confirm target progress and reboot visuals.
- [ ] Set CAM3 offline and confirm Studio diagnoses CAM3 through KDP.
- [ ] Exercise batterySag and fuseBlown; confirm power warnings.
- [ ] Record, save, import, replay, and verify the exact scenario.
- [ ] Enter a real measured override; confirm MEASURED, refreshed geometry, and refreshed collision findings without application-code edits.

## WebSocket bridge (cross-machine Studio)

BroadcastChannel reaches only same-origin tabs. To serve this Twin to a Studio in another browser, container, or machine (issue #29):

```bash
npm run twin:relay                       # dumb message bus on ws://127.0.0.1:5179
# KINO_TWIN_WS_HOST=0.0.0.0 for LAN use — no auth, trusted networks only
```

Open the Twin with `?ws=1` (default relay on this host) or `?ws=ws://host:5179`; open Studio with `?twinWs=ws://host:5179` and its connect screen offers CONNECT KINO TWIN (BRIDGE). Transport only: the wire vocabulary, handshake, busy and close semantics are the same `TwinBusTransport` state machine the BroadcastChannel carrier uses, and `TwinDeviceServer` is unchanged.

## Deliberately deferred

- Tier A GLB import of the official XIAO STEP. Convert offline through FreeCAD/Blender and drop the GLB into `@kino/three-assets`; application code must not change.
- (shipped in #31) Front-panel DXF, transform CSV, and envelope STEP live in the RECORD tab beside the other engineering exports; the DXF lens-cutout diameter stays PROVISIONAL until a lens barrel is measured.
- Playwright end-to-end automation. The same-origin manual script above remains the browser/WebGL acceptance gate.
