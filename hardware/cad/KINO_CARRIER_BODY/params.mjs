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
  shrinkPct: 0.2,            // MEASURED on T01 (2026-11-21): the 100.0 mm bar printed 99.8. Set in the slicer as compensation; the model is never scaled
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
  camBody: 8.5,              // the head square. The first T02 (8.7 pocket, 0.3 ribs) was "extremely loose" on the bench: the head is not 8.5. The gauge coupon T02 now has three pockets; the one that holds sets this with camBodySlack
  camBodySlack: 0.20,
  camGaugePockets: [7.8, 8.1, 8.4],   // T02's three pocket widths (ribs the same): a sizing gauge, one print answers which width holds
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
  wall: 4.5,                 // carries a pin hole in each end with 1.3 of wall a side
  plate: 4.4,                // the front plate: pocket depth 3.4 + platePocketAhead
  cornerR: 10.0,             // near the most the plan allows: the carrier's R3 corners sit inside the wall, and at R10 the wall on the diagonal is 2.65 mm (gated)
  frameEdgeR: 1.2,           // the rear frame's outer edge, a 45 degree chamfer toward the rear: chamfers in Z step one layer each and read as the grooves do, rounds in Z terrace (R1.5 at 0.2 stepped 0.77, 0.32, 0.25); rounds stay in plan. The pin holes 1.35 from the outline cap it
  // One fastener in the body: a 4.8 mm length of 1.75 mm filament, twelve
  // of them. Six in the walls' front ends hold the face (3 mm into the
  // wall, 1.8 into the face's back); six in the walls' rear ends hold the
  // frame (3 into the wall, through the 2.0 frame, 0.2 under its rear
  // face). No screw anywhere.
  facePinD: 1.9,             // the hole in the wall ends and the face, for 1.75 mm filament: a 1.8 hole at a bed face closed to 1.5 with the elephant foot, 2.0 with the countersink and the 0.2 compensation did not retain; the pins must hold without glue, T03 and T04 decide
  facePinSink: 0.4,          // 45 degree countersink at every bed-face mouth
  facePinWall: 3.0,
  facePinFace: 1.8,          // into the face's back (the face is 4.2 with a 1.2 edge chamfer over the holes' outer edges): the pins are 4.8 long, 3 in the wall and 1.8 here; the pull test on the real face decides
  facePinsTop: [30.0, 90.0],   // X on the top and bottom walls; the bottom pair dodges the LED slots and the USB opening
  facePinsBottom: [5.0, 96.7],  // under the window's bottom rim, short of the corner and the USB opening
  facePinsSideY: 52.0,         // one on each side wall, above the horizon channel
  framePinsTop: [30.0, 90.0],  // the frame's pins in the walls' rear ends: clear of the strap tunnels (X 2 to 11 from each end)
  framePinsBottom: [40.0, 100.0],  // not the top pair's mirror: turned round, the frame's holes miss the shell's pins by 2.4 mm (a gate), so it goes on one way
  framePinsSideY: 52.0,
  framePinHoleD: 1.8,        // through the frame, countersunk at its inner face (the bed): tighter than the wall end's 1.9, so the pins stay in the frame when it comes off
  pinHoldN: 5,               // PROVISIONAL: one pin's hold in a wall-end hole, 500 g hung on T04's pin; six against the foam's 16 N
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
  faceBase: 4.2,             // the face plate: its own floor 1.0 under the track, the lips 2.4, the horizon 0.8; the cover rides on the face, so face + cover is one subassembly, tested before it goes on
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
  panelDepth: 2.4,           // the lips' top above the face's floor: the cover 2.0 and 0.4 of play under the lip (12 whole 0.2 layers; 2.3 put the groove floor on a half layer); the mark rides 0.4 proud of the groove floor
  windowChamfer: [0.8, 0.4], // 45 degrees on the window's front edges: the bottom rim 0.8 like the horizon's upper lip, the side rims 0.4 like its lower, so the open stow zone is the second line of a cut tray and the bar sits between two lit edges
  cellSink: 0.8,             // 45 degrees at each cell's mouth in the track floor: a rim, so the four read as eyes and not as a microphone array; prints face-up         // plain cones: the stepped rings read as damage at this size
  // The cover: the field body's bench-tuned track, restated. Drops to open.
  sliderH: 16.5,             // blankets the 7.5 mm cells by 4.5 a side; the lens row sits low, so every mm of cover is a mm of travel (the travel is DERIVED: closed to the window's bottom rim)
  sliderT: 2.0,
  sliderClr: 0.1,            // per side, in X
  sliderBevel: [1.0, 1.5],   // 45-degree edge bevels, left and right, and the lips that trap them. NOT the same: the orientation key. Turned round, the cover's 1.0 bevel meets the 1.5 lip and stops at the window's mouth; a gate proves it
  sliderLipOver: 0.2,        // each lip is this much deeper than its bevel is wide, so its underside is steeper than 45 degrees in print
  sliderCornerR: 3.0,        // the bar is the thing the eye reads; square corners inside a pill band were the last box on the front
  sliderBumpR: 0.4,
  sliderBumpBite: 0.15,
  sliderBumpH: 1.0,          // the 0.2 elephant-foot compensation takes the bump's first layer and the cover's 0.4 bed chamfer skips its second; at 1.0 three layers bite the cover's vertical flank
  sliderEdgeCrest: 4.0,      // past the R3 corners, so each detent meets a straight edge
  sliderEdgeRamp: 0.6,
  sliderEdgeRelief: 0.2,
  coverLip: [20.0, 1.5],     // a thumb needs 16; at 30 the open slot under the eyes read as a mouth
  coverLipLeft: 45.0,        // the lip's left end from the bar's left edge, past the wordmark's end at 36, so the thumb never covers a letter
  coverLipRoot: 0.4,         // 45 degree root on the lip's three free sides: the lip takes a face-down drop     // the thumb lip on the cover's TOP edge, width x height; the thumb pushes down on its top face (the coupon says whether 1.5 is enough)
  coverLipAboveFace: 1.5,    // visible as a slide from across the room, as the XA's and the Minox's sills are; 0.5 was invisible, and a glove or a dry thumb could not lift the cover closed on 1.0    // the lip stands this far proud of the face, closed and stowed, so the thumb pad can push it down and lift it back; its height off the cover is derived
  // The brand on the bar: "odd jobs" engraved in the cover's top, as the
  // concept's nameplate, reading as shadow.
  markW: 30.0,               // the trace is 30 x 6.8; strokes about 1.3 mm
  markLeft: 6.0,             // from the bar's left end: the brand left-aligns its plate
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
  // ---- The shutter: a pod under the deck with a round guide and a chamber
  // open toward the front through the plate; the plunger and the switch
  // slide in from the front and the face is the door. One printed part, no
  // fastener. See shutter.mjs for the chain and why the front. The first
  // printed pod (2026-11-21) missed the switch by 0.5 mm, had a loose
  // retainer and no lead route; a pinned floor plate after it could not be
  // assembled at all (the flange had no way in), and rear entry fails on
  // the wall's inner face. Every number here is read off the bench's switch.
  shutterX: 104.0,
  shutterZ: 26.2,            // bore axis, between the plate and the carrier
  shutterPodLeft: 10.0,      // the pod's left face this far left of the axis (X 94: 1.9 clear of CAM 4's XIAO at 92.1, 1.85 of pod beside the chamber); the pod runs into the right wall
  shutterPodBottomZ: 14.0,   // 1.1 above the carrier's front face
  shutterSwitchBody: [6.0, 6.0, 4.3],   // X, Z and the whole height, base to actuator top at rest (3.5 body + 0.8 actuator); MEASURE the bench's switch
  shutterSwitchTravel: 0.25, // the actuator's stroke to the click
  shutterSwitchFree: 0.2,    // between the actuator and the flange at rest, so the switch slides in under the seated plunger; it is also the plunger's play riding in
  shutterLegX: 3.25,         // the legs' X off the axis, each side (6.5 pitch)
  shutterLegZ: 2.25,         // the legs' Z off the axis, each side (4.5 pitch)
  shutterLegClr: 0.5,        // past the front legs to the channels' ends: the switch's stop
  shutterLegSlot: [2.0, 5.5],   // a leg channel's width in X (the second figure is unused: the channels run to the front)
  shutterGuideLen: 2.3,      // the guide bore, deck to the step the flange rests under. The plunger riding in (flange 1.6 + cap 2.0 proud + this) must fit under the step with the free play to spare in a chamber that is flange + free + switch tall (gated): 5.9 in 6.1
  shutterGuideRound: 1.0,    // the guide's last mm at the deck is round; below it the ceiling is flat
  shutterGuideCeil: 0.4,     // the flat ceiling above the circle's top: the print's bridge clears the cap
  shutterActuatorGuideD: 14.6,
  shutterActuatorFlangeD: 16.0,
  shutterFlangeH: 1.6,
  shutterFlangeBoreClear: 0.15, // per side in the chamber; the flange's bed edge is chamfered too. 0.3 ticked in the hand, the first thing a juror touches
  shutterGuideRib: [0.2, 0.8],  // three ribs, proud x wide, along the guide bore on the face side: the cap runs on three lines, not in a 0.6 mm gap
  shutterPressCapD: 14.0,
  shutterProud: 2.0,         // the cap's rim above the top face
  shutterCapEdge: 0.5,       // 45 degrees round the cap's top edge: six even rings at 0.08
  shutterCollarD: 20.0,
  shutterCollarDepth: 0.4,   // a two-layer shadow line round the cap
  shutterFloor: 2.0,         // of pod under the chamber: the press lands here; the leg channels cut through it
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
  pins: "C01", foam: "C02", shrinkBar: "T01",
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
