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

## Deliberately deferred

- WebSocket development bridge. BroadcastChannel is the supported same-origin path for Twin 0.1.
- Tier A GLB import of the official XIAO STEP. Convert offline through FreeCAD/Blender and drop the GLB into `@kino/three-assets`; application code must not change.
- Front-panel DXF, transform CSV, and STEP exports. Twin 0.1 exports layout JSON and engineering text/JSON reports.
- Playwright end-to-end automation. The same-origin manual script above remains the browser/WebGL acceptance gate.
