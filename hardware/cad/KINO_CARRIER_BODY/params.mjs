// KINO D4 carrier body: every number the geometry reads, and the stack chain
// derived from them once. Millimetres.
//
// Body frame: X right and Y up as the camera is seen from the FRONT (lenses
// toward the viewer), Z toward the viewer. Z = 0 is the back face of the P4's
// PCB, so the display sits at negative Z and the lenses at positive Z.
//
// The carrier (hardware/pcb/kino-d4-dev-carrier/design/placement.py) is drawn
// in the P4 frame, x right and y DOWN as the front face is read. The two frames
// meet at the carrier's own outline: X = x - EDGE.x1 = x + 0.695, and
// Y = EDGE.y2 - y = 70.105 - y. The figures below are restated in the body
// frame by hand; an independent statement of the same measurement is worth
// more than a shared constant, and the gates re-add the chain every build.

export const P = Object.freeze({
  // ---- The carrier D1, the chassis of this body ----------------------------
  carrierW: 118.40,
  carrierH: 70.80,
  carrierR: 3.0,             // outline corner radius
  carrierT: 1.6,
  carrierClear: 0.5,         // per side in the cavity: the stack slides in from the rear; 54 mm walls bow, so 0.3 wedged on paper. The shrink itself is the slicer's (shrinkPct)
  shrinkPct: 0.2,            // MEASURED on T01 (2026-11-21): the 100.0 mm bar printed 99.8 uncompensated, 99.9 on the second plate. Set in the slicer as compensation; the model is never scaled
  // The four M2 holes, on the P4's insert pattern (61.9 x 54.8), 8.0 mm from
  // the carrier's top and bottom edges. H1 H2 top, H3 H4 bottom. The body
  // uses them for nothing: the dummy carries the standoffs and the carrier's
  // own pan heads, so the ledge is gated clear of them.
  carrierHoles: [[18.95, 62.80], [80.85, 62.80], [18.95, 8.00], [80.85, 8.00]],
  carrierHead: [3.8, 1.3],   // the carrier's M2 pan head, D x H (DIN 7985), on its front face at each hole
  // The ledge: a step in the cavity at the carrier's front face, every
  // side, on which the carrier's edge lands. Nothing on the carrier's front
  // face is within 4.3 mm of its edge (J1001 at the right is the nearest),
  // and the P4 is 2.0 inside the carrier's outline, so behind the ledge the
  // cavity is full width down to the glass and the stack still slides in
  // from the rear. The owner's rule after the first prints: no M2 anywhere
  // in the body's hold, neither the carrier's heads nor screws of its own.
  ledgeW: 2.0,               // 1.5 of bearing with the carrier pushed 0.5 to one side
  carrierEdgeKeepOut: 4.0,   // the nearest front-face part to the carrier's edge, gated against the ledge and the clearance
  // Camera stations: the XIAO socket centres, 22 mm pitch, 9 mm left of the
  // board centre so CAM 4 clears the USB window.
  cameraXs: [17.195, 39.195, 61.195, 83.195],
  socketCentreY: 35.40,
  // The OV3660 head sits 6.95 mm from the board centre toward the pin-7 end,
  // which on the carrier is the LOWER end (pin 1 and the XIAO's USB-C are at
  // the top). So the lens row is below the socket row.
  lensOffsetY: -6.95,
  // The carrier's window over the P4's two USB-C ports (plugs come through it
  // from the front). Body frame.
  usbWindow: [92.295, 26.205, 99.395, 49.705],
  // The carrier's own USB-C (J1000), on the back face, opening over the
  // bottom edge. Centre X, shell height, plug overmold.
  usbCX: 109.695,
  usbShellH: 3.26,
  usbPlug: [12.4, 6.5],      // overmold width x height
  usbPlugClear: 0.5,         // per side
  // The carrier's front-face connectors, for the dummy and the pod gate
  // (placement.py, restated in the body frame): J1001 (XH 6-way, rot 270),
  // J103 and J101 (XH 2-way, the shutter lead's target) and the four JP
  // links, each as [x0, y0, x1, y1, height].
  frontParts: [
    [108.3, 38.4, 114.1, 55.9, 7.0],   // J1001
    [34.75, 10.2, 42.65, 15.95, 7.0],  // J103
    [49.8, 9.2, 55.6, 17.1, 7.0],      // J101
    [3.7, 49.3, 8.7, 51.9, 6.0], [25.7, 49.3, 30.7, 51.9, 6.0], [47.7, 49.3, 52.7, 51.9, 6.0], [69.7, 49.3, 74.7, 51.9, 6.0],   // JP200 to JP500
  ],
  // The three edge LEDs on the back face at the bottom edge (PWR CAM FLT, X
  // 87.7, 93.7, 99.7) are NOT shown through the wall: three slots there did
  // nothing for the body (the owner, 2026-11-21), and the screen carries
  // status. They are read with the frame off.
  usbOpenR: 1.0,             // the USB opening's corners: a plain opening, no gable (the gable was a house on the bottom wall)

  // ---- The battery bay: the layer between the P4 and the carrier ----------
  // The owner's placement (2026-11-20). In plan the bay is what the four
  // spacers leave between them, 1 mm clear of each: 56.4 x 49.4 mm. In height
  // it is the spacer layer less the carrier's back-face parts under it
  // (nothing taller than an 0805 in this rectangle: 1.25 mm plus solder) and
  // the P4's module can. A 505573 pouch (55 x 73) does not fit this plan in
  // either orientation; the cell has to be a 50 x 50 class.
  batteryBay: [21.7, 10.7, 78.1, 60.1],   // body frame
  carrierBackPartsH: 1.5,
  p4CanH: 3.5,                 // PROVISIONAL: the ESP32-P4 module can on the P4's back
  cellT: 5.0,                  // the cell this bay is gated for, plus 0.5 mm of foam
  cellFoam: 0.5,
  cellSwell: 0.5,              // 10 % of the cell, gated: a swelling pouch must not lift the P4 off its spacers

  // ---- The P4 module -------------------------------------------------------
  p4W: 114.40,               // the bare module, spec p.6
  p4H: 66.80,
  p4Inset: 2.0,              // inside the carrier outline, every side
  // The owner measured the P4 with its screen, the standoffs and the bare
  // carrier (no sockets, no XIAOs) at 17.5 mm, glass front to carrier
  // front. With the inserts and the standoffs as measured, that leaves 4.6
  // for the module itself; the official CAD's 13.8 included something that
  // is not on the bench. A gate re-adds the four terms to the measurement.
  glassToCarrierFront: 17.5, // MEASURED: P4 + screen + standoffs + carrier, no headers
  p4T: 4.6,                  // PCB back to display glass front: DERIVED, 17.5 - 1.6 - 8.0 - 3.3 (the split between module and standoffs is the bench's to confirm)
  p4InsertH: 3.3,            // the brass inserts stand this far off the PCB back (MEASURED)
  activeArea: [93.60, 56.16],
  windowMargin: 1.0,         // per side beyond the active area

  // ---- The stack, the owner's decision -------------------------------------
  spacer: 8.0,               // M2 spacers on the inserts; the J100 socket floats 0.3 off home
  socketH: 8.5,              // the XIAO female headers' insulator
  xiaoHeaderInsulator: 2.5,  // PROVISIONAL: the soldered male header's insulator under the XIAO
  xiaoBoardT: 7.6,           // XIAO + Sense boards, back face to Sense top (MEASURED)
  camStackH: 15.0,           // XIAO back face to the lens's front face, Seeed's assembled figure
  xiaoBoardW: 17.8,
  xiaoBoardH: 21.0,
  camModulePcb: [15.5, 17.9],
  camModulePcbT: 3.5,
  camBody: 7.9,              // the head square, SET BY THE GAUGE (T02, 2026-11-21): the 8.1 pocket "fits perfectly", 7.8 and 8.4 did not; with camBodySlack the pocket is 8.1. The first T02 (8.7) was "extremely loose"
  camBodySlack: 0.20,
  camGaugePockets: [7.8, 8.1, 8.4],   // T02's three pocket widths (ribs the same): a sizing gauge, one print answered: 8.1
  camPocketCornerRelief: 0.5, // round reliefs in the pocket corners: a printed inside corner has its own radius and an 8.5 mm square head hits it before the ribs
  camRibProud: 0.30,         // triangular crush ribs, 0.8 wide at the wall: two extrusion lines, prints every time (0.4 mm round columns did not)
  camRibBase: 0.80,
  camRibSpan: [0.2, 0.8],
  camBarrelD: 7.0,
  lensBoreD: 7.5,            // 7.1 around a 7.0 barrel on the first layer, less the elephant foot, did not pass; the bore is hidden behind the face
  lensBoreChamfer: 0.4,      // at the plate's front, the bed side
  platePocketAhead: 1.0,     // plate left in front of the pocket to carry the bore and its 0.4 chamfer; five whole 0.2 layers (thin: 1.6 was a choice, not a need)
  camFovDeg: 78.0,           // design figure; the real field is MEASURE_REQUIRED
  fovMarginDeg: 2.0,
  camPupilBackFromLens: 1.1, // entrance pupil behind the lens's front face

  // ---- The shell -----------------------------------------------------------
  wall: 6.0,                 // carries an M2 insert hole in each rear end: 1.7 of wall outside the hole (1.2 under a groove), 1.3 inside. 4.5 left 0.75 a side, and a boss on the inner face would stand in the carrier's path from the rear (gated: the carrier's sweep). The body grew 1.5 a side for the inserts (2026-11-21)
  plate: 4.4,                // the front plate: pocket depth 3.4 + platePocketAhead
  cornerR: 10.0,             // near the most the plan allows: the carrier's R3 corners sit inside the wall, and at R10 the wall on the diagonal is 2.65 mm (gated)
  frameEdgeR: 1.2,           // the rear frame's outer edge, a 45 degree chamfer toward the rear: chamfers in Z step one layer each and read as the grooves do, rounds in Z terrace (R1.5 at 0.2 stepped 0.77, 0.32, 0.25); rounds stay in plan. The pin holes 1.35 from the outline cap it
  // The body's two joints are screwed: M2 heat-set brass inserts (the
  // owner's kit, 2026-11-21: OD 3.2, lengths 3, 4 and 5) and M2 pan-head
  // screws. The face is screwed from INSIDE the cavity through the plate
  // into inserts in its back, before the stack goes in, so no head shows on
  // the front; the frame is screwed from the rear into inserts in the
  // walls' rear ends, its six heads where the brand's concept draws its
  // rear screws. The twelve filament pins they replace held, on paper, by
  // friction. The stack itself still takes no screw.
  insertOD: 3.2,             // the kit's M2 insert
  insertLen: 3.0,            // the 3 mm insert everywhere: in a 4.2 face it leaves 0.8 ahead (gated); in a wall end it ends short of the first groove
  insertHoleD: 3.0,          // PROVISIONAL: 0.2 under the insert's OD, the usual for PLA and PETG; the kit's own sheet wins. T06 (face) and T04 (wall end) prove it
  insertHoleExtra: 0.4,      // hole depth past the insert, for the melt
  insertMouthSink: 0.3,      // 45 degree countersink at the mouth: the flash the iron pushes up stays under the surface, so the joint seats flat
  insertPullN: 50,           // PROVISIONAL: one 3 mm M2 insert's pull-out in PETG at 2 mm of wall; six against the foam's 16 N
  screwD: 2.0,
  screwClearD: 2.4,          // through the plate and the frame
  screwHeadD: 3.8,           // M2 pan head, 1.3 tall
  screwHeadH: 1.3,
  screwBoreD: 4.4,           // counterbore round the head in the plate's inner face (the head sits flush, under the stack)
  faceScrewLen: 6.0,         // M2 x 6: 4.4 of plate less the counterbore, then the whole insert
  frameScrewLen: 4.0,        // M2 x 4: 1.4 of frame under the head, 2.6 into the 3 mm insert (gated)
  frameBoreD: 4.0,           // counterbore in the frame's rear face: the head 0.7 proud; its edge meets the chamfer's start exactly (gated)
  frameBoreDepth: 0.6,
  // The face's six stations, in the plate's interior where the face is full
  // 4.2 and the plate's inner face is bare: inside the ledge, clear of the
  // camera module PCBs, the signature's engraving, the window, the horizon
  // and the grip. Not a symmetric pattern, but the face goes on one way
  // anyway (the window and the shutter slot say so).
  faceScrewXY: [[4.0, 36.0], [4.0, 50.0], [18.0, 60.0], [95.0, 60.0], [114.0, 50.0], [105.0, 4.0]],   // (4, 36) sits above the left wall's detent channel, in the horizon band (the face is 4.2 there: 0.8 ahead of the insert, gated)
  // The frame's six stations in the walls' rear ends, the hole's axis
  // frameScrewIn from the body's outline (1.7 of wall outside it, 1.2 under a
  // groove, 1.3 inside it toward the cavity; gated as a ring).
  frameScrewsTop: [30.0, 90.0],  // X on the top and bottom walls, clear of the strap tunnels (X 2 to 11 from each end)
  frameScrewsBottom: [40.0, 100.0],  // not the top pair's mirror: turned round, the frame's holes miss the shell's by 2.4 mm (a gate), so it goes on one way
  frameScrewsSideY: 58.0,    // above the thumb pad (Y 18 to 52) on the right and the symbol on the left, below the top strap tunnels
  frameScrewIn: 3.2,         // the axis from the outline: the frame's counterbore edge lands on its 1.2 chamfer's start
  idCap: 5.0,                // cap height of the IDs on the big hidden faces (A01, the coupons)
  idCapSmall: 3.0,           // A03 on the rear, under the thumb pad
  idCapEdge: 2.2,            // A02 in the face's bottom edge wall: 2.6 mm of vertical edge between its two chamfers
  idDepth: 0.4,              // engraved into an up-facing surface in print: two layers at 0.20, four at 0.10
  idDepthWall: 0.3,          // engraved into a vertical wall in print
  idShellAt: [44.3, 35.5],   // A01 on the plate's inner face (up in print) between cells 2 and 3, above the lens row
  idFrameAt: [110.5, 12.0],  // A03 on the rear face (up in print), right border under the thumb pad, between the strap slots and the pad
  idFaceX: 52.0,             // A02 centred here in the face's bottom edge wall (vertical in print), hidden in the 0.3 reveal
  gasketKPa: 25,             // PROVISIONAL: PORON or silicone foam at 35 % squeeze; PE takes a set in a year and the clamp with it
  stackMassG: 130,           // PROVISIONAL: P4 module, standoffs, carrier, four nodes, the cell
  rearFrameT: 2.0,           // 1.2 under the gasket groove; the thumb climbs this to the glass, so its window edge is chamfered for it
  // The P4 is held at the rear without a screw into it: its inserts carry
  // the carrier's standoffs. The frame's inner face stands off the glass
  // front and carries a foam strip in a groove round the window, on the
  // glass's margin; the frame, seated on the wall ends and held by its six
  // pins, squeezes it, so the 114 x 67 module (26 mm past its standoffs in
  // X) is clamped between foam and standoffs, and a rigid PETG frame never
  // touches glass.
  glassClear: 0.4,           // frame's inner face behind the glass front, gated against the module
  gasket: [1.8, 2.0, 2.0, 0.8],  // inset from the window's edge (past the 1.0 chamfer), strip width, foam thickness, groove depth: 2 mm PORON, 2 mm wide (a stock tape width), squeezed to 1.2 (40 %), 25 to 55 % over +-0.3 of stack; the strip's outer edge 0.5 inside the module's edge
  frameWindowChamfer: 1.0,   // 45 degrees, widening toward the rear, so the thumb slides onto the glass's edge targets; 1.0 of frame left at the window's edge
  thumbPadProud: 1.2,        // the thumb pad stands off the frame; grooves cut into it

  // ---- The face: the form lives here, printed back-face down ---------------
  // ODD JOBS in two materials: a black PETG ribbed shell, a dark blue PLA
  // face over the whole front with a chamfered edge, the one blue button,
  // quiet markings. The face covers the plate and the walls' front ends
  // (the concept's v18 front: the fascia fills the front, the dark is the
  // sides and the deck).
  faceBase: 5.2,             // the face plate: its own floor 1.0 under the track, the lips 3.2 (a 3.0 cover and 0.2 of play), the horizon 1.0; 4.2 carried a 2.0 cover that the owner called cheap and that yawed and stuck (2026-11-22)
  faceFloor: 1.0,            // the track floor, the face's own (dark blue PLA): the open stow zone is a tray in the face's colour, and no two-material part is needed for it
  faceEdgeR: 1.2,            // its front edge, a 45 degree chamfer, the frame's own size (2.0 on a 3.2 plate ran over the pin holes' outer edges). A quarter round at 0.2 mm layers terraces; the chamfer steps one layer each, one texture with the grooves. Rounds in plan (R10), chamfers in Z
  faceInset: 0.3,            // the face steps in from the shell's outline: a black reveal line round the blue face; at 0.8 it was a shelf
  // The horizon: a full-width groove across the face at the bar's height,
  // its ends open through the edge round. The bar sits in it; the face is
  // built around the line. The jury's one move.
  horizonPad: 1.5,           // of groove floor above and below the closed bar, so the line shows round it
  // The grip: the horizon's right end, cut deeper, so the middle finger
  // pulls against its left wall. No ribs: ribs are the shell's texture.
  gripX0: 101.0,             // a full groove width of flat floor between the window's right rim and the grip's ramp
  gripD: 2.2,                // the middle finger's wall (2.0 of plate left under it in the 4.2 face); the floor ramps down to it at 45 degrees from the groove floor; 2.0 was a fingertip's edge
  // The model name, "kino D4", engraved on the top deck left of the shutter
  // (the deck is a vertical wall in print, so an engraving there is free).
  modelW: 40.0,              // inside, with the signature: a 0.6 mm stroke engraved at the bed face prints; on a vertical deck it did not
  // Layer texture: V-grooves around the whole body, parallel to the layers in
  // print, the deck included (it is a wall in print too), clear of the
  // shutter collar and the engraving. The body is one thing.
  grooveP: 2.4,
  grooveD: 0.5,              // 0.25 was three layers deep, at PETG's own ripple; these read as ribs
  grooveZ: [-6.6, 37.0],     // the waist on a whole 0.2 layer in print (Z -6.5 fell mid-layer and the V bottomed on a flat); -6.6 - 3 x 2.4 = -13.8 puts the frame joint on the rhythm; the first groove's bottom at -7.2 clears the frame pins' floors at -8.0 by 0.8 of wall
  deckRing: 1.5,             // the deck is grooved whole, one idea carried through; one smooth ring this wide round the shutter collar. The plateau carried a name that is gone, and bare 0.2 layer lines beside deliberate ribs lose the comparison
  // The rear frame: a thumb pad with three half-round ridges on the right
  // border, the ODD JOBS symbol engraved on the left border, cut deep enough
  // to read as shadow (the rear face is up in print).
  thumbPadX: [109.5, 121.0], // the full right border past the window's chamfer: a 20 mm thumb landed on the 1.5 mm step at 9 wide
  thumbPadY: [18.0, 52.0],
  thumbGroove: [1.0, 0.6],   // width, depth: 0.8 wide was two line widths with ragged ends, 0.5 deep was two and a half layers
  thumbPadProud: 1.5,        // with the body's own grooves on it: texture, not a rocker
  symbolRearH: 8.0,
  symbolRearAt: [-1.5, 31.0],
  symbolRearD: 1.0,
  symbolRearBevel: 0.3,      // a 0.4 mm step outside the outline, so the cut reads as shadow
  // The horizon carried round the body: the same groove continues across
  // both side walls from the face's edge to the rear frame (a vertical
  // channel in print, no overhang). The face and the shell share one line.
  horizonWallD: 1.8,         // the LEFT wall only: carried round the right wall the band erased the ribs under the two fingers that hold the camera; the line ends where the hand begins. 1.8 so the channel exposes 1.5 mm of the face's back edge at its front end and 1.8 of the frame's inner face at its rear end: the pry points, a nail lifts either part there (pins and no lever was a knife on the blue)
  horizonChamfer: [0.8, 0.4], // 45 degrees on the groove's upper and lower lips: a flat-floored slot had no highlight and the jury's one move was invisible from the front
  // The cover's window: its X extent is bandX inset by bandChamfer + bandRim
  // (names kept from the sixth cut's lens band), its Y extent DERIVED from
  // the cover's travel.
  bandX: [3.2, 97.2],
  bandChamfer: 1.5,          // with bandRim: the window's inset from bandX (the sixth cut's band is gone; the window kept its place)
  bandRim: 2.0,              // flat rim between the chamfer and the panel
  bandBottomInset: 5.7,      // panel bottom = outline + chamfer 1.2 + this = the sixth cut's 6.9, so the track, the travel and the detents stay where the bench tuned them (re-based when the chamfer changes: at 4.9 the mid-travel probe touched a bump again)
  panelDepth: 3.2,           // the lips' top above the face's floor: the cover 3.0 and 0.2 of play under the lip (16 whole 0.2 layers); 0.4 of play let the 2.0 cover pitch and dig in
  windowChamfer: [0.8, 0.4], // 45 degrees on the window's front edges: the bottom rim 0.8 like the horizon's upper lip, the side rims 0.4 like its lower, so the open stow zone is the second line of a cut tray and the bar sits between two lit edges
  cellSink: 0.8,             // 45 degrees at each cell's mouth in the track floor: a rim, so the four read as eyes and not as a microphone array; prints face-up         // plain cones: the stepped rings read as damage at this size
  // The cover: the field body's bench-tuned track, restated. Drops to open.
  sliderH: 16.5,             // blankets the 7.5 mm cells by 4.5 a side; the lens row sits low, so every mm of cover is a mm of travel (the travel is DERIVED: the window's top rim to its bottom rim, less the cover)
  sliderT: 3.0,              // 2.0 "feels cheap due to the thinness" (the owner, 2026-11-22), and with the 0.4 back chamfer and the 1.5 right bevel it had a 0.1 mm flank on the right: nothing for a detent to hold. At 3.0 the flanks are 1.6 and 1.1 (gated)
  sliderClr: 0.3,            // per side, in X: the walls no longer guide the cover, the rail does (0.1 did, and a bar five times wider than its 10.5 flank is long jams on its walls whenever the thumb lands off centre: three prints, 2026-11-22)
  // The guide: a rail on the tray's floor at the cover's centre, the
  // window's full height, in a groove in the cover's back. The cover is
  // guided over its whole 16.5 on smooth vertical faces, under the thumb,
  // so an off-centre push cannot yaw it; the lips only keep it in. Between
  // cells 2 and 3, the one visible piece of mechanism on the front.
  sliderRail: [1.6, 1.0],    // width x height off the floor
  sliderGroove: [1.8, 1.2],  // in the cover's back, open at both ends: 0.1 a side on the rail, 0.2 over it
  // The rail sits at the middle of the four cells (DERIVED in face.mjs, FACE.railX:
  // 0.005 left of the window's centre). It stood 1.5 right of it as the
  // orientation key, and read as off-centre on the front (the owner,
  // 2026-11-24). No key: the thumb lip and the wordmark show which way up.
  sliderBevel: [1.0, 1.0],   // 45-degree edge bevels, left and right, and the lips that trap them, alike (1.0 and 1.5 left a 1.1 flank on the right)
  sliderLipOver: 0.2,        // each lip is this much deeper than its bevel is wide, so its underside is steeper than 45 degrees in print
  sliderCornerR: 3.0,        // the bar is the thing the eye reads; square corners inside a pill band were the last box on the front
  // The stops and the detents (twenty-ninth cut, 2026-11-24; the owner after
  // a day with the railed T07: the PLA wears, the slide gets "looser and
  // looser", rattles, "at the top it never fully closes" even before the
  // wear, and shaken hard at the bottom "the cover flies off").
  // - The stops are the window's rims, really: closed, the cover's top edge
  //   lies on the top rim; stowed, its bottom edge lies on the bottom rim.
  //   (Both rims stood 0.5 off the cover, so only the detent placed it, and
  //   a detent centred in a notch has no force at its centre: the cover hung
  //   anywhere in its play, and gravity hung it low.)
  // - The springs are PETG and in the cover: an arm at each end of the bar,
  //   cut free by a slit from the bottom edge, flexing in the print plane.
  //   PLA under a standing load creeps and wears; the leaves in the face
  //   were PLA, and their bumps rubbed the cover's flanks over 16 of 19 mm
  //   of every stroke.
  // - The face carries fixed teeth in a channel in each side wall. A bump on
  //   each arm rides free in the channel, clicks over one tooth at each end
  //   of the travel and comes to rest on the tooth's far ramp, still pressed
  //   sliderRestPress: the ramp pushes the cover INTO its rim. Wear eats the
  //   press, not the position, and the bump touches a tooth for about 2 mm
  //   of each stroke.
  // - The lips run the window's whole height on both sides; they broke for
  //   the leaves before, and stowed the cover was held by 3.9 mm of lip a
  //   side. One short gap a side, where the stowed cover's bump sits, lets
  //   the bump past the lip when the cover is pressed in from the front;
  //   the bevels snap under the rest of the lip as they did before.
  sliderArmT: 1.4,           // the arm's width in X, from the cover's edge in: about 3.4 N/mm at the bump in PETG (E 2.0 GPa), a 4.3 N click under the thumb (1.5 was 5.3; the ridges that pressed the flanks were "too tight")
  sliderArmSlit: 1.0,        // the slit inside the arm: room for the 0.5 press with margin, and the 0.7 fold under a lip when the cover is pressed in; 0.6 prints as a gap, the fold needs more
  sliderArmRoot: 14.0,       // the slit's top above the cover's bottom edge: the arm runs from the bottom edge to here, the top 2.5 is rigid
  sliderBumpY: 4.0,          // the bump's centre above the cover's bottom edge, on the straight flank above the R3 corner
  sliderBumpR: 1.0,          // in plan, a round on the arm's flank
  sliderBumpOut: 0.8,        // past the cover's edge line: 0.5 past the wall's face, the press at a tooth's crest
  sliderBumpTop: 1.6,        // above the cover's back; its top 0.5 chamfered 45 degrees in, its foot chamfered 45 degrees to stand inside the wall's face up to the channel's floor
  sliderChannelD: 0.75,      // into the side wall past its face: 0.25 clear of the bump's tip
  sliderChannelFloor: 0.2,   // the channel's floor one layer above the tray's: on the tray's own plane the cuts left non-manifold edges
  sliderChannelTop: 2.0,     // above the floor at the wall's face, where the lip's underside starts; the ceiling falls 45 degrees into the wall (prints without support)
  sliderToothDeg: 35,        // each tooth's ramps off the travel: about 2.7 N a side over the crest with friction 0.3, 5.5 N under the thumb
  sliderToothLand: 1.0,      // the crest: the wall's own face
  sliderRestPress: 0.2,      // the arm's deflection at rest on the far ramp: 0.5 N a side into the rim, about ten times the cover's weight at 1 g
  sliderGrooveMouth: 0.3,    // 45 degree chamfer on the rail groove's two edges at the bed: an elephant foot there closed the 0.1 a side
  coverLip: [20.0, 2.5],     // width x thickness: a thumb needs 16; at 30 the open slot under the eyes read as a mouth. 1.5 thick snapped under the shove a stuck cover needed (2026-11-22): at 0.08 layers the lip's layers are its weak axis
  coverLipLeft: 33.4,        // the lip centred on the bar (86.8 - 20) / 2: the thumb pushes on the cover's axis, so it cannot yaw it (at 45 the push was 11.6 off-axis and the 2.0 cover went sideways and stuck); the wordmark ends at 33
  coverLipRoot: 0.8,         // 45 degree root on the lip's three free sides: the lip takes a face-down drop and the thumb's shove (0.4 was part of the snap)
  coverLipAboveFace: 1.5,    // visible as a slide from across the room, as the XA's and the Minox's sills are; 0.5 was invisible, and a glove or a dry thumb could not lift the cover closed on 1.0    // the lip stands this far proud of the face, closed and stowed, so the thumb pad can push it down and lift it back; its height off the cover is derived
  // The brand on the bar: "odd jobs" engraved in the cover's top, as the
  // concept's nameplate, reading as shadow.
  markW: 30.0,               // the trace is 30 x 6.8; strokes about 1.3 mm
  markLeft: 3.0,             // from the bar's left end: the brand left-aligns its plate; 3 so the centred lip clears the last letter
  // The signature inside: the symbol and the wordmark engraved on the BACK
  // of the face, where only the person who opens the camera finds them. The
  // work nobody sees, done as well as the work everyone sees.
  innerMarkW: 22.0,
  innerSymbolH: 8.0,
  innerMarkAt: [44.0, 56.0],   // the wordmark's lower-left; the symbol sits to its left
  innerMarkD: 0.4,
  markDepth: 0.4,            // the wordmark engraved in the bar's top: one material per part (PLA on PETG does not bond, so no raised mark in the face's colour); it reads as shadow, as the symbol on the back does
  bedChamfer: 0.4,           // two whole layers at 0.2 (0.3 sliced as one step and a sliver); 45 degrees on every bed-side edge that meets a fit or shows: the cover's and keeper's backs, the face's back outer edge, the shell's front outer edge
  markMinStroke: 0.8,
  // ---- The shutter: a pod under the deck at its front edge, the guide a
  // slot open toward the face, the chamber open through the plate; the
  // switch goes in first into a pocket in the floor, the plunger slides in
  // over it, and the face is the door. One printed part, no fastener. See
  // shutter.mjs for the chain and why the switch is first. The first printed
  // pod (2026-11-21) missed the switch by 0.5 mm, had a loose retainer and
  // no lead route; a pinned floor plate after it could not be assembled at
  // all (the flange had no way in); the first front-entry chamber gave the
  // plunger and the switch 0.2 mm each and neither went in. Every number
  // here is read off the bench's switch.
  shutterX: 105.5,
  shutterCapToFace: 0.4,     // from the cap's front edge, against the slot's round end, to the face's back; the axis Z follows from it
  shutterPodLeft: 11.5,      // the pod's left face this far left of the axis (X 94: 1.9 clear of CAM 4's XIAO at 92.1, 2.2 of pod beside the chamber); the pod runs into the right wall
  shutterPodBottomZ: 21.0,   // 2.2 of pod behind the chamber's rear end; 8 above the carrier's front face
  shutterSwitchBody: [6.0, 6.0, 4.3],   // X, Z and the whole height, base to actuator top at rest (3.5 body + 0.8 actuator); MEASURE the bench's switch
  shutterSwitchTravel: 0.25, // the actuator's stroke to the click
  shutterSwitchFree: 0.3,    // between the actuator and the flange at rest (the plunger hangs on the step): the first 0.3 of press is free, then the click. A printed chamber 0.2 short still leaves the actuator untouched
  shutterSwitchPocket: 0.5,  // the pocket in the floor the switch drops into at the end of its ride: its walls hold it under the cap, and a switch NOT in its pocket is 0.5 too tall for the flange to pass over, which forces the order
  shutterSwitchPocketClr: 0.3,  // a side round the switch's body in the pocket
  shutterLegX: 3.25,         // the legs' X off the axis, each side (6.5 pitch)
  shutterLegZ: 2.25,         // the legs' Z off the axis, each side (4.5 pitch)
  shutterLegClr: 0.5,        // past the rear legs to the channels' rear ends: the switch's stop
  shutterLegT: 0.3,          // a leg's thickness in X (a 0.3 x 0.7 strip, 3.5 long below the base)
  shutterLegSlot: [2.0, 5.5],   // a leg channel's width in X (the second figure is unused: the channels run to the front)
  shutterGuideLen: 2.3,      // the slot's depth, deck to the step the flange rests under; the cap's guided length
  shutterGuideRound: 1.0,    // the slot's round end is round for its last mm at the deck; below it the ceiling is flat
  shutterGuideCeil: 0.4,     // the flat ceiling above the round end's top: the print's bridge clears the cap
  shutterActuatorGuideD: 14.6,  // the slot's width and its round end
  shutterActuatorFlangeD: 17.6, // the flange: 1.5 over the step each side and at the rear (gated)
  shutterFlangeH: 1.6,
  shutterFlangeBoreClear: 0.5,  // per side in the chamber: the flange only rides in, it is guided by the cap in the slot; the flange's bed edge is chamfered too
  shutterGuideRib: [0.2, 0.8],  // four ribs, proud x wide, along the slot (one each straight side, two on the round end 60 degrees off its apex): the cap runs on four lines 0.1 off, not in a 0.6 mm gap
  shutterPressCapD: 14.0,
  shutterProud: 2.0,         // the cap's rim above the top face
  shutterCapEdge: 0.5,       // 45 degrees round the cap's top edge: six even rings at 0.08
  shutterCapDish: [11.0, 0.4],  // a spherical dish in the cap's top, diameter x depth (the owner: "a slight indent to give it a tactile feel"): the finger finds the centre; a 1.0 flat rim stays between it and the chamfer; five layers at 0.08, up in print
  shutterCollarD: 20.0,
  shutterCollarDepth: 0.4,   // a two-layer shadow line round the cap, clipped by the deck's front edge
  shutterFloor: 2.0,         // of pod under the switch's pocket: the press lands here; the leg channels cut through it
  // ---- Strap: cord channels at both lower corners, inside the outline. Two
  // slots through the rear frame's border over a channel in the bottom
  // wall's end: the cord goes in one slot, along the channel, out the other,
  // and the frame between the slots is the bar it pulls on. No ears.
  strapSlot: [3.0, 2.8],     // X x Y of each slot through the frame, inside the frame's edge chamfer and 0.7 off the cavity; a 2.5 mm cord passes with 0.3 (2.4 was under the cord on paper), 2.2 was a key fob
  strapTop: true,            // a second pair at the top corners: on a neck cord the camera hangs upright, button up, lenses still; the bottom pair is the wrist loop
  strapSlotXs: [2.0, 8.0],   // the two slots' X, from the body's left edge; mirrored at the right
  strapChannelD: 3.0,        // the tunnel's depth into the wall end; its width is the slot's
  strapTunnelSkin: 1.2,      // of wall end over the tunnel: the bar the cord loops. 0.6 was three layers, two of them a bridge at the top of the print, so the frame's pins would carry the drop; six layers now, to be proved at 100 N on the strap coupon
});

