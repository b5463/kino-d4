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
  carrierClear: 0.3,         // per side in the cavity: the stack slides in from the rear
  // The four M2 holes, on the P4's insert pattern (61.9 x 54.8), 8.0 mm from
  // the carrier's top and bottom edges. H1 H2 top, H3 H4 bottom.
  carrierHoles: [[18.95, 62.80], [80.85, 62.80], [18.95, 8.00], [80.85, 8.00]],
  fastenerKeepOutD: 7.0,     // nothing but silk inside this on the carrier
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
  // The three edge LEDs on the back face at the bottom edge: PWR CAM FLT.
  ledXs: [87.695, 93.695, 99.695],
  ledSlot: [2.0, 4.0],       // width x height of each slot through the bottom wall

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

  // ---- The P4 module -------------------------------------------------------
  p4W: 114.40,               // the bare module, spec p.6
  p4H: 66.80,
  p4Inset: 2.0,              // inside the carrier outline, every side
  p4T: 13.8,                 // PCB back to display glass front (OFFICIAL_CAD)
  p4InsertH: 3.3,            // the brass inserts stand this far off the PCB back (MEASURED)
  activeArea: [93.60, 56.16],
  activeCentred: true,       // PROVISIONAL: the active area centred on the PCB
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
  camBody: 8.5,              // the head square, verify by coupon
  camBodySlack: 0.15,
  camRibProud: 0.30,         // triangular crush ribs, 0.8 wide at the wall: two extrusion lines, prints every time (0.4 mm round columns did not)
  camRibBase: 0.80,
  camRibSpan: [0.2, 0.8],
  camBarrelD: 7.0,
  lensBoreD: 7.1,
  platePocketAhead: 1.5,     // plate left in front of the pocket to carry the bore
  camFovDeg: 78.0,           // design figure; the real field is MEASURE_REQUIRED
  fovMarginDeg: 2.0,
  camPupilBackFromLens: 1.1, // entrance pupil behind the lens's front face

  // ---- The shell -----------------------------------------------------------
  wall: 4.5,                 // thick enough for the rear frame's pilots in the wall ends
  plate: 5.0,                // the front plate: pocket depth + platePocketAhead
  cornerR: 10.0,             // near the most the plan allows: the carrier's R3 corners sit inside the wall, and at R10 the wall on the diagonal is 2.65 mm (gated)
  deckLine: 8.0,             // the top deck reads as a cap: the layer grooves stop here and a reveal runs round
  deckRevealW: 0.8,
  deckRevealD: 0.4,
  frameEdgeR: 1.5,           // the rear frame's outer edge (printed rear face up); the screw holes 2.55 from the outline forbid a bigger one
  frameEdgeSteps: 5,
  // Six filament pins (1.75 mm, cut 4.5 long) in the walls' front ends locate
  // and hold the face: 3 mm into the wall, 2 mm into the face's back. The
  // four stack-screw shafts stay for the driver; the face covers them.
  facePinD: 1.8,
  facePinWall: 3.0,
  facePinFace: 2.0,
  facePinsTop: [30.0, 90.0],   // X on the top and bottom walls; the bottom pair dodges the LED slots and the USB opening
  facePinsBottom: [5.0, 96.7],  // outside the cover's entry gap (X 6.7 to 93.7, where the face is only 2.3 thick), between the LED slots, short of the corner
  facePinsSideY: 35.0,         // one on each side wall
  bossD: 6.0,                // the stack-screw pillars, inside the 7 mm keep-out
  bossRib: 2.0,              // the rib tying each pillar to the wall
  bossFoot: 3.8,             // pillar material the screw head bears on
  screwBore: 2.4,            // M2 clearance
  accessShaftD: 4.0,         // the driver's way in from the front; an M2 pan head is 3.8
  rearFrameT: 2.5,           // the thumb climbs this to the glass; the window's inner edge is chamfered for it
  framePilotD: 1.7,          // M2 thread-forming into PETG
  framePilotDepth: 6.0,
  frameScrewHoleD: 2.4,      // plain holes: the four M2 pan heads sit proud on the back, as the brand's concept shows its rear screws; a counterbore broke out through the edge round
  frameScrewXs: [14.0, 76.0],  // clear of the LED slots and the USB opening on the bottom wall
  frameWindowChamfer: 1.5,   // 45 degrees, widening toward the rear, so the thumb slides onto the glass's edge targets
  thumbPadProud: 1.2,        // the thumb pad stands off the frame; grooves cut into it
  usbGable: 45,              // degrees, the opening's roof in print

  // ---- The face shell: the form lives here, printed back-face down --------
  // ODD JOBS: a charcoal ribbed shell, a cream (day) or cobalt (night) face
  // over the whole front with a pillow edge, a pink shutter, quiet markings.
  // The face covers the plate and the walls' front ends (the concept's v18
  // front: the fascia fills the front, the charcoal is the sides and the cap).
  faceBase: 3.5,             // the face plate; the front's only soft edge lives here, and 2.5 did not read at 128 mm wide
  faceEdgeR: 3.5,            // its front edge, a quarter round over the full thickness
  // The grip: a raised pad on the face's right, where the right hand lands,
  // with the finger ribs on it. A stranger's hand finds the same place every
  // time and stays off the lens row.
  gripX: [100.0, 118.0],
  gripY: [4.0, 66.0],
  gripProud: 2.5,
  gripChamfer: 1.5,
  gripR: 8.0,
  fingerPadX: [102.5, 115.5],
  fingerPadY: [10.0, 60.0],
  fingerRibW: 1.2,
  fingerRibPitch: 2.6,
  fingerRibH: 0.8,
  fingerPadR: 6.0,           // the rib field's corners
  // The maker's mark, "odd jobs", traced from the logo, engraved on the top
  // deck left of the shutter (the deck is a vertical wall in print, so an
  // engraving there is free), the way the brand's concept carries its plate.
  makerW: 22.0,
  makerAt: [70.0, 24.0],     // X on the deck, and Z of its lower edge in the body frame
  makerDepth: 0.5,
  // Layer texture on the shell's walls: V-grooves around the body, parallel to
  // the layers in print, on the side and bottom walls, never across the top deck.
  grooveP: 2.4,
  grooveD: 0.5,              // 0.25 was three layers deep, at PETG's own ripple; these read as ribs
  grooveZ: [-9.0, 37.0],
  // The rear frame: thumb pad as grooves on the right border, the ODD JOBS
  // symbol engraved on the left border (the rear face is the bed, so nothing
  // there can stand proud).
  thumbPadX: [110.0, 119.0], // past the window's chamfer, short of the frame's edge round
  thumbPadY: [18.0, 52.0],
  thumbGrooveW: 1.0,
  thumbGroovePitch: 2.8,
  thumbGrooveD: 0.4,
  symbolRearH: 8.0,
  symbolRearAt: [-1.5, 31.0],
  symbolRearD: 0.4,
  // The lens band: proud of the base, chamfered, with a recessed panel that is
  // the cover's track. Its Y extent is DERIVED from the cover's travel.
  bandX: [3.2, 97.2],
  bandProud: 1.0,            // the panel is cut into the face itself now that no pin hole sits under the track; the band is a rim
  panelFloorMin: 1.2,        // face left under the panel floor
  // The apron: the keeper grown into a fixed plate over the stow zone, in the
  // face's colour, glued. Closed, the front is a bar over a door; dropped,
  // the cover slides under the apron. Its slot lets the cover's lip through.
  apronT: 1.0,
  apronClear: 0.8,           // over the cover's front: the raised wordmark (0.6) passes under it
  apronGapBelowBar: 0.3,     // between the apron's top edge and the stowed lip
  bandChamfer: 1.5,
  bandRim: 2.0,              // flat rim between the chamfer and the panel
  bandBottomInset: 3.4,      // the band's bottom rim, from the face's bottom edge to the panel; the keeper lives in it
  bandR: 9.0,                // pill ends; R12 cut 0.1 mm into the panel's corners through a 3.5 mm rim (gated now)
  panelDepth: 2.2,           // cover 2.0 plus 0.2 set back from the band's front
  lensRingStep: 0.6,         // each ring of a cell stands this far proud of the field cone
  // The cover: the field body's bench-tuned track, restated. Drops to open.
  sliderH: 16.5,             // blankets the 14 mm cells with 1.25 mm a side; the lens row sits low, so every mm of cover is a mm of travel (the travel is DERIVED: closed to the band's bottom rim)
  sliderT: 2.0,
  sliderClr: 0.1,            // per side, in X
  sliderBevel: 1.0,          // 45-degree edge bevel, and the lip that traps it
  sliderLipZ: 1.1,           // lip depth from the band's front: deeper than the bevel is wide, so the lip's underside is steeper than 45 degrees in print (0.95 read as an overhang)
  sliderCornerR: 3.0,        // the bar is the thing the eye reads; square corners inside a pill band were the last box on the front
  sliderBumpR: 0.4,
  sliderBumpBite: 0.15,
  sliderBumpH: 0.8,
  sliderEdgeCrest: 4.0,      // past the R3 corners, so each detent meets a straight edge
  sliderEdgeRamp: 0.6,
  sliderEdgeRelief: 0.2,
  keeperClr: 0.1,
  coverRailW: 2.5,
  coverRailProud: 0.25,
  coverRailOffset: 30.0,
  coverLip: [24.0, 3.0],     // the thumb lip on the cover's TOP edge, width x height; the thumb pushes down on its top face
  coverLipProud: 1.8,
  markScale: 0.65,           // the kino D4 wordmark on the cover: 52 x 7 mm; print its last 0.6 mm in the face's filament so the bar reads
  markProud: 0.6,
  markMinStroke: 0.8,        // gated against the trace's thinnest run at this scale
  // ---- The shutter: the field body's pod, button and retainer, the cap grown
  // to the brand's pink button. The bore's teardrop roof points -Z, so the
  // axis sits sqrt(2) x the access radius above the pod's bottom.
  shutterX: 104.0,
  shutterZ: 26.2,            // bore axis, between the plate and the carrier
  shutterPodW: 24.0,
  shutterPodReach: 4.0,      // pod pilaster inward from the cavity's top face
  shutterPodBottomZ: 14.0,   // 1.1 above the carrier's front face
  shutterSwitchBody: [6.0, 6.0, 4.3],
  shutterSwitchClearance: 0.6,
  shutterActuatorGuideD: 14.4,
  shutterActuatorFlangeD: 16.0,
  shutterPressCapD: 14.0,
  shutterPressFaceD: 13.0,
  shutterPressCapH: 0.9,
  shutterProud: 2.0,         // the cap's rim above the top face; the dome adds shutterDomeH
  shutterDomeR: 18.0,        // a convex dome, not the field body's dish
  shutterDomeH: 1.4,
  shutterCollarD: 20.0,
  shutterCollarDepth: 1.6,
  shutterAssemblyAccessD: 17.0,
  shutterRetainerCupD: 16.4,
  shutterRetainerPlateD: 19.5,
  shutterRetainerCupH: 4.0,
  shutterWireExit: [6.4, 4.5],
  shutterWireBayW: 8.0,
  shutterSwitchLegBand: 1.8,
  shutterSwitchLegSink: 0.6,
  shutterSideWireW: 3.0,
  // ---- Strap lugs at both lower rear corners: out of the palm (the right
  // hand's heel sat on the first one, mid-wall), and a pair so a neck strap
  // hangs the camera level. Wrist loop on the right one alone.
  strapLugLen: 9.0,          // along Y
  strapLugWall: 1.5,
  strapHoleD: 3.0,
  strapLugY0: -2.0,
  strapLugZ0: -12.0,         // its -Z face (up in print), beside the frame
  strapLugH: 6.0,            // at the outer face; the +Z side slopes 45 degrees back to the wall
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
  const glass = -P.p4T;
  const frameRear = glass - P.rearFrameT;
  const pupil = lensFront - P.camPupilBackFromLens;
  const bayFloor = P.p4CanH;
  const bayCeiling = carrierBack - P.carrierBackPartsH;
  return Object.freeze({
    carrierBack, carrierFront, socketTop, xiaoBack, senseTop, lensFront,
    camPocketDepth, plateInner, plateFront, glass, frameRear, pupil,
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
