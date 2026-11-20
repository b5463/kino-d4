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
  camRibProud: 0.20,
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
  cornerR: 6.0,
  bossD: 6.0,                // the stack-screw pillars, inside the 7 mm keep-out
  bossRib: 2.0,              // the rib tying each pillar to the wall
  bossFoot: 3.8,             // pillar material the screw head bears on
  screwBore: 2.4,            // M2 clearance
  accessShaftD: 4.0,         // the driver's way in from the front; an M2 pan head is 3.8
  rearFrameT: 3.0,
  framePilotD: 1.7,          // M2 thread-forming into PETG
  framePilotDepth: 6.0,
  frameScrewHoleD: 2.4,
  frameHeadD: 4.2,
  frameHeadDepth: 1.6,
  frameScrewXs: [14.0, 76.0],  // clear of the LED slots and the USB opening on the bottom wall
  usbGable: 45,              // degrees, the opening's roof in print
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
  return Object.freeze({
    carrierBack, carrierFront, socketTop, xiaoBack, senseTop, lensFront,
    camPocketDepth, plateInner, plateFront, glass, frameRear, pupil,
    depth: plateFront - frameRear,
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