// ---- Part IDs, engraved in a real font on a face that is up or vertical in
// print, never the bed (the owner, after the first coupons: the bed-face
// pixel codes spoiled the first layer and could not be read). A = enclosure,
// B = moving and interaction parts, C = consumables (not printed), T = test
// coupons, P = coupon plates. The same ID is in the file name, the register
// in the README and on the bin. B01 and B02 carry no mark: each is the
// only part of its shape and colour, and neither has a hidden face that is
// not the bed.
export const IDS = Object.freeze({
  shell: "A01", face: "A02", frame: "A03", cover: "B01", plunger: "B02",
  inserts: "C01", foam: "C02", screws: "C03", shrinkBar: "T01",
});

// ---- The stack chain, derived once ------------------------------------------
export const Z = (() => {
  const carrierBack = P.p4InsertH + P.spacer;
  const carrierFront = carrierBack + P.carrierT;
  const socketTop = carrierFront + P.socketH;
  const xiaoBack = socketTop + P.xiaoHeaderInsulator;
  const senseTop = xiaoBack + P.xiaoBoardT;
  const lensFront = xiaoBack + P.camStackH;
  const camPocketDepth = P.plate - P.platePocketAhead;
  const plateInner = lensFront - camPocketDepth;   // the module's PCB face lands here
  const plateFront = plateInner + P.plate;
  const glassFront = -P.p4T;
  const glass = glassFront - P.glassClear;   // the shell's rear face and the frame's inner face
  const frameRear = glass - P.rearFrameT;
  const pupil = lensFront - P.camPupilBackFromLens;
  const bayFloor = P.p4CanH;
  const bayCeiling = carrierBack - P.carrierBackPartsH;
  return Object.freeze({
    carrierBack, carrierFront, socketTop, xiaoBack, senseTop, lensFront,
    camPocketDepth, plateInner, plateFront, glassFront, glass, frameRear, pupil,
    bayFloor, bayCeiling, depth: plateFront - frameRear,
  });
})();

// Plan figures derived once.
export const XY = (() => {
  const c = P.carrierClear;
  const cavity = [-c, -c, P.carrierW + c, P.carrierH + c];
  const o = c + P.wall;
  const outer = [-o, -o, P.carrierW + o, P.carrierH + o];
  const lensY = P.socketCentreY + P.lensOffsetY;
  const p4 = [P.p4Inset, P.p4Inset, P.carrierW - P.p4Inset, P.carrierH - P.p4Inset];
  const p4Centre = [P.carrierW / 2, P.carrierH / 2];
  const wallMidY = [outer[1] + P.wall / 2, outer[3] - P.wall / 2];
  return Object.freeze({ cavity, outer, lensY, p4, p4Centre, wallMidY,
    bodyW: outer[2] - outer[0], bodyH: outer[3] - outer[1] });
})();

// Every parameter must be a real number before any geometry reads one; a NaN
// cuts nothing and probes nothing, and the gate that reads it passes vacuously.
{
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const ok = (v) => finite(v) || typeof v === "boolean"
    || (Array.isArray(v) && v.every((e) => finite(e) || (Array.isArray(e) && e.every(finite))));
  const bad = Object.entries(P).filter(([, v]) => !ok(v)).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  if (bad.length) throw new Error(`Parameters are not all real numbers: ${bad.join("; ")}`);
  for (const [k, v] of Object.entries(Z)) if (!finite(v)) throw new Error(`Z.${k} is ${v}`);
}
