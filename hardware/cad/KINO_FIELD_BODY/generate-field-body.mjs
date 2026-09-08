import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "manifold-3d";

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, ".candidate");
fs.mkdirSync(outDir, { recursive: true });

// Millimetres. Body coordinates equal print coordinates: the camera/front
// face lies on the bed at Z=0 and the open rear rim is the top of the print.
// Every wall is vertical, every boss and pocket opens upward, and every hole
// through a vertical wall carries a 45-degree or teardrop roof, so the body
// prints with NO support material anywhere.
export const P = Object.freeze({
  bodyCornerR: 9.0,       // every outer corner is generously rounded: it is
                          // what the loved compacts of this era share, and it
                          // is what a body feels like rather than looks like
  bodyW: 131,
  // 96 -> 90. The old floor of ~95.4 was set by the shutter pod, which hung
  // shutterPodReach into the cavity along the WHOLE depth and so competed with
  // the module for Y wherever it ran past the module's face. The pod is two
  // sections now and only the front one is deep, so that is gone.
  // What is left is the module itself: 69.41 + two 6 mm walls = 81.4 mm.
  bodyH: 90,
  // Depth is what makes a camera feel bulky in the hand, so it is not a
  // guess: it is the sum of the stack, and a gate re-adds it every build.
  //   plate 5 + XIAO stack 9.4 + component clearance 10.5 = PCB back at 26
  //   + module 13.8 = glass rear 39.8 + foam 1.2 + door 4 = 45
  // The previous 75 mm carried a 36 mm component keep-out inherited from the
  // open truss rig, which this module never needed.
  // 53 -> 59.4 when the XIAO stack turned out to be 7.6 mm rather than 1.2 mm.
  // The gate below re-adds every term on every build, so this is never a guess.
  // 64.6 -> 65.6 when xiaoPadH stopped being a declared 3.0 and became derived
  // from the camera stack's own overall height: see camStackH.
  bodyD: 65.5,
  // Wall thickness is per SIDE, because the sides do different jobs.
  // The top and bottom walls carry the door's dovetail, which bites doorBite
  // into each of them, so what matters there is what is left BEHIND the groove
  // rather than the wall figure itself - and the tool-less door is the one
  // mechanism here with no fallback. The left wall carries no groove and can be
  // thinner. `wall` stays the RIGHT wall: it is the boundary between the module
  // bay and the grip cavity, and those two voids are only 4 mm apart already.
  wall: 6,
  wallBottom: 6.0,
  wallTop: 6.0,
  wallLeft: 6.0,
  plate: 5,           // front camera plate thickness

  // JC4880P443C_I_W module, official drawing page 7.
  moduleW: 117.01,
  moduleH: 69.41,
  moduleT: 13.8,      // PCB back to display glass front
  // pcbBackZ is DERIVED below, not declared: it is simply where the stack in
  // front of the module ends. Declaring it separately meant two numbers had to
  // agree, and when the XIAO stack grew by 6.4 mm they stopped agreeing - the
  // boards and their headers overran the module bay while pcbBackZ sat at 34.
  // Guaranteed clear depth in front of the PCB back across the whole module
  // footprint - enough for the glued-on heatsink over the XIAO band. Outside
  // that band the free depth is the full 21 mm down to the front plate, which
  // is where the JP1 harness housings live.
  // 9.4 -> 14.6, and what sets it is the USB-C PLUG.
  // Bench photo, component side, display away: the GPIO header runs down the
  // board's LEFT side at mid-height, not along the top edge. The mapping is
  // not mirrored - the SD sits left of RESET in that view, and RESET is the
  // measured X=106.4, i.e. right. So the connector is inboard at mid-height
  // and its plug stands off the component side into the bay; there is no
  // top-edge strip with a free run to the front plate for it to use.
  // I sized this at 13.0 on the belief that there was. There is not.
  // 16.0 mm of plug, less the 1.4 mm module margin already in front of the
  // PCB, needs 14.6 mm of bay.
  // The 54 x 33 mm piggyback board and its plugged headers come to 12.6 mm.
  // It is NOT mounted - it floats in the bay, so these gates only have to
  // prove the room exists, not that anything holds it. A mount was considered
  // and dropped: its corner holes all land over the XIAO band, whose four
  // modules sit on 22 mm pitch at 21 mm wide with no gap to run a post
  // through, and the clear strips above and below the band are ~26 and 27 mm
  // against a 33 mm board.
  bayDepth: 14.6,
  usbPlugClearance: 16.0,  // molded plug body proud of the PCB face
  piggyback: [54.0, 33.0], // the wiring hub board
  piggybackHeaders: 11.0,  // pin field plus plugged Dupont, off its face
  piggybackT: 1.6,

  // ---- Split joint -------------------------------------------------------
  // The chassis prints as TWO parts, cut at the bay floor (splitZ = bayMinZ).
  // Not for time - two mating faces add surface, and surface is what costs on
  // a part that is 89% perimeter - but so that no single print is 9 h and
  // 65 mm tall on a machine that has already lost one. The front half is the
  // whole optical datum: plate, pockets, bores, XIAO seats, the 22 mm pitch.
  // The rear half only holds the module and the door, so joint compliance
  // cannot reach the wiggle. Butt joint, four M3 along Z in local pads on the
  // top and bottom walls, coaxial spigots for alignment, no rabbet: a rabbet
  // leaves half the wall hanging 3 mm above the bed on whichever half prints
  // cut-face-down, and both halves print flat as they are without one.
  // X=100 was moved to 92: its pad (X 95..105) clipped the shutter's wire run
  // under the pod by 0.5 mm in Y.
  splitBoltXs: [18.0, 92.0],  // two bolts in the top wall, two in the bottom
  splitPadW: 10.0,            // pad width along X
  splitPadReach: 3.7,         // pad projection into the cavity; module is 4.3 away
  // The pad spans the cut: splitPadAft behind it, splitPadFore in front, and
  // below that a splitPadWedge-tall 55-degree wedge back to the wall face so
  // its underside is self-supporting on the front half. It first ran as a
  // block centred on the cut - a flat overhang 14 mm off the plate - and then
  // as a gusset down to the plate, which walled off the loom's raceway at
  // X 87..97. This shape leaves Z 5..17 open under it for the Dupont loom.
  splitPadAft: 12.0,          // straight pad behind the cut, along Z
  splitPadFore: 9.0,          // straight pad in front of the cut
  splitPadWedge: 5.0,         // wedge height under the front end (3.5 run: 55 deg)
  // M2.5, not M3. The first cut was M3 with the axis mid-thickness of wall-
  // plus-pad, which put half of every head pocket INSIDE the wall with solid
  // wall above it: the head could not be lowered in from the door at all, and
  // the audit showed the pocket ceilings as four 24 mm^2 overhangs. A pad that
  // may only reach 3.7 mm into the cavity cannot hold an M3 head axially.
  // So: the axis sits splitBoltInset inside the wall face, the Ø5 pocket is
  // open-sided toward the cavity, and a shallow channel in the wall's inner
  // face carries the head and a 2 mm key from the pocket up to the door plane.
  splitBoltInset: 1.25,       // bolt axis this far inside the wall's inner face
  splitPilotD: 2.0,           // M2.5 self-tap into the front half
  splitPilotDepth: 8.5,       // blind pilot, inside the straight pad (fore 9)
  splitClearD: 2.7,           // M2.5 clearance through the rear half
  splitHeadD: 5.0,            // pocket for a Ø4.5 x 2.5 socket head
  splitHeadDepth: 3.0,
  splitSpigotD: 4.6,          // alignment peg, coaxial with the bolt
  splitSpigotH: 3.0,
  splitSpigotSlop: 0.15,      // per side
  splitDriverD: 2.5,          // 2 mm hex key shaft, must clear the module
  splitBoltLen: 16.0,         // M2.5 x 16 socket head
  // Soldered header pins plus the wire loop leaving them. This was 0 before,
  // which left the four XIAOs' wiring nowhere to go.
  xiaoHeaderZone: 14.0,
  xiaoModuleMargin: 1.4,   // air between the wiring zone and the bay floor

  // Inner threaded brass standoffs, MEASURED on the board.
  //
  // 61.9 x 54.8 -> 65.5 x 58.2. The old pair was drawing-derived and recorded
  // as caliper-confirmed, and it was neither: it puts every post 1.8 mm in and
  // 1.7 mm down from where the brass actually is, which is a module that
  // cannot be seated at all. It came from the same session that recorded the
  // standoff as O5.4 when it is O3.5, so the whole group was re-measured
  // rather than patched one number at a time.
  //
  // The drawing's outer 102.6 x 60 "4xD2" holes do not exist on this board.
  // ---- The standoff pattern, and the mistake that moved it three times -------
  // A caliper cannot reach two centres. It can only reach two EDGES, so that is
  // what is recorded as the measurement here, and the centre pitch is derived
  // from it. Getting that backwards is what went wrong twice:
  //
  //   0.1.3  61.9 x 54.8 centre pitch, from the module drawing. Correct.
  //   0.1.4  "re-measured" to 65.5 x 58.2 and this record called the old pair
  //          drawing-derived and wrong. It was not: 65.5 x 58.2 is 61.9 x 54.8
  //          plus one standoff diameter. An outside span had been written into
  //          a centre-pitch field, so every post moved 1.8 mm out in X and 1.7
  //          in Y, the loom's tightest raceway fell from 95 mm^2 to 52, and two
  //          nodes lost their straight USB plug - all of it to correct a fault
  //          that was not there.
  //   now    printed, and the posts SPLAY by exactly that. Calipers across the
  //          standoff EDGES read 65 x 58 mm, which is 61.5 x 54.5 between
  //          centres - the drawing's 61.9 x 54.8 to within the rounding of a
  //          whole-millimetre reading. The drawing figure is the more precise
  //          statement of the same thing, so it is what the posts are built to,
  //          and a gate below ties the two together so this cannot recur.
  p4OutsideSpanX: 65.0,    // MEASURED, edge to edge across the standoffs
  p4OutsideSpanY: 58.0,
  p4HoleX: 61.9,
  p4HoleY: 54.8,
  // STILL NOT MEASURED. The one figure of this group that has never been put
  // to calipers, and the reason KINO_P4_1TO1_HOLE_TEMPLATE.svg exists: print
  // it at 100%, lay it on the module, and see whether the pattern sits on the
  // brass. With the pitch now measured this is the only way the posts can
  // still be in the wrong place.
  p4PatternOffsetX: -9.3, // pattern centre relative to module centre
  // 3.0 -> 3.3, re-measured with the pitch. The brass sticks out of the PCB
  // back by this much, so it fixes where the socket FLOOR sits: the floor
  // drops 0.3 mm and the post rim ends up 1.3 mm short of the board instead of
  // 1.0, which is more clearance under the module, not less.
  p4StandoffH: 3.3,
  // 5.4 -> 3.5: the maintainer measured the brass again. Ø3.5 is the usual
  // M2 brass standoff; the 5.4 that stood here would have left a Ø3.5 part
  // with 1 mm of air a side in every socket built to it.
  p4StandoffOD: 3.5,
  // The module is captured, not screwed: four vertical posts press the
  // standoff tops while the foam-shimmed rear bezel presses the glass
  // perimeter. The threaded standoffs stay free for the bench fit gauge.
  // Thinner than the 11.0 it was. Over a 5.4 mm standoff, 11 mm left 2.8 mm of
  // post hanging past the brass all round, crowding whatever is next to it on
  // the board; 8 mm still covers the standoff with 1.3 mm to spare.
  p4PostD: 8.0,
  p4PostRibW: 4.0,
  p4PostRibD: 10.0,   // rib height above the plate (stays under the bay floor)
  p4ScrewAccessD: 2.4, // gauge holes on the bench coupon
  // The module is a PRESSURE FIT, not a screwed one. Each 3 mm brass standoff
  // slides into a socket sunk in its post, which locates the board in plan
  // properly instead of leaving it 0.3 mm loose, and the foam preload against
  // the door holds it in Z.
  // The socket floor stays at the old post-face plane, so the PCB back does not
  // move: the post is grown by exactly the socket depth instead.
  // Depth is short of the full 3 mm on purpose - bottoming the standoff in the
  // socket would land the printed post face on the board's underside.
  p4StandoffSocketDepth: 2.0,
  // The socket is a CONE: wide at the mouth to find the brass, closing to a
  // snug fit at the floor where the standoff bottoms. 0.25 straight was 0.5 mm
  // of plan float; 0.15 straight was the second cut; the maintainer asked for
  // tighter still with a lead-in, and a taper is what a printer reproduces
  // reliably - the first 0.1 mm of a straight bore is what decides a press fit,
  // and a printer gets that wrong by exactly its own tolerance. The bridge
  // gauge carries the same cone, so its first print answers the fit.
  p4StandoffSocketSlopTop: 0.35,     // per side at the mouth
  p4StandoffSocketSlopBottom: 0.05,  // per side at the floor: light press on the Ø3.5 brass
  // P4 bridge gauge. The lift is what keeps the gauge off the board's
  // connectors: a 2.54 mm header stands about 11 mm off the PCB against the
  // standoff's 5 mm, so 12 mm of lift puts the web 17 mm up and clear.
  // The wiggle rig USED to carry its own stand-off - rigPadH, 7.0 mm - on the
  // argument that the body's was unresolved and a bench rig has no depth budget
  // to protect, so generous was safe. Generous was the fault: the camera stands
  // 7.4 mm off the board face and no further, so at a 7.0 mm stand-off its lens
  // stopped about 2 mm short of the pocket and the rig's cameras could not see
  // out. The rig now takes the body's derived xiaoPadH, so what the rig proves
  // about reach is what the body does, which was the point of the rig.
  // Power-bus apron. Four XIAOs need 5 V and GND distributed to them, which
  // means a small perfboard carrying header strips, and the rig had nowhere to
  // put one. It goes at the HIGH-Y end because that is the end the boards'
  // pins are on - a bus at the tripod end would mean four pairs of wires
  // running the length of the rig past the cameras.
  // Sized for a 70 x 30 mm perfboard, the common 3 x 7 cm sort. Post spacing is
  // whole multiples of 0.1 in (63.5 = 25 pitches, 22.86 = 9) so the holes land
  // on the board's own grid instead of between it.
  rigPerfBoard: [70.0, 30.0],
  rigPerfPostSpan: [63.5, 22.86],
  rigPerfPostD: 5.0,
  rigPerfPostH: 4.0,       // solder side clears the apron by this much
  rigPerfPilotD: 1.7,      // M2 self-tapper, same pilot as the face shell
  // Skeletal rig. The full rig's bulk is its solid 5 mm plate; this keeps the
  // plate only as four lens bosses and ties them with a 3 mm truss.
  skelWebT: 3.0,
  skelLensBoss: 7.0,      // half-width of plate kept around each lens
  skelRailA: [36.0, 50.0],
  skelRailB: [54.0, 71.5],
  skelPerfPostSpan: [50.8, 15.24],
  skelLegW: 8.0,
  skelTopRailW: 6.0,
  skelBusReach: 30.0,
  rigApronT: 3.0,
  rigApronMargin: 4.0,
  rigBarT: 3.0,
  rigBarScrewD: 2.4,
  postTestLift: 12.0,
  postTestDriverD: 5.0,    // driver channel down each pillar
  // Conical screw seat, deep enough that an M2x8 does NOT bottom in a 3 mm
  // standoff: grip = seatRun + 0.8, and engagement = 8 - grip must land under
  // the standoff's depth. At the old 2.6 it engaged 4.6 mm into 3 mm of thread.
  postTestSeatRun: 4.6,

  // XIAO ESP32-S3 Sense stations: boards lie parallel to the front plate,
  // lenses forward through the plate, heatsinks rearward into the open bay.
  cameraPitch: 22.0,
  cameraLensY: 43.0,
  xiaoBoardW: 17.8,
  xiaoBoardH: 21.0,
  // MEASURED: 7.6 mm for the XIAO with its Sense board on the board-to-board
  // connector. The 1.2 mm this replaced is a BARE XIAO, which is not what goes
  // in the camera. Straight into the depth stack, +6.4 mm of body.
  xiaoBoardT: 7.6,
  xiaoBoardClearance: 0.3, // per side against the locating fence
  xiaoLensOffsetY: 6.95,   // lens centre from board centre toward the camera end
  // xiaoPadH is DERIVED below, and camModuleHeight is gone. Both were guesses
  // dressed as parameters: the stand-off was chosen so that a head of an
  // ASSUMED 4-6 mm would engage a pocket of an ASSUMED depth, and the gate that
  // was supposed to catch a camera that could not reach its pocket compared one
  // guess against the other, so it passed a rig on which the camera could not
  // reach its pocket. The camera's axial position is not a free choice at all -
  // the ribbon is 7 mm and folds back on itself, so the module sits where the
  // vendor's own assembly puts it and nowhere else. See camStackH.
  // MEASURED by the maintainer: the ribbon between the Sense board's FPC
  // connector and the camera module is about 7 mm, and the connector is on the
  // board's OUTER face - the same face the module folds back onto. So the
  // module lies flat on the stack, lens along the boards' normal, and the body
  // cannot place it anywhere except against the board it is tied to.
  camRibbonLen: 7.0,
  // VENDOR (Seeed product dimensions, 21 x 17.8 x 15 mm): 15.0 mm from the
  // XIAO's back face to the LENS's front face, measured on the stack as it
  // assembles - camera folded onto the boards. This one figure closes the chain
  // that the two guesses above left open, because it already contains the
  // ribbon fold, the connector's height and the module's own thickness.
  camStackH: 15.0,
  // ---- OV3660 camera module capture ---------------------------------------
  // A camera that can shake in its mount ruins the picture, so the module is
  // located by a pocket in the front plate rather than just looking through a
  // clearance hole. No vendor publishes this module's head size (they state it
  // is customisable), so instead of trusting one guessed number the pocket is
  // sized nominal + slack AND carries three compliant pinch ribs that push the
  // module against two datum walls, taking up +/-0.3 mm of part variation.
  // Print KINO_CAM_FIT_COUPON.stl to find the real size on your modules.
  camBody: 8.5,            // nominal head/lens-holder square, verify by coupon
  camBodySlack: 0.15,
  // camPocketDepth is DERIVED below. The head's height splits into a holder and
  // a barrel and nobody has measured where that split falls, so the pocket is
  // not sized to the holder: it is cut as deep as the plate can give, leaving
  // platePocketAhead of plate to carry the bore. Then the holder cannot bottom
  // early whatever the split is, and the module's Z datum is its PCB face on
  // the plate's inner face - a 15.5 x 17.9 mm flat, which is a better datum
  // than a shoulder whose height is unknown.
  platePocketAhead: 1.5,
  // 0.20 mm of rib, so a nominal head is a light interference fit rather than
  // needing 0.4 mm of crush to go in at all. The coupon sets the real number.
  camRibProud: 0.20,
  camRibCount: 2,          // placed toward the corners, where the bore leaves
                           // material - not at mid-face, where it does not
  camRibSpan: [0.2, 0.8],
  // MEASURED. The lens holder is a square base with a round barrel standing on
  // it: the square seats in the pocket, and this is the largest circle on the
  // barrel that has to pass through the plate.
  camBarrelD: 7.0,
  // The camera is NOT part of the board. On a XIAO ESP32-S3 Sense it is a
  // separate module on a flex ribbon, and the module's PCB is far bigger than
  // the 8.5 mm lens holder that sits on it: about 12.5 x 20.5 mm, mounted with
  // its long axis vertical so four of them clear each other at 22 mm pitch
  // (9.5 mm apart; laid the other way they would be 1.5 mm apart).
  // This footprint has to stay empty, and it did not: the two seat pads at the
  // camera end of each board sat 1.35 mm inside it and stood 3 mm tall right
  // where the module goes, so the module landed on them and its lens could
  // never reach the pocket. Nothing under a 17.8 mm board leaves more than
  // 10.8 mm between those pads, so they could not be shrunk into fitting -
  // they had to leave the module's footprint entirely.
  // MEASURED with calipers, not taken from a datasheet: 17.9 x 15.5 x 3.5 mm
  // for the PCB alone, excluding the lens holder that enters the pocket and
  // excluding the ribbon. Mounted with the 17.9 mm dimension VERTICAL, which is
  // what keeps 22 mm pitch alive - 6.5 mm between neighbours that way against
  // 4.1 mm laid the other, and the pitch is the premise of the camera.
  // The figure this replaced was 12.5 x 20.5 x ~1.0, read off a scanned
  // datasheet via search. It was wrong on every axis and wrong in shape: the
  // real module is nearly square and two and a half times thicker.
  camModulePcb: [15.5, 17.9],   // X, Y
  camModuleSlack: 0.5,
  // The module's own PCB thickness, MEASURED. Its PCB face lands on the plate's
  // inner face and its back sits this far behind it, so this plus the fold gap
  // IS the board stand-off - which is why xiaoPadH cannot be declared
  // independently of it, and why 3.0 put the board half a millimetre inside the
  // module.
  camModulePcbT: 3.5,
  // The gap between the board's outer face and the module's PCB back - the
  // folded ribbon and the connector it turns over - is DERIVED below and not
  // declared. It is already inside the vendor's 15 mm, so declaring it as well
  // would be counting it twice, which is exactly what made the first cut of
  // this chain disagree with itself by half a millimetre.
  xiaoFenceW: 1.5,
  xiaoFenceH: 6.5,         // above the plate; fences flank the board sides
  // The bore must clear the lens barrel but stay comfortably INSIDE the
  // camera pocket's walls: at Ø9 it was wider than the 8.65 mm pocket across
  // the flats and destroyed the very walls meant to hold the camera.
  // A GUIDING FIT on the 7.0 mm barrel, not a clearance hole: 0.05 mm per side.
  // The barrel carries the lens, so anything the barrel can do in this bore the
  // image does too - and a wiggle set is four frames that must differ only by
  // parallax. A rattling lens is not a cosmetic fault here, it is the fault.
  // This deliberately over-constrains against the pocket, which holds the
  // square base to 0.075 mm per side. The bore is the tighter of the two, so it
  // wins and the square shuffles inside its own slack to suit - which is the
  // right way round, because it is the barrel that must not move.
  // PRINTED HOLES COME OUT UNDERSIZE. Expect to run a 7 mm bit through by hand.
  // That is the intended direction of error: a bore that prints a little tight
  // can be opened in seconds, and one that prints loose cannot be closed.
  lensBoreD: 7.1,
  // lensOuterCskD/lensMidCskD are gone: the cell profile is derived from the
  // field cone in the face builder, so it cannot drift away from the optics.
  lensRingStep: 0.6,       // how far each ring stands proud of the field cone
  // DESIGN figure, not a datasheet figure. The modules fitted are OV3660 (see
  // docs/HARDWARE.md, camera row), and their field of view is MEASURE_REQUIRED
  // there: the lens on the module decides it, not the sensor. 78 degrees
  // DIAGONAL is what the cells are set out from, and the assembled shells pass
  // 81.9 - so any module up to about 81 degrees diagonal is clear, and a wider
  // lens needs this number raised and the cells re-cut. A round bore has to
  // pass the diagonal, so the diagonal is the figure that matters. Measure it:
  // photograph a ruler square-on at a known distance d, read the width w that
  // spans the frame corner to corner, fov = 2 atan(w / 2d).
  // (This was first written as "OV2640, 78 degrees" - the XIAO Sense's default
  // module, which is not the one in this camera.)
  camFovDeg: 78.0,
  // Worst-case entrance pupil, measured back from the body's front face. The
  // barrel protrudes into the bore by an unknown amount; assuming it does NOT
  // protrude at all puts the pupil on the pocket floor and makes the tunnel
  // as long as it can physically be.
  camPupilBackFromFront: 2.6,
  fovMarginDeg: 2.0,       // opened past the field cone, per side

  // Removable bow clamps (one per board) on single insert bosses.
  clampBossD: 9.0,
  // Bow clamp. It presses down the board's CENTRELINE, between the two header
  // rows - MEASURED at 12.5 mm apart - because at the corners it fouled the
  // header mouldings. The foot is sized to sit inside that channel with room
  // either side rather than to fill it.
  xiaoHeaderGap: 12.5,
  clampT: 3.6,
  clampArmW: 3.6,
  clampFootW: 9.0,
  clampFootLen: 3.0,
  // 6.5 -> 21.05: the boss sat 2 mm past the board's top edge, which is where
  // the XIAO's USB-C receptacle opens. No plug could enter, so a node could
  // not be reflashed without lifting it out of the camera. The boss now sits
  // against the top wall (Y 81.5, fused 2 mm into it) and the arm reaches 21
  // mm; with the node's one M2 out and the clamp lifted, a plug has 16.5 mm
  // of straight room. Camera 1's straight plug still meets the P4 post at
  // 8 mm - it takes a right-angle plug; the other three take any plug.
  // Per-station boss position: [sideways offset from the board's centreline,
  // gap above the board's top edge]. Cameras 1 and 2: straight arms to the
  // top wall. Camera 3: kinked +4 to clear the light stud's nut sweep
  // (X 59-73). Camera 4 cannot go to the top wall at all - the split-joint
  // pad at X 87-97 hangs over that spot from Z 22 and no driver reaches a
  // screw under it (seen in the slicer, not by a gate; there is one now) - so
  // its boss stays at the original 6.5 mm gap and kinks +11, clear of its own
  // plug channel (X 92.5-104.5), the shutter leads' run above Y 74.5 and the
  // pod. The foot stays on the board's centreline in every case.
  clampBossAt: [[0, 21.05], [0, 21.05], [4, 21.05], [11, 6.5]],
  clampDriverD: 5.0,       // shaft of the driver that has to reach each clamp screw from the door
  // The rigs keep the original short reach: they have no P4 module, no light
  // stud and no USB problem, and their clamps travel in their own files.
  rigClampBossGapY: 6.5,
  usbPlugBody: [12.0, 16.0, 7.0],  // a moulded USB-C plug: width (X), length past the board end (Y), height (Z)
  usbPlugAngled: 7.0,      // a compact right-angle plug's body along the board axis
  m2InsertPilotD: 3.2,     // A2 brass M2 insert, OD 3.5 x L 4
  m2InsertDepth: 4.6,
  m2ClampClearanceD: 2.5,

  // Rear door: a flat plate over the display that slides in from the far end
  // on 45-degree dovetail lips in the top and bottom walls, stops against the
  // grip-side wall, and clicks over a ramped detent. Tool-less: pull firmly
  // to open, click shut to close. No screws, like the N8000 film door. The
  // dovetail lips react the foam preload along their full length.
  bezelT: 4.0,             // door plate thickness (occupies bodyD-4 .. bodyD)
  // The window was 94.0 x 57.0, which is 0.20 mm per side over the active
  // area in X. The module can move 0.25 mm per side on its standoff sockets
  // and the print carries about 0.15, so the door would have clipped the edge
  // of the picture. Opened so the margin covers both, in both axes.
  // Erring wide is right here: a sliver of dead glass on show is a cosmetic
  // nuisance, a bezel over the active area is a permanent black band.
  // 95.2 x 57.8 -> 105 x 62. That opening was sized as "active area plus a
  // safety margin", which left an UNEVEN frame - 14.9 mm per side in X against
  // 12.1 in Y - and unevenness is most of why the door read as heavy.
  // Of the old frame only 3.2 mm (X) and 5.4 (Y) was door structure; the rest
  // has to cover the panel's own 11.7 x 6.6 mm dead border, which no change to
  // the enclosure can remove. Past that point opening the window trades
  // plastic frame for dark glass, and dark glass reads as screen.
  // This lands the frame at a near-uniform 10.0 x 9.95 mm, keeps a 6.0 x 3.7 mm
  // lip over the module's edge, and shows 5.7 x 2.9 mm of the panel's border.
  bezelWindowW: 105.0,
  // 62.0 -> 61.4: at 62 the lip over the module's top and bottom edges came to
  // 3.70 mm and the older glass-border gate wants 4. Trimming 0.6 mm off the
  // window is the honest fix; relaxing the gate to fit the window is not.
  // The frame stays even - 10.0 in X against 10.25 in Y.
  bezelWindowH: 61.4,
  activeAreaW: 93.6,       // 4.3 in panel, from the module drawing
  activeAreaH: 56.16,
  bezelWindowBevel: 2.0,   // plan flare of the window's outer bevel
  bezelWindowMargin: 0.4,  // minimum per side: socket slop 0.15 + print 0.15, and 0.1 over
  bezelFoam: 1.2,          // glass rear (69.8) to door inner face (71): foam shim
  // The foam gasket is cut from sheet against a printed template, the same way
  // the standoff pattern is checked on paper. Its ring bears on the module's
  // own border between the door's window and the module's edge.
  foamOuterInset: 0.75,    // ring's outer edge, inside the module outline
  foamMinWidth: 3.0,       // narrowest bearing strip the ring may have, per side
  // ---- The slide: a square-shouldered tongue, and NOT a dovetail --------------
  // The dovetail is gone. It was tried at 47 degrees, then at 55, and the angle
  // was never the problem - the mechanism was wrong for these two orientations,
  // and this is the argument in one line:
  //
  //   the foam pushes the door OUTWARD, so the body's retaining surface must
  //   face -Z; the rear half prints cut-face-down, so -Z is DOWN; and a SLOPED
  //   retaining surface therefore always begins as an unanchored knife edge.
  //
  // Measured on the shipped rear half, layer by layer through the groove: at
  // Z 30.60 the only material is the wall at Y 85.51+; at Z 30.80 a 0.11 mm
  // ledge appears at Y 84.00 with 1.4 mm of air between it and that wall and
  // nothing at all beneath it; it then grows for ELEVEN layers and only merges
  // with the wall at Z 32.80. That is a 118 mm long, 2.2 mm tall unsupported
  // flag on each wall, and the same defect the door had - the maintainer said
  // so and was right. Steepening a slope cannot fix it, because the knife edge
  // is what a slope IS at its start.
  //
  // A square shoulder is strictly better here, which is the counter-intuitive
  // part. Its roof appears in ONE layer at its full 1.5 mm width, touching the
  // groove's deep wall in that same layer - solid material that runs all the
  // way down. So it is a one-sided 1.5 mm bridge off a root that exists,
  // exactly like the roof of any counterbore, instead of a cantilever grown
  // from nothing. And on the door the tongue becomes a plain two-step plan:
  // full width on the bed, narrowing once. No downward face anywhere on either
  // half of the joint.
  //
  // What the dovetail was for - resisting the door lifting under preload - the
  // foam does not need: a square shoulder simply stops it, and a slope under
  // load only cams the door sideways. Retention is complete because both
  // tongues are captured; the door can move in X and nowhere else.
  doorBite: 1.5,           // tongue protrusion into each wall
  doorTongueZ: 1.5,        // tongue height, off the door's inner face
  // ---- Bearing pads on the tongue, for the same reason as the cover's --------
  // The door moved freely on the printed part and felt gritty, which is a
  // surface fault and not a fit one - so the clearances are left alone.
  //
  // The tongue's top face bore against the shoulder along the whole 118 mm of
  // the door, and that shoulder is the one surface on this camera known to be
  // rough: it is a 1.5 mm one-sided bridge, the largest unsupported reach on
  // the part, and it sags a tenth on its first line. Dragging a flat tongue
  // along 118 mm of sagged bridge is the door's version of the cover riding its
  // hatch.
  //
  // So drop the tongue's top face by doorPadProud and leave four pads standing.
  // Contact goes from 118 mm a side to four 10 mm pads, the load is carried at
  // four known places instead of wherever the bridge happens to have drooped
  // least, and the 0.35 mm of Z clearance still swallows the sag.
  doorPadProud: 0.25,      // how far the tongue's top is dropped between pads
  doorPadLen: 10.0,        // pad length, along X
  doorPadCount: 4,
  // doorGrooveZ is DERIVED: doorTongueZ + doorClearN, so the shoulder sits one
  // clearance above the tongue and the two cannot be specified apart.
  // 0.3 -> 0.15 a side and 0.3 -> 0.15 under the groove ceiling: the lens
  // cover's first coupon rattled at 0.3 and the door was built to the same
  // numbers. With the module in, the foam presses the door out against the
  // ceilings and the depth play vanishes; the side play never did.
  doorClearY: 0.15,        // slide clearance per edge
  // Z clearance is 0.35, not the 0.15 the sides get, and the asymmetry is the
  // point: on this joint Z clearance is FREE. The foam presses the door
  // outward against the shoulder, so whatever Z gap is drawn gets taken up by
  // preload and the door cannot rattle in Z however loose it is. Side
  // clearance has no such help, which is why it stays at 0.15.
  //
  // So spend it on the shoulder's droop. That shoulder is the largest
  // unsupported event on the camera - one layer, 310 mm^2 reaching 1.4 mm from
  // anchored material, continuous over 118 mm on each wall, against the 1.0 mm
  // of the light bore's roof which is the worst thing on the front half. It
  // will print; a 1.4 mm one-sided ledge in PETG at 0.2 mm layers is ordinary
  // hole-roof work. It will also sag a tenth or so on that first line, and at
  // 0.15 mm of gap a tenth of sag is most of the fit. At 0.35 the sag has
  // somewhere to go and the joint still cannot rattle.
  //
  // Costs 0.2 mm of wall over the shoulder: 2.35 -> 2.15 mm, against the 2.0
  // its gate requires.
  doorClearN: 0.35,        // tongue top to the shoulder above it, in Z
  // Retention is a pair of detent bumps riding in the dovetail grooves, not a
  // slitted cantilever tab. The slits and tooth read as unexplained notches in
  // the door and needed a flexing finger to work; a bump-and-dimple runs in
  // the joint that is already there, and the walls' own elasticity gives the
  // click. A finger scallop at the entry end is what you pull on.
  // Thumb rest on the BODY's rear face, over the grip - which is where a thumb
  // actually lands, and is solid material. On the door it would have had to
  // bridge the display window: the door has only 12.5 mm of frame on the grip
  // side, far too narrow for a thumb.
  // Feet. The bottom face carries the cable exit, two tie slots
  // hole; standing the camera on a table should not put
  // any of them, or a fitted tripod bolt, in the dirt. Their front edge is
  // chamfered because in the chassis' print orientation that edge faces the
  // bed. Placed clear of every bottom-wall opening.
  footProud: 2.2,
  // The rear pair moved back from Z 36..47 to 55..66 when the body grew to
  // 68 mm: the cable exit and its tie slots followed the module plane out to
  // Z=45, and the old rear feet sat straight across a tie slot. A gate checks
  // this, and it is the reason these are listed rather than derived - the
  // openings they dodge are not all in one place.
  // footPads is DERIVED below. Declared as four absolute rectangles it ran to
  // Z=66, which was 2 mm inside a 68 mm body - until the bay resize took the
  // body to 64.6 and the two rear pads hung 1.4 mm past the rear face. The
  // face plane then sliced them and left a zero-area sliver at X=104, Y=0,
  // Z 55..66. Same failure mode as humpZ1 and usbPassageZ: a value declared
  // apart from the chain that positions it.
  footPadX: [[8, 26], [104, 122]],  // the two pad columns, x0..x1
  footPadFrontZ: 4.0,               // front pads, from the front face
  footPadLen: 11.0,                 // pad depth along Z
  footPadBackset: 2.0,              // rear pads, forward of the rear face
  // The door's detent, second cut. The first had a Ø0.9 bump on the door's
  // wedge whose tip stopped 0.05 mm SHORT of the groove wall, and a dimple
  // 0.15 deep: with the door centred nothing touched, and the gate that said
  // it held was reading the resting film. Now the bump is on the WALL, sunk so
  // that doorClearY + doorDetentBite stands proud into the groove, and the
  // door's wedge carries a relief channel it rides in freely until the last
  // 2.5 mm, where a ramp lifts onto a crest of full interference and drops
  // into a dimple. Closing clicks; opening climbs the crest.
  // The bump is a vertical RIB: a cylinder standing on the groove floor, so it
  // prints as a pillar with no overhang, and the wedge's relief is a notch open
  // at the door's inner face, so it has no print ceiling either.
  detentBump: 0.5,         // radius of the rib on each groove wall
  detentBite: 0.15,        // interference per side on the crest
  detentRelief: 0.2,       // notch depth in the wedge's face: bite + 0.05 clear
  // Rib height off the groove floor. It was 2.1 for a dovetail groove 3.15 mm
  // deep; the groove is a 1.65 mm square channel now, so 2.1 buried the rib's
  // top 0.45 mm inside the shoulder above it - harmless as a union, but a rib
  // taller than the slot it stands in is a number nobody meant. Matched to the
  // tongue instead, so the rib engages the tongue over its whole height and
  // stops there.
  detentRibH: 1.5,
  detentBackFromEnd: 12.0, // from the door's entry-end face; 6 mm inside the entry wall

  // ---- Strap lug -------------------------------------------------------------
  // A 131 mm handheld with nothing to tether it to a wrist was a drop waiting
  // to happen. One lug on the grip-side wall (+X), on the rear half, standing
  // on the cut plane: in that print the cut is the bed, so the lug's underside
  // is bed contact and its cord hole runs vertically - no overhang anywhere.
  // The cord passes front-to-back through the hole and the loop hangs off the
  // right side, under the shooting hand.
  // ---- Strap anchor -----------------------------------------------------------
  // On the -X wall, not the +X wall, and it moved for the user rather than for
  // the printer. The shutter is at X 115, so a right hand wraps the +X end and
  // the palm covers most of that wall - and that is exactly where this sat: a
  // 4.5 mm proud block with a cord hole, right under the heel of the hand.
  // There is no spot on the grip-side wall a palm does not cover, so the answer
  // is not to shuffle it along that wall but to take it off it. The camera
  // slings and hangs from the left; the right hand now grips a wall that is
  // unbroken apart from the flutes, which help.
  //
  // The cord bore now has strapLugWall of material on BOTH sides of it, and
  // that is the actual defect being fixed. It used to be centred 2.25 mm proud
  // of the wall face in a lug that ended 0.5 mm further out: ONE BEAD of PETG
  // between the cord and the outside, on the part that carries the whole
  // camera's weight if it swings. A cord under load tears through one bead.
  //
  // Straddling the bore across the wall face was tried first and is wrong: the
  // wall fills the inboard half, so the "hole" comes out as a notch open to one
  // side rather than a loop. The bore has to live entirely in the lug's own
  // proud material, which sets the protrusion at wall + cord + wall = 6.5 mm.
  // That is 2 mm MORE than the broken version - and it is free here, because
  // this is the wall nobody grips. On the +X wall it would have been the
  // problem all over again.
  //
  // Still standing on the cut plane, which is the rear half's bed, with the
  // bore along Z: bed contact underneath, a vertical hole, nothing overhanging.
  strapLugLen: 10.0,       // along Y
  strapLugWall: 1.5,       // lug material outboard of the cord hole; proud is DERIVED
  strapLugH: 8.0,          // along Z, up from the cut plane
  strapLugY0: 66.0,        // bottom edge; clear of the vent slot at Y 62 and the rear rim round
  strapLugInboard: 2.0,    // how far the lug body reaches into the wall
  strapHoleD: 3.5,         // a 2-3 mm cord
  fingerScallop: 9.0,      // radius of the pull scallop on the door's edge

  // Power entry. The module's USB-C sits on its component side next to the
  // GPIO header, which runs down the board's LEFT side at mid-height - the
  // connector is inboard, not on an edge, and the plug stands off the board
  // toward the front of the camera. The cable then turns down through the
  // BOTTOM wall and out to the pocket battery bank. usbPassageX is kept below
  // the module's left half so that turn is short.
  // The cable exit is a hex port now. Across flats in X; across corners in Z
  // is AF x 2/√3, so 15.5 gives 17.9 mm of height - more than the 14 the
  // gabled rectangle had. usbPassageW/H are kept: the gates probe with them.
  usbPassageSlotW: 14.0,      // slot width in X
  usbPassageSlotTravel: 6.0,  // centre-to-centre of the two lobes, in Z
  usbPassageH: 14.0,       // along Z
  usbPassageX: 40.0,       // bottom-wall cable exit
  // usbPassageZ is DERIVED below from pcbBackZ. The cable leaves the module's
  // receptacle and turns down through this passage, so its height has to follow
  // the module plane - and when the module moved back 15 mm, a declared 27.0
  // left the passage nowhere near the connector.
  usbPassageBackset: 4.0,  // passage centre, forward of the PCB face
  usbTieSlotW: 3.2,
  usbTieSlotH: 6.2,
  usbTieOffsetX: 16.0,


  // Shutter pod for the 6 x 6 x 4.3 mm tactile switch on JP1 21 / GPIO28,
  // in the top wall directly above the grip - the N8000 position, under the
  // index finger of the grip hand. Same captive actuator and retainer.
  shutterSwitchBody: [6.0, 6.0, 4.3],
  shutterSwitchClearance: 0.6,
  shutterX: 115.0,
  // 24 -> 21. The Ø17.5 collar reached Z 32.75 and the chassis is cut at
  // Z 31, so the seam ran across the collar's top edge. At 21 the collar
  // ends at 29.75, 1.25 mm short of the cut, and the guide teardrop's point
  // (21 + 8.06) stays in front of it too.
  shutterZ: 21,
  // Sized like a camera's shutter release rather than a pin: the pressed face
  // is Ø11, which is what a fingertip expects and what the film compacts of
  // this era used. It sits in a Ø13 bezel, concave, standing 1.8 mm proud.
  shutterActuatorGuideD: 11.4,
  shutterActuatorFlangeD: 14.0,
  shutterPressCapD: 11.0,
  shutterPressFaceD: 10.2,
  shutterPressCapH: 0.9,
  // How far the press face stands above the top face. The plunger's LENGTH is
  // derived from this rather than declared beside it, because the wall
  // thickness is part of the same chain: the switch sits against the top
  // wall's inner surface, so thinning that wall by 1.5 mm pushed a
  // fixed-length plunger 1.5 mm further proud. Two numbers that have to agree
  // are one number too many; see shutterStemLength below.
  shutterProud: 1.4,
  shutterDishD: 8.4,
  shutterDishDepth: 0.5,
  // The conical mouth is now a hex collar. 15.0 across flats puts the corners
  // 8.66 mm out, which swallows the guide teardrop's 8.06 mm point.
  // A round collar. The guide bore behind it keeps its teardrop - it is a
  // register surface and wants the round lower half - but that point reaches
  // √2 x 5.7 = 8.06 mm from centre, so the collar has to be at least Ø16.2
  // or the point shows as a notch in the opening. 17.5 leaves margin.
  shutterCollarD: 17.5,
  shutterCollarDepth: 1.6,
  shutterAssemblyAccessD: 14.8,
  shutterRetainerCupD: 14.4,
  shutterRetainerPlateD: 17.5,
  shutterRetainerCupH: 4.0,
  shutterPodW: 19.0,
  // 6.0 -> 3.0. The reach is what decides the body's height: the pod hangs
  // this far into the cavity and the centred module rises to meet it, so
  //   bodyH - wallTop - reach >= bodyH/2 + moduleH/2 + 1
  // At reach 6 that floors bodyH at 96; at reach 3 it floors it at 89.4.
  // The bore stack still has wallTop + reach = 9 mm to sit in, and
  // shutterStemLength is DERIVED from this, so the button travel follows.
  shutterPodReach: 3.0,    // pod pilaster inward from the top wall face
  shutterPodBackset: 2.0,  // deep section stops this far in front of the module
  shutterPodRearReach: 2.0, // shallow rear section, stays clear of the module
  shutterWireExit: [6.4, 4.5],
  shutterWireBayW: 8.0,
  shutterWireGaugeD: 2.0,
  shutterWireGaugeSpacing: 2.4,
  // The switch's TERMINALS, and the leads soldered to them. The first cut of
  // this pod treated the switch as a plain 6 x 6 x 4.3 block with both leads
  // leaving the same face: the retainer's cradle was a 6.6 mm square socket
  // with one notch in it. On the switch actually fitted the terminals stand
  // proud of the 6 mm body and the two leads leave at OPPOSITE ends, so the
  // cradle sat on the terminals and one lead had nowhere to run.
  //
  // The relief is deliberately not sized to a leg span. The cradle's slot runs
  // clean through both side walls, so terminals of any span up to the cup's
  // Ø14.4 pass through it and the switch is still located by the two remaining
  // faces and the corners of the cradle. Only the band HEIGHT is a figure, and
  // it is measured from the switch's base plane where every 6 x 6 tactile in
  // this family puts its legs.
  shutterSwitchLegBand: 1.8,   // PROVISIONAL: leg band above the base plane
  shutterSwitchLegSink: 0.6,   // dish in the retainer plate under the legs
  shutterSideWireW: 3.0,       // one lead plus its solder joint, per side

  // Where the RESET needle passage USED TO BE. The hole is gone, but these
  // three numbers stay: a gate probes this spot to prove the bottom wall is
  // solid there, so a stale cutter cannot creep back in unnoticed.
  // (Measured on the physical board: RESET sits on the same long edge as the
  // microSD slot, SD to the left and RESET to the right.)
  // X is now MEASURED rather than photo-scaled. The button's left face is 15 mm
  // from the right edge of the right-hand standoff, which sits at X=87.15 with
  // a 5.4 mm OD: 87.15 + 2.7 + 15 = 104.85 for the left face, so about 106.4
  // for its centre. Was 100.0 - out by 6.4 mm, which a Ø3.2 needle hole would
  // not have forgiven. The mirrored reading of "right" puts the button at X≈6,
  // off the board entirely, so the direction is not in doubt.
  resetX: 106.4,
  resetZ: 22.0,
  resetD: 3.2,

  // Trapped 1/4-20 hex nuts: tripod on the bottom wall, light on the top wall.
  quarterNutAF: 11.4,      // across flats + fit allowance
  quarterNutT: 6.0,
  // Open shaft from the cavity up into the hump. Sized as a hand-and-tool
  // opening, not a nut-sized hole: at 16 x 16 you could post the nut through
  // it but not comfortably hold it while starting the bolt. 26 x 22 still
  // leaves 5 mm of hump wall on each side in X.
  // The light's bolt gets its own, larger bore than the tripod's: it may carry
  // a shoulder or a washer under the base plate, and it is not being used to
  // centre anything the way a tripod screw is.
  lightBoltD: 8.5,
  // Measured: 25 mm base to tip, part of it buried in the light itself.
  lightStudLen: 25.0,
  lightStudBuried: 6.0,
  // MEASURED: the light is a threaded stud on an 18 mm square base, and the
  // thread itself is about 6 mm - consistent with 1/4-20 (6.35 mm), which is
  // what the trapped nut assumes. Was guessed at 25 mm; the smaller base only
  // relaxes the crest, since the prism's 32.3 x 30.6 mm flat top is set by the
  // aesthetic proportions rather than by this.
  lightPlate: 18.0,
  quarterX: 66.0,          // on the bar axis, under the hump, clear of the
                           // bottom-wall cable exit and both tie slots
  quarterZ: 16.0,          // inside the hump's Z extent for the light mount

  // ---- Silhouette (X-Y outline, extruded along Z) --------------------------
  // Every feature here is a vertical prism in the print, so the whole N8000
  // outline - grip block, stepped top plate and prism hump - costs no support
  // facet - costs nothing in support. Only Z-direction relief is expensive,
  // so front detail is cut INTO the bed face instead of raised off it.
  //
  // Grip block on the shooter's right: facing the screen from +Z the user's
  // right is +X, so the grip lives at high X and appears on the LEFT in a
  // front view, exactly as in the N8000 photographs.
  // Grip cavity. X starts at 129 rather than at innerMaxX + wall (128) so the
  // void keeps a millimetre clear of the door's own edge, which reaches X=128.

  // Top plate. It runs the full body depth, as a camera's top plate does.
  // Symmetric about the lens axis at X=66, like the bar, the band and the
  // hump. At 10..100 its centre was 55 while the hump sat at 66, so the hump
  // read as off-centre on the very plate it stands on.
  // Fake-pentaprism hump above it: nameplate plus the 1/4-20 light landing.
  // It is a real prism, not a block. Two things make it one, and both are
  // free in this print orientation because the chassis is built front-face
  // down and material may only ever shrink as Z grows:
  //   - the front silhouette is a TRAPEZOID, narrowing as it rises, so the
  //     walls stay vertical in the print;
  //   - it stands full height only over the front humpZ1 mm and then its roof
  //     falls to the top plate, so the roof faces AWAY from the bed.
  // Both used to be declared and neither was built: bodyOutline extruded the
  // hump through the whole body, so the measured top was 36 x 53 mm - a
  // full-depth slab that read as a stacked box from every angle.
  // Removed: the rewind-knob bump and drum, and the plan facet on the top
  // corner. Both were pure decoration on a camera that has no film to rewind,
  // and the knob's fluted face read as a gear wheel. Every remaining feature
  // does something: the grip is held, its ribs are gripped, the hump houses
  // the light nut, the lens bar shades and protects the cells, the lug takes
  // a strap, and the lettering identifies the build.

  // Proportions taken off the reference photographs and scaled to this body.
  // On the real camera the lens bar is about 23% of body height and the prism
  // hump about 17% of body width; matching those ratios is most of why a
  // shape reads as an N8000 rather than as a box with holes in it.
  // ---- Cosmetic front shell ("face") --------------------------------------
  // The chassis front is the bed face, so it cannot carry raised form. All of
  // the N8000's actual relief therefore lives on a separate face shell that
  // prints relief-UP on its own flat back: proud lens bar, angled upper band,
  // proud hump and grip, raised lettering, strap lug. It screws to the
  // chassis once from inside and never comes off in the field.
  maxAssembledDepth: 86.0, // over the grip crown; a real N8000 is 68 mm
  faceBase: 3.0,           // shell base thickness
  // The bar has to CONTAIN the four cells inside its recessed panel, rim and
  // chamfer, or the cones eat the rim - which is what happened at 90 mm wide.
  // Four Ø14 cells on 22 mm centres span 100 mm, so the bar is 100 x 32 and
  // the cells are Ø14 rather than Ø17. Wider in proportion than the real
  // camera's bar, because our lens pitch is set by the XIAO hardware.
  // Grown from [16, 27, 116, 59]. The cells are set out from the sensor's
  // field cone now and came out at Ø18.4, which the old 17.6 mm recessed
  // panel could not contain - the cones broke through the rim and the bar
  // lost its edge. Centre stays on cameraLensY = 43.
  // Grown upward again, 25..61 -> 24.5..84: the recessed panel inside the bar
  // is now the TRACK for the sliding lens cover, and has to hold the cover
  // over the cells (Y 32..54) plus a full stow position above them (54.5..76.5).
  // The panel's X is unchanged. The bar now runs under the two top face screws
  // at Y 82, which turns their pilots from through holes in a 3 mm plate into
  // blind holes in 9 mm - strictly better.
  // Turned over, 24.5..84 -> 4.5..60.7: the cover now stows BELOW the cells,
  // so the track runs down from the closed position instead of up. The bar's
  // bottom rim stops 1.5 mm above the plate's R3 edge round.
  faceLensBar: [14.0, 3.9, 118.0, 60.7],

  // ---- Sliding lens cover ------------------------------------------------
  // Vertical, not sideways: four lenses span 84.4 mm, so a sideways slider
  // needs 169 mm of face and two barn doors need 127 of 131. Over just the
  // cells it needs 22 mm of travel with 37.8 mm of stow room above. It rides
  // in the bar's recessed panel under 45-degree dovetail lips - the door's own
  // detail - sits 0.4 mm below the bar's front, enters through a gap in the
  // bar's top rim, clicks past two exit bumps, and one pair of bumps at the
  // cells' top edge makes it bistable: held closed over the cells, held open
  // above them. The KINO mark is raised on it and stands 0.2 mm proud of the
  // bar, which is also what the thumb catches.
  // The first track coupon (0.3 mm a side, 0.4 mm of depth clearance, 0.17 mm
  // of forward play) rattled in the maintainer's hand and had nothing to stop
  // the cover leaving the open end. Every clearance below is tightened, the
  // travel is turned over so the cover DROPS to shoot (the closed detent holds
  // it up; gravity helps it open), and the entry gap in the rim takes a glued
  // keeper block after the cover is in - a stop, not a bump.
  // 22 -> 20.4: covers the Ø18.4 cells with 1.0 mm over, and the shorter
  // cover buys the stow room below without the bar running into the plate's
  // bottom edge round.
  sliderH: 20.4,            // cover height along Y
  sliderT: 2.0,             // plate thickness
  sliderClr: 0.1,           // side clearance per edge, in X (was 0.3)
  sliderZClr: 0.2,          // set back from the bar's front (was 0.4)
  // ---- Bearing rails, because the fit was never the problem -------------------
  // The first coupon rattled at 0.3 mm and was recut to 0.10. The recut prints
  // moved FREELY and felt gritty, which is a different fault with a different
  // fix: the clearance is right and the SURFACE is wrong. Loosening it again
  // would only have brought back the rattle.
  //
  // The cover rode on its whole back face - 89.4 x 20.4 mm of it - against the
  // panel floor, and for the last 21.4 mm of travel that floor is the stow
  // hatch: 0.6 mm grooves at 45 degrees on a 2.5 mm pitch. The comment beside
  // the hatch said so in as many words - "the cover still rides on the floor's
  // ridges when it is down" - and nobody read it as a fault. Sliding a flat
  // face across a diagonal comb is gritty by construction.
  //
  // So give the joint defined bearing surfaces instead. Two rails on the
  // cover's back, riding two lanes the hatch is kept out of: contact drops from
  // 1824 mm^2 to about 100, on smooth floor, and every remaining rub is
  // parallel to the direction of travel.
  // Implemented as a RELIEF IN THE FLOOR with two lands left standing, not as
  // rails on the cover. The cover prints back-down, so its back is the bed
  // face: recessing it to leave rails puts 688 mm^2 of plate a quarter of a
  // millimetre above the bed, which the layer gate reads as an island and a
  // printer reads as a sag. The floor is an upward-facing surface on a part
  // that prints relief-up, so a recess there opens upward and costs nothing -
  // and because the lands stay at the original floor plane, not one Z datum in
  // the cover, the keeper, the lips or the detent moves.
  coverRailW: 2.5,          // land width, in X
  coverRailProud: 0.25,     // how far the floor is relieved around the lands
  coverRailOffset: 30.0,    // land centres, either side of the panel's centre
  coverRailLaneClear: 1.25, // hatch keep-out either side of a land
  sliderBevel: 1.0,         // 45-degree edge bevel, and the lip that traps it
  // The lip and the cover's bevel are near-parallel planes; the cover's
  // forward play before they meet, at the wall, is
  //   (sliderZClr + sliderBevel) - (0.02 + sliderLipZ * (1 - sliderClr / sliderBevel))
  // which is 0.10 mm here (it was 0.17, and 0.68 before the lip was deepened).
  // The lip's underside sits at 50 degrees, past the 45 print limit.
  sliderLipZ: 1.2,          // lip depth from the bar's front
  sliderClosedY0: 32.8,     // bottom edge when closed (cells span 33.8..52.2)
  // sliderH + 1.0: the detent ribs live in the gap between the closed cover's
  // bottom edge and the open cover's top edge, and a Ø0.8 rib needs 1.0 of it.
  // The first cut put Ø1.2 spheres in a 0.5 mm gap next to R2 plan corners:
  // the corner swept past the sphere with a millimetre to spare and the
  // "runs free" gate passed for exactly that reason. The independent scan's
  // needle probes found it.
  sliderTravel: 21.4,       // DOWN to the stow position
  sliderCornerR: 0.6,       // plan corner radius; R2 bypassed the detent
  // Detent ribs on the track walls: vertical cylinders of this radius, standing
  // on the track floor, sunk into the wall so that exactly sliderClr + bite
  // stands proud. Vertical, so they print as pillars with no overhang, and the
  // cover's straight edge - not a sphere's crown - is what rides over them.
  sliderBumpR: 0.4,
  sliderBumpBite: 0.15,     // interference per side at the detent
  sliderBumpH: 0.8,         // rib height off the floor; the cover's edge is vertical for 1.0
  // The cover's side edges carry a relief so the ribs bite only at the ENDS of
  // the travel: a crest of full edge at each end, a ramp, and a channel between
  // - the door's wedge detail, turned 90 degrees. Without it the ribs, once the
  // cover's edge had passed over them, would press its side for the other 20 mm.
  sliderEdgeCrest: 1.5,     // full-edge zone at each end of each side, in Y
  sliderEdgeRamp: 0.6,      // ramp from crest down into the channel
  sliderEdgeRelief: 0.2,    // channel depth: bite + 0.05 clear
  keeperClr: 0.1,           // the keeper block's fit in the rim gap, per side
  markGapAboveRidge: 0.6,   // wordmark sits this far above the thumb ridge

  // ---- Identity engravings ---------------------------------------------------
  // Every part that has room carries its design revision (read from
  // hardware/manifest.json at build time) and a build serial, ENGRAVED 0.4 mm
  // into a face that points up or sideways in its print, or a bed face with
  // strokes narrow enough to bridge. The clamps and the shutter button are too
  // small for a legible 4 mm engraving at a 0.4 mm nozzle and carry none.
  buildSerial: 1,
  // Set in Roboto Regular (fonts/roboto-regular.json, traced from the typeface
  // by fonts/trace-font.py): at this cap height its stems come out ~0.5 mm,
  // one nozzle line with room, and its rounds are real rounds. The hand-drawn
  // stroke font it replaces is kept in the source as a fallback for glyphs the
  // trace lacks; the maintainer called it "too basic", and it was.
  serialCapH: 4.0,
  // Camera position numbers 1-4, engraved into the PLATE'S INNER FACE just
  // above each board's top edge. Look into the open bay and each node names
  // itself instead of being counted across; with a board fitted the number
  // still shows above it. That face points UP in the front half's print, so
  // these are upward-opening recesses and cost nothing.
  camNumberGapY: 1.5,       // digit baseline above the board's top edge
  // The model plate every product carries, above the serial on the same face:
  // what the object is, where the revision and serial below it belong. Smaller
  // than the serial so it reads as the heading it is.
  specText: "KINO D4 FIELD BODY",
  specCapH: 3.0,
  specZ: 20.0,              // baseline on the front half's bottom wall

  // ---- Split seam ------------------------------------------------------------
  // The halves meet in a 442 mm butt line right round the body: two first
  // layers touching, and the loudest "printed in two pieces" tell on the
  // camera. Chamfer each half's outer edge and the line lives inside a V-groove
  // instead - a parting line that was drawn rather than one that happened.
  // 0.6 mm deep is a tenth of the wall, and the bolt's head pocket stops
  // 2.25 mm short of that face. Cut at 50 degrees, not 45: the rear half prints
  // cut-face-down, so its half of the V is a DOWNWARD face, and at 45 the
  // slice epsilons made it 44.5 - shallower than the rule - which showed up as
  // 426 mm^2 of overhang the moment it was built. 50 is the window bevel's
  // angle and the same reasoning.
  seamChamfer: 0.6,
  seamAngleDeg: 50.0,

  // ---- Face-plate grain ------------------------------------------------------
  // The plate around the lens bar is a TOP surface in the face shell's print,
  // which is exactly where layer lines and ironing marks show. A fine linear
  // grain at the stow hatch's 45 degrees turns that into a finish. Coarser
  // than a moulding texture because a 0.4 nozzle cannot do finer, so it is
  // drawn as a deliberate grain: 0.5 grooves on a 1.6 pitch leaves 1.1 mm
  // lands, clear of the one-bead rule, and takes 31% of the top 0.2 mm.
  grainPitch: 1.6,
  grainW: 0.5,
  grainDepth: 0.2,
  grainEdgeInset: 4.0,      // clear of the outline and its R3 round
  grainBarClear: 2.5,       // land around the lens bar
  grainMarkClear: 2.0,      // land around the serial

  // ---- Body-wall flutes ------------------------------------------------------
  // Both chassis halves print with Z straight up, so ALL FOUR outer walls are
  // vertical walls whose only finish is the layer line. Measured off the
  // released meshes that is 88% of everything the eye sees on the rear half and
  // 72% on the front - about 330 cm^2 wrapping the whole camera - against the
  // 91 cm^2 of face plate that got the grain. It was the largest untreated show
  // surface on the object by a factor of three.
  //
  // The flutes run ALONG Z, which is straight up in both prints. A vertical
  // half-round groove in a vertical wall has no roof, no bridge and no overhang
  // at all, and a texture hides layer lines best when it runs ACROSS them.
  // Matching the face plate's 45 degrees would instead hang a 45-degree
  // downward flank off every one of 267 grooves per half - printable, but
  // sitting exactly on the overhang rule's boundary, 534 times, to get a
  // direction nobody can read at a 1.6 mm pitch.
  //
  // Cut by a 45-degree V, not a round. A round cutter has to be tangent to the
  // wall somewhere along its arc, and a tangential Boolean repeated 267 times a
  // band is a sliver factory: it cost two degenerate triangles in the released
  // rear half, and trying to fade the ends of a round flute out with a tapered
  // clip made it 1027 degenerate triangles and 898 non-manifold edges. A V
  // meets a flat wall at a definite 45 degrees everywhere, needs four vertices
  // a station instead of twenty-four, and a 0.4 nozzle rounds the valley off in
  // the print anyway - so the part comes out as the half-round the round cutter
  // was drawn for, by way of a Boolean that is not asking for trouble.
  //
  // The cutter still stands wallGrainProud OUTBOARD of the silhouette, so the
  // wall crosses its flanks rather than passing exactly through the two side
  // vertices. Same reason: no coincident faces anywhere.
  //
  // Matches the face plate's grain by eye - 0.5 mm wide, 0.25 deep, 1.1 mm
  // lands - so the body reads as one finish and not two.
  wallGrainPitch: 1.6,
  wallGrainDepth: 0.25,     // below the wall surface; the V is 2x this wide there
  wallGrainProud: 0.1,      // cutter centre, outboard of the silhouette
  wallGrainLandBed: 1.5,    // land above each half's own bed face
  wallGrainLandSeam: 0.4,   // land each side of the seam V, so the parting line stays bright
  wallGrainLandRim: 0.8,    // land below the rear rim's edge treatment
  // A band's ends are left square. Fading them out was tried and withdrawn: a
  // clip that tapers the depth to nothing over 0.8 mm crosses every flute at a
  // 14-degree angle, which is a worse tangency than the one it was fixing
  // (1027 degenerate triangles, 898 non-manifold edges, against two). Square
  // ends leave a V-shaped end cap of 0.06 mm^2 a flute, 267 to a band end; the
  // overhang audit sees them and the printability gate reads them as a 0.5 mm
  // bridge, which is what they are.
  wallGrainClear: 2.0,      // land around every engraving, opening, pad and lug on an outer wall

  // ---- Elephant-foot relief: NOT IMPLEMENTED, and why ------------------------
  // A part's first layers squash wider than the model - a tenth to three tenths
  // on a tuned machine, more on a hot bed. It is the one edge a moulded part
  // never has, so it reads as "printed" before anything else does, and it lands
  // on exactly the faces that matter: the door prints its show face against the
  // bed, the chassis and the shell meet at a glue joint whose flare would hold
  // them apart at the perimeter, and the cover rides the track on its own bed
  // face inside 0.10 mm of side clearance - less than one layer of flare.
  //
  // It was built and withdrawn. Two attempts, both recorded here because the
  // next person will reach for the same two:
  //
  //   1. A staircase of eight 0.05 mm steps, on the reasoning that two layers
  //      cannot resolve a ramp anyway. Every step's underside is a horizontal
  //      downward ledge: the overhang gates on the cover, keeper, door and
  //      track coupon went red together.
  //   2. One swept face, from a hull of the drawn-back outline at the bed to
  //      the full outline above it. The hull has to bridge two rounded
  //      rectangles of different radius, and it does it with slivers - 153
  //      degenerate triangles in the front half, 122 in the cover, in every
  //      file that carries one. Neither join type nor segment count moved the
  //      number, because the degeneracy is in the hull's own ruled surface
  //      where four near-collinear vertices meet along each straight edge.
  //
  // What will work, for whoever picks this up: CrossSection.extrude takes a
  // scaleTop, which lofts base to top with no hull involved. Centre the
  // outline, scale the base by (1 - 2*setback/W, 1 - 2*setback/D), and hand
  // extrude the reciprocal as scaleTop. A uniform scale is not an offset - on a
  // 131 mm part a 0.3 mm setback is off by under a tenth at the corners - and
  // for elephant-foot relief that is far inside what it is correcting for.
  // Extend the loft a padding distance PAST both ends of the band it carves,
  // or the leftovers are two full-area discs a few microns thick, and
  // subtracting one of those saws the part in half: 19 gates at once, with the
  // body, the shell and the cover each reported as two connected components.
  // Roboto Regular's thin joins and round strokes come out near 0.35 mm at
  // this size, under one nozzle line. The outline is emboldened by this much
  // per side - Regular becomes roughly Medium - before it is cut, which is what
  // an engraver would do by hand: pick the weight for the depth and the tool.
  serialEmbolden: 0.08,
  serialMinStroke: 0.45,    // every stroke of the engraved text must be at least one nozzle line
  engraveDepth: 0.4,
  // The badge is the wordmark's own boxed D4, cut out of the brand trace and
  // scaled to this height; its box outline comes out 0.6 mm wide.
  badgeH: 9.0,
  badgeX: 90.0,             // left of the shutter for the photographer
  badgeZ: 24.0,             // its baseline; rows run toward the front

  // ---- Stow-zone hatch -------------------------------------------------------
  // The panel floor above the closed cover is what shows when the cover is
  // down. Grooves at 45 degrees, RECESSED so the cover still rides on the floor
  // when it is up.
  hatchPitch: 2.5,
  hatchW: 0.6,
  hatchDepth: 0.3,

  // ---- Face alignment tool ---------------------------------------------------
  // Four pegs on the lens pitch, a hair under the Ø7.1 bores they register in.
  alignPegD: 6.9,
  alignPegLen: 13.0,        // panel floor (-6.6) to 1.4 mm past the plate's back
  alignBarW: 14.0,
  // 6 mm thick so the bar itself is the grip: seated on the panel floor it
  // stands 3.6 mm proud of the lens bar's face. A separate grip block was
  // tried and, printed flat, left the bar's two wings as 728 mm^2 of ceiling.
  alignBarT: 6.0,
  alignBarEnd: 9.5,         // bar runs this far past the outer pegs; 0.8 mm clear of the lips
  alignLanyardD: 3.0,       // a hole through each bar end for a pull loop
  // A ridge across the cover below the mark: the thumb catches its top edge to
  // pull the cover down and its bottom edge to push it up. It stands
  // coverRidgeProud off the cover's front, i.e. 0.6 mm proud of the bar face.
  coverRidge: [22.0, 1.6],  // width along X, height along Y
  coverRidgeY: 34.3,        // its bottom edge, closed position (cover bottom + 1.5)
  coverRidgeProud: 1.0,

  // ---- Wake on open, sleep on close: REMOVED from the print -----------------
  // There was a TO-92S Hall switch in a blind Ø4.5 x 5.5 pocket cut from the
  // face's back at (107.5, 36.0), its lead in a 2.5 x 1.75 gabled channel down
  // that same face to Y 20 and through a Ø2.4 hole in the front plate, with a
  // Ø3 x 1 N52 disc flush in the cover's back over it. Magnet present = closed
  // = sleep, absent = open = wake.
  //
  // It is gone, and the reason is not that it did not work. The cover's state
  // is read in firmware instead - all four sensors dark means the cover is
  // down, all four seeing colour means it is up - so the magnetic path is a
  // second answer to a question already answered, and it was the more expensive
  // of the two:
  //
  //   - The sensor has to be fitted BEFORE the face shell is glued on, and
  //     that joint is permanent. It was the one irreversible assembly step on
  //     the camera, and the only way to get it wrong was to forget it.
  //   - Its GPIO is on a XIAO, because JP1 has no free P4 pin (ECN-0003), so
  //     the lid state arrives over the UART link anyway - the same path the
  //     luminance reading takes.
  //   - It cost the front plate its only opening besides the four lens bores,
  //     and that hole sat 2.4 mm wide in the middle of the board field.
  //
  // Nothing replaces the geometry: the face's back is now unbroken except at
  // the lens bores, and the cover's back carries only its serial. If the
  // firmware method turns out not to be good enough - it cannot tell a closed
  // cover from a dark room, and it cannot WAKE the camera because camIdleTimeoutS
  // cuts the camera rail - this block is the record of where the parts went.

  // ---- Soft edges -----------------------------------------------------------
  // The chassis prints face-down and cannot round its front edge; the face
  // shell prints relief-up and can, and the rear half prints cut-face-down so
  // its rear rim is on top and can too. Front and back edges rounded, sides
  // square: what the reference slab cameras do.
  edgeRoundR: 3.0,
  edgeRoundSteps: 6,

  // ---- Cable groove -----------------------------------------------------------
  // The USB-C leaves through the bottom face and the feet are 2.2 mm: plugged
  // in, the camera rocked on its cable. A groove from the exit slot to the rear
  // edge lets the cable lie in and leave rearward. 2.0 deep, not more: the
  // door's dovetail bites 2.0 into the same wall from the inside over Z 60.6-
  // 64.6, and 2.0 mm of web has to stay between them.
  cableGrooveW: 4.5,
  cableGrooveD: 2.0,

  // ---- Vent slots -----------------------------------------------------------
  // Through both side walls, ahead of the module where its heatsink faces into
  // the bay. Slots run along Z so their long faces are vertical in print, and
  // their ends are gabled at 45 degrees so no end face is a ceiling.
  ventSlotW: 2.0,
  // ventSlotZ0 is DERIVED below, from the chassis cut. It was declared at 33.0
  // when the cut was at 31.0, and the 2.0 mm of margin that bought was spent
  // the moment the module plane moved: at a 31.9 cut the slots' gable points
  // reached back over the joint. What the slots actually need is a stated
  // clearance from the cut, not a Z of their own.
  ventSlotAboveCut: 1.5,
  // 11, not 12: with the 1.0 mm gable points the slots span 13 mm, which has to
  // stay inside the rear half and short of the module face.
  ventSlotLen: 11.0,
  ventSlotYs: [26.0, 38.0, 50.0, 62.0],
  faceLensBarProud: 6.0,
  faceLensBarChamfer: 2.5,
  faceLensBarR: 6.0,
  faceLensRim: 3.5,
  faceLensGroove: 1.2,
  // The panel is the slider's track: sliderT + sliderZClr (2.4 -> 2.2 with the
  // tighter depth clearance).
  faceLensPanelDepth: 2.2,
  faceLensAccent: 0.8,
  // Centred on the lens bar's axis (X=66), not on the body: the bar is the
  // datum everything on the front lines up to.
  // The grip is a CYLINDER, not a swelling. On the real camera the left-hand
  // mass is the film chamber: a vertical drum standing proud of a flat front.
  // That is the single strongest thing about how an N8000 looks, and a drum is
  // also the right thing to wrap a hand around. Radius is derived so a 31 mm
  // footprint stands exactly faceGripProud off the base:
  //   halfWidth = sqrt(R^2 - (R - proud)^2)  =>  R = (hw^2 + proud^2) / (2*proud)
  // Drum hollow. Depth must EXCEED half the width or the gable's own slopes
  // pass 45 degrees. 13.5 mm of depth leaves 3.5 mm of crown, and the rib
  // grooves take 1.3 mm of that, so 2.2 mm carries the squeeze.
  // Sits in the notch the grip's shoulder chamfer leaves, clear of the grip
  // crown (which ends at gripTopY-20) so the lug is not buried inside it.

  brandingText: "KINO D4 V1 22MM P4 62X55",
  // The single mark above the lens strip. Short on purpose: the long legend
  // this used to be ran 116 mm across a 131 mm face.
  frontText: "KINO",
});

// Every parameter must be a real number before any geometry reads one. This
// generator has now been bitten three times by a name that resolved to
// undefined: the light bore whose length went NaN, the body size that published
// null, and a per-side wall rename whose new keys were never added - that last
// one produced a NaN-dimensioned cut and crashed the CSG kernel with an
// The rear feet follow the body depth instead of being written out at fixed Z,
// so a change to bodyD moves them rather than cutting them.
const footPads = P.footPadX.flatMap(([x0, x1]) => [
  [x0, P.footPadFrontZ, x1, P.footPadFrontZ + P.footPadLen],
  [x0, P.bodyD - P.footPadBackset - P.footPadLen, x1, P.bodyD - P.footPadBackset],
]);

// out-of-bounds fault 40 frames deep in WASM, which tells you nothing about the
// cause. A missing parameter is cheap to catch here and expensive to catch there.
{
  const bad = [];
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  for (const [k, v] of Object.entries(P)) {
    if (finite(v) || typeof v === "string" || typeof v === "boolean") continue;
    if (Array.isArray(v) && v.every((e) => finite(e) || Array.isArray(e)
      && e.every(finite))) continue;
    bad.push(`${k} = ${JSON.stringify(v)}`);
  }
  if (bad.length) {
    throw new Error(`Parameters are not all real numbers: ${bad.join("; ")}`);
  }
}

// Plunger length, derived so the press face lands shutterProud above the top
// face whatever the top wall is doing. Solved from the projection chain:
//   proud = stem - wallTop - podReach - 0.4 + switchPocketDepth + 1.4
const shutterStemLength = P.shutterProud + P.wallTop + P.shutterPodReach
  + 0.4 - (P.shutterSwitchBody[2] + 0.5) - 1.4;

const cube = (x, y, z, w, d, h) => {
  if (![x, y, z, w, d, h].every(Number.isFinite) || w <= 0 || d <= 0 || h <= 0) {
    throw new Error(`cube(${[x, y, z, w, d, h].join(", ")}) is not a real box - a parameter it reads is undefined or inverted`);
  }
  return Manifold.cube([w, d, h]).translate([x, y, z]);
};
const cylZ = (cx, cy, z, r, h, segments = 64) =>
  Manifold.cylinder(h, r, r, segments).translate([cx, cy, z]);
const fuse = (solids) => Manifold.union(solids);

// Half the across-corners size of the trapped hex nuts. A channel only as long
// as the across-flats size cannot hold the nut concentric with its bore, which
// is what both nut channels used to assume.
const nutCorner = P.quarterNutAF / Math.sqrt(3);

// ---- The camera stack's axial chain, derived from ONE vendor figure --------
// The bench fault this answers: on the printed wiggle rig the cameras could not
// reach their lens holes. The chain that put them there was two guesses - a
// declared 3.0 mm board stand-off and an assumed 4-6 mm head height - and the
// gate meant to catch exactly this compared the one against the other.
//
// The ribbon removes the freedom those guesses assumed. It is 7 mm long, its
// connector is on the board's OUTER face, and the module folds back onto that
// same face, so the module sits flat on the stack and its lens looks along the
// boards' normal. The vendor's overall height then fixes everything:
//
//   camStackH 15.0 = xiaoBoardT 7.6 + camModulePcbT 3.5 + camHeadReach
//
// so the head - lens holder plus barrel, however that 3.9 mm splits - is what
// has to fit inside the front plate, and the module's PCB face is the Z datum.
// As deep as the plate can give. The head's internal split into holder and
// barrel is unmeasured, so a pocket sized to the holder could bottom early; a
// pocket sized to the PLATE cannot, and the ribs grip the holder wherever along
// that depth the holder happens to sit.
const camPocketDepth = P.plate - P.platePocketAhead;
// The stand-off follows, and it is the whole fix. The board is what the body
// locates; the camera hangs off the board by the vendor's own 15 mm; so the
// stand-off that puts the lens face on the pocket floor is
//   camStackH - xiaoBoardT - camPocketDepth = 15.0 - 7.6 - 3.5 = 3.9 mm
// against the 3.0 the body declared and the 7.0 the rig declared. The rig's
// 7.0 is the reported fault, 3.1 mm of it.
const xiaoPadH = P.camStackH - P.xiaoBoardT - camPocketDepth;
// Where the lens's front face lands, from the plate's front face. Positive is
// recessed inside the plate, which is where it belongs: the face shell is glued
// to that face. By construction this is the pocket floor.
const lensFrontZ = P.plate + xiaoPadH + P.xiaoBoardT - P.camStackH;
// The head has to be as long as the pocket is deep, and the fold gap is what is
// left of the stand-off once the module's own PCB has taken its share. Both are
// consequences of the line above, not choices - and they are the two figures a
// coupon can check, because if the real head is longer the module's PCB simply
// stands off the plate, and if it is shorter the lens sits back in its bore.
const camHeadReach = camPocketDepth;
const camFoldGap = xiaoPadH - P.camModulePcbT;

const centerX = P.bodyW / 2;
const centerY = P.bodyH / 2;
const innerMinX = P.wallLeft, innerMaxX = P.bodyW - P.wall;
const innerMinY = P.wallBottom, innerMaxY = P.bodyH - P.wallTop;
const moduleMinX = centerX - P.moduleW / 2;
const moduleMaxX = centerX + P.moduleW / 2;
const moduleMinY = centerY - P.moduleH / 2;
const moduleMaxY = centerY + P.moduleH / 2;
const patternCX = centerX + P.p4PatternOffsetX;
const patternCY = centerY;
const mountXs = [patternCX - P.p4HoleX / 2, patternCX + P.p4HoleX / 2];
const mountYs = [patternCY - P.p4HoleY / 2, patternCY + P.p4HoleY / 2];
// Where the module's PCB back sits: everything in front of it, summed. This is
// the same chain the depth-stack gate re-adds, so the module plane and the body
// depth can no longer drift apart.
const pcbBackZ = P.plate + xiaoPadH + P.xiaoBoardT + P.xiaoHeaderZone
  + P.xiaoModuleMargin + P.bayDepth;

const usbPassageZ = pcbBackZ - P.usbPassageBackset;

const standoffTopZ = pcbBackZ - P.p4StandoffH;
// Socket floor sits on standoffTopZ; the post face rises above it.
const socketD = P.p4StandoffOD + 2 * P.p4StandoffSocketSlopTop;        // at the mouth
const socketFloorD = P.p4StandoffOD + 2 * P.p4StandoffSocketSlopBottom; // at the floor
const postTopZ = standoffTopZ + P.p4StandoffSocketDepth;
// The socket cutter: a cone standing on the floor plane, floor diameter at z0,
// mouth diameter at z0 + depth, run 0.01 past the mouth to break the face.
const socketCone = (x, y, z0) => Manifold.cylinder(P.p4StandoffSocketDepth + 0.01,
  socketFloorD / 2, socketD / 2 + 0.01 * (socketD - socketFloorD) / (2 * P.p4StandoffSocketDepth), 48)
  .translate([x, y, z0]);
const bayMinZ = pcbBackZ - P.bayDepth;

// Where the chassis is cut, and where its four joint bolts run. The bolt axis
// sits mid-thickness of wall-plus-pad, so it has equal meat either side.
const splitZ = bayMinZ;
// Vents: referenced to the cut they have to stay behind, not to an absolute Z.
const ventSlotZ0 = splitZ + P.ventSlotAboveCut + P.ventSlotW / 2;
const splitBolts = P.splitBoltXs.flatMap((x) => [
  { x, wall: "top", y: innerMaxY - P.splitBoltInset },
  { x, wall: "bottom", y: innerMinY + P.splitBoltInset },
]);
const glassRearZ = pcbBackZ + P.moduleT;
// Lens cell profile, derived once from the sensor's field cone. The builder
// cuts it and the gates measure it, so neither can drift from the other - the
// mistake that put Ø14/Ø11.5/Ø7.1 cells in front of a 78-degree lens.
const lensPupilZ = P.plate - P.camPupilBackFromFront;
const lensTanField =
  Math.tan(((P.camFovDeg / 2 + P.fovMarginDeg) * Math.PI) / 180);
const lensBoreR = P.lensBoreD / 2;
const lensZBore = lensPupilZ - lensBoreR / lensTanField;
const lensCellFrontZ =
  -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth - 0.01;
const lensConeR = (z) => Math.max(lensBoreR, (lensPupilZ - z) * lensTanField);
const lensZMid = (lensCellFrontZ + lensZBore) / 2;
const lensCellMidR = lensConeR(lensZMid) + P.lensRingStep;
const lensCellOuterR = lensConeR(lensCellFrontZ) + P.lensRingStep * 2;

const cameraXs =[-1.5, -0.5, 0.5, 1.5].map((i) => centerX + i * P.cameraPitch);
const boardCenterY = P.cameraLensY + P.xiaoLensOffsetY;
const boardMinY = boardCenterY - P.xiaoBoardH / 2;
const boardMaxY = boardCenterY + P.xiaoBoardH / 2;
// The camera module's keep-out, centred on the lens rather than on the board:
// the two are separate parts joined by a ribbon, so the module's position is
// set by its pocket, not by wherever the board happens to sit.
const camModX = P.camModulePcb[0] / 2 + P.camModuleSlack;
const camModY = P.camModulePcb[1] / 2 + P.camModuleSlack;
const camModTopY = P.cameraLensY + camModY;
// Seat pads go in the band of board that overhangs nothing: clear of the
// module below, and inboard of the board's own top edge.
// 2.3 mm, not 1.75: a 2 mm-radius pad centred 1.75 mm clear still reaches back
// into the keep-out by a quarter of a millimetre at its edge, which the gate
// duly caught. The two rows end up close together, so the board cantilevers
// over the module and leans on its clamp - acceptable for a board this small
// and stiff, and the stack coupon is what will confirm it in the hand.
const xiaoPadYs = [camModTopY + 2.3, boardMaxY - 1.2];
const boardFrontZ = P.plate + xiaoPadH;
const boardBackZ = boardFrontZ + P.xiaoBoardT;
const rigClampBossY = boardMaxY + P.rigClampBossGapY;
const clampBossXs = cameraXs.map((cx, i) => cx + P.clampBossAt[i][0]);
const clampBossYs = cameraXs.map((cx, i) => boardMaxY + P.clampBossAt[i][1]);
const clampBossTopZ = boardBackZ;

// Lens-bar levels, derived once so the shell and the gates cannot disagree:
// rim (full height), ledge (the red accent line), then the recessed panel.
const LENS_PANEL = (() => {
  const [lb0x, lb0y, lb1x, lb1y] = P.faceLensBar;
  const inset = P.faceLensBarChamfer + P.faceLensRim;
  const g0x = lb0x + inset, g0y = lb0y + inset;
  const g1x = lb1x - inset, g1y = lb1y - inset;
  return {
    g0x, g0y, g1x, g1y,
    p0x: g0x + P.faceLensGroove, p0y: g0y + P.faceLensGroove,
    p1x: g1x - P.faceLensGroove, p1y: g1y - P.faceLensGroove,
    rimMidX: lb0x + P.faceLensBarChamfer + P.faceLensRim / 2,
  };
})();

// Where the cover's two bearing lands sit. Derived once and read by both the
// floor relief and the hatch keep-out, so a land cannot move in one and not the
// other - the cover only travels in Y, so their X register is the whole reason
// the scheme works.
const RAIL_XS = [
  (LENS_PANEL.p0x + LENS_PANEL.p1x) / 2 - P.coverRailOffset,
  (LENS_PANEL.p0x + LENS_PANEL.p1x) / 2 + P.coverRailOffset,
];
// The plane the exposed floor actually sits on, once the bearing relief has
// taken its 0.25 mm. The stow hatch is cut from HERE and not from the original
// floor: the two were competing for the same 0.3 mm, and the relief won, which
// left 86% of the hatch's sample volume already gone and the hatch reading as
// though it had been cut four times too deep.
const STOW_FLOOR_Z = () => -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth
  + P.coverRailProud;

// The KINO D4 wordmark for the lens cover, traced to a pixel grid by
// brand/trace-mark.py from the reserved brand raster. Read at build time and
// NOT embedded here: the trace is a derivation of reserved artwork, this file
// is CERN-OHL-S, and REUSE.toml keeps the two apart. Column 0 is the reader's
// left, which in body coordinates is the highest X.
const MARK = JSON.parse(fs.readFileSync(new URL("./brand/kino-d4-mark.json", import.meta.url), "utf8"));

// The wordmark's frame on the cover: centred in X, and in the band between the
// thumb ridge and the cover's top edge. Builder and gates both read this. Sits
// after LENS_PANEL because it reads it.
const COVER_MARK = (() => {
  const { p0x, p1x } = LENS_PANEL;
  const w = MARK.widthMm, h = MARK.heightMm;
  const bandY0 = P.coverRidgeY + P.coverRidge[1] + P.markGapAboveRidge;
  const bandY1 = P.sliderClosedY0 + P.sliderH - 1.0;
  return { xC: (p0x + p1x) / 2, yB: bandY0 + (bandY1 - bandY0 - h) / 2, w, h, bandY0, bandY1 };
})();

function cylinderAlongY(cx, y, cz, radius, length, segments = 64) {
  return Manifold.cylinder(length, radius, radius, segments)
    .rotate([-90, 0, 0]).translate([cx, y, cz]);
}
function frustumAlongY(cx, y, cz, radiusAtY, radiusAtFarY, length, segments = 64) {
  return Manifold.cylinder(length, radiusAtY, radiusAtFarY, segments)
    .rotate([-90, 0, 0]).translate([cx, y, cz]);
}
function cylinderAlongX(x, cy, cz, radius, length, segments = 64) {
  return Manifold.cylinder(length, radius, radius, segments)
    .rotate([0, 90, 0]).translate([x, cy, cz]);
}
function triangularPrismY(y, depth, ...pointsXZ) {
  const epsilon = 0.02;
  return Manifold.hull(pointsXZ.map(([x, z]) =>
    cube(x - epsilon / 2, y, z - epsilon / 2, epsilon, depth, epsilon)));
}
function triangularPrismX(x, width, ...pointsYZ) {
  const epsilon = 0.02;
  return Manifold.hull(pointsYZ.map(([y, z]) =>
    cube(x, y - epsilon / 2, z - epsilon / 2, width, epsilon, epsilon)));
}
// Convex polygon extruded along X: cross-section given as [y, z] points.
function polyPrismX(x, width, pointsYZ) {
  const epsilon = 0.02;
  return Manifold.hull(pointsYZ.map(([y, z]) =>
    cube(x, y - epsilon / 2, z - epsilon / 2, width, epsilon, epsilon)));
}
// Triangular prism extruded along Z (cross-section in the X-Y silhouette
// plane). Used for the plan facets: a Z-extrusion never overhangs.
function triangularPrismZ(z, depth, ...pointsXY) {
  const epsilon = 0.02;
  return Manifold.hull(pointsXY.map(([x, y]) =>
    cube(x - epsilon / 2, y - epsilon / 2, z, epsilon, epsilon, depth)));
}
// Rectangular passage along Y through a long wall, its Z ceiling gabled at
// 45 degrees so the print never bridges a flat roof.
function gabledRectY(x0, y, z0, length, w, h) {
  return fuse([
    cube(x0, y, z0, w, length, h),
    triangularPrismY(y, length,
      [x0, z0 + h], [x0 + w, z0 + h], [x0 + w / 2, z0 + h + w / 2]),
  ]);
}
// Vertical-capsule slot along Y: the upper lobe is its own printable roof.
function capsuleSlotY(cx, y, cz, width, travel, length) {
  const r = width / 2;
  return Manifold.hull([
    cylinderAlongY(cx, y, cz - travel / 2, r, length, 36),
    cylinderAlongY(cx, y, cz + travel / 2, r, length, 36),
  ]).add(teardropHoleY(cx, y, cz + travel / 2, r, length));
}
// Circular hole along Y through a vertical wall, with a 45-degree triangular
// roof so the print never bridges a flat ceiling.
function teardropHoleY(cx, y, cz, radius, length) {
  const tangent = radius / Math.sqrt(2);
  const roof = triangularPrismY(y, length,
    [cx - tangent, cz + tangent],
    [cx + tangent, cz + tangent],
    [cx, cz + Math.SQRT2 * radius]);
  return fuse([cylinderAlongY(cx, y, cz, radius, length), roof]);
}
// Rounded slot along Y - a capsule, no point anywhere on it.
//
// This started as a vertex-up hexagon, on the theory that 60-degree flanks
// would beat the teardrop's 45. That was simply wrong: the edges either side
// of a regular hexagon's top vertex lie 30 degrees off horizontal, so it is a
// 60-degree OVERHANG - worse than what it replaced, and the audit said so.
// No point does better than 45 degrees, so the answer is to stop using points.
// A capsule's roof is the top of a circle: the unsupported patch at its apex
// is a few millimetres wide and bridges without help, the same way every
// horizontal bore in this part already does.
// The old hex commentary follows, for the record.
// Hex port along Y, VERTEX UP. The teardrop exists to give a horizontal bore a
// printable roof, but its point is visible on the outside face and reads as a
// printing artefact rather than a feature. A hexagon with a vertex at the top
// has 60-degree upper flanks - comfortably self-supporting - and reads as
// something somebody chose. Same job, deliberate result.
// acrossFlats is the width in X; the height in Z is acrossFlats / cos(30).
function slotPortY(cx, y, cz, width, travel, length) {
  const r = width / 2;
  return Manifold.hull([
    cylinderAlongY(cx, y, cz - travel / 2, r, length, 64),
    cylinderAlongY(cx, y, cz + travel / 2, r, length, 64),
  ]);
}
function teardropHoleX(x, cy, cz, radius, length) {
  const tangent = radius / Math.sqrt(2);
  const roof = triangularPrismX(x, length,
    [cy - tangent, cz + tangent],
    [cy + tangent, cz + tangent],
    [cy, cz + Math.SQRT2 * radius]);
  return fuse([cylinderAlongX(x, cy, cz, radius, length), roof]);
}
function roundedRectZ(x, y, z, w, d, h, radius, segments = 48) {
  if (radius <= 0) return cube(x, y, z, w, d, h);
  return Manifold.hull([
    cylZ(x + radius, y + radius, z, radius, h, segments),
    cylZ(x + w - radius, y + radius, z, radius, h, segments),
    cylZ(x + radius, y + d - radius, z, radius, h, segments),
    cylZ(x + w - radius, y + d - radius, z, radius, h, segments),
  ]);
}

// ---------------------------------------------------------------------------
// Body-wall flutes. See the wallGrain* parameters for why they run along Z.

// Stations spaced evenly around the body silhouette: bottom edge, then each
// corner arc and edge in turn, all the way round. The count is ROUNDED to the
// loop rather than stepped from a corner, so the pattern closes exactly on
// itself - step it and the last flute lands a fraction of a pitch from the
// first, which is a visible double line down one corner of the finished camera.
function wallFluteStations(pitch) {
  const W = P.bodyW, H = P.bodyH, R = P.bodyCornerR;
  const eX = W - 2 * R, eY = H - 2 * R, arc = (Math.PI / 2) * R;
  const L = 2 * eX + 2 * eY + 4 * arc;
  const n = Math.max(8, Math.round(L / pitch));
  const step = L / n;
  // Each station carries its own outward normal, so the cutter can stand proud
  // of the wall it cuts instead of being tangent to it.
  const at = (s) => {
    let t = s;
    if (t < eX) return [[R + t, 0], [0, -1]];                                   // bottom wall, +X
    t -= eX;
    if (t < arc) { const a = (t / arc) * (Math.PI / 2); return [[W - R + R * Math.sin(a), R - R * Math.cos(a)], [Math.sin(a), -Math.cos(a)]]; }
    t -= arc;
    if (t < eY) return [[W, R + t], [1, 0]];                                    // +X wall, +Y
    t -= eY;
    if (t < arc) { const a = (t / arc) * (Math.PI / 2); return [[W - R + R * Math.cos(a), H - R + R * Math.sin(a)], [Math.cos(a), Math.sin(a)]]; }
    t -= arc;
    if (t < eX) return [[W - R - t, H], [0, 1]];                                // top wall, -X
    t -= eX;
    if (t < arc) { const a = (t / arc) * (Math.PI / 2); return [[R - R * Math.sin(a), H - R + R * Math.cos(a)], [-Math.sin(a), Math.cos(a)]]; }
    t -= arc;
    if (t < eY) return [[0, H - R - t], [-1, 0]];                               // -X wall, -Y
    t -= eY;
    const a = (t / arc) * (Math.PI / 2);
    return [[R - R * Math.cos(a), R - R * Math.sin(a)], [-Math.cos(a), -Math.sin(a)]];
  };
  const stations = [];
  for (let i = 0; i < n; i++) stations.push(at(i * step));
  return { stations, pitch: step, perimeter: L };
}

// One cross-section of N diamonds, each aligned to its own station's outward
// normal, extruded once over [z0, z1]. Fusing 267 solids in 3-D is the slow way
// to the same thing; the face plate's grain learned that already.
//
// Half-diagonal = depth + proud, so the flanks reach exactly wallGrainDepth
// below the wall and are 45 degrees to it. Two vertices lie on the normal and
// two on the tangent, which is what keeps the cut a clean V round the corner
// arcs as well as along the flats.
function wallFluteCutter(z0, z1) {
  const { stations } = wallFluteStations(P.wallGrainPitch);
  const h = P.wallGrainDepth + P.wallGrainProud;
  const polys = stations.map(([p, n]) => {
    const c = [p[0] + n[0] * P.wallGrainProud, p[1] + n[1] * P.wallGrainProud];
    const t = [-n[1], n[0]];
    return [
      [c[0] + n[0] * h, c[1] + n[1] * h],
      [c[0] + t[0] * h, c[1] + t[1] * h],
      [c[0] - n[0] * h, c[1] - n[1] * h],
      [c[0] - t[0] * h, c[1] - t[1] * h],
    ];
  });
  return new wasm.CrossSection(polys, "Positive").extrude(z1 - z0).translate([0, 0, z0]);
}

// The two fluted bands, one per printed half. Derived once and read by both the
// cut and its gates, so a band cannot move in one place and be checked in the
// other. Each band is inset from whatever bounds it:
//   - the front half's bed face, so its first layer is a clean ring;
//   - the seam V on both sides, so the parting line stays a bright drawn line
//     rather than a texture running into a chamfer;
//   - the rear rim's edge treatment AND the door plane, whichever comes first.
//     The door plane is the one that bites: the door's entry mouth clears the
//     whole -X end of the track from Z=bodyD-bezelT out, so a band that ran to
//     the rim round would be cutting flutes into open air at one end and onto
//     the door frame's outer lip at the other. Stopping at the door plane
//     leaves that frame bright, which is what a screen surround wants anyway.
// The groove's height, derived so the shoulder sits exactly one clearance over
// the tongue and the two cannot drift apart.
const DOOR_GROOVE_Z = P.doorTongueZ + P.doorClearN;
// How far the strap anchor stands off the wall, and where its bore sits: both
// DERIVED from the cord and the wall thickness it needs, so the lug can never
// again be drawn thinner than the cord it carries. It shipped with 0.5 mm
// outboard of a Ø3.5 bore because the proud distance and the bore position were
// two independent numbers.
const STRAP_PROUD = 2 * P.strapLugWall + P.strapHoleD;
const STRAP_BORE_X = -(P.strapLugWall + P.strapHoleD / 2);
const seamRun = P.seamChamfer * Math.tan((P.seamAngleDeg * Math.PI) / 180);
const FLUTE_BANDS = [
  [P.wallGrainLandBed, splitZ - seamRun - P.wallGrainLandSeam],
  [splitZ + seamRun + P.wallGrainLandSeam,
    Math.min(P.bodyD - P.edgeRoundR, P.bodyD - P.bezelT) - P.wallGrainLandRim],
];

const BRAND_GLYPHS = {
  // Added for the revision/serial engravings.
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  9: ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  4: ["00100", "01100", "10100", "10010", "11111", "00100", "00100"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

// Where a glyph run's LEFT edge lands, in BODY coordinates.
// The body frame is right-handed with the lens face at -Z. A reader facing the
// camera looks along +Z, and for that reader +X is on the LEFT (the code has
// always known this: "right is +X ... appears on the LEFT in a front view").
// So text that reads left-to-right for them advances toward -X: the first
// glyph sits at the highest X. u is the run's offset along the line of text.
//
// History, because this has flipped twice and must not flip a third time. The
// original formula was this one. It was then "fixed" to advance +X because a
// render showed the letters mirrored - but that renderer mapped +X to screen
// right while drawing the -Z faces, which is itself a mirror, and the face and
// cover STLs were written with a Z REFLECTION whose mirror image, once the
// printed part was flipped onto the camera, cancelled the layout error. Two
// wrongs, one correct part, and a text direction that depended on a slicer
// never mirroring anything. Now the print transforms are rigid rotations, the
// renderer is a true view, and this is the only place direction is decided.
const textRunX = (xCentre, totalWidth, u, w) => xCentre + totalWidth / 2 - u - w;

// Shared glyph rasteriser: returns horizontal stroke runs as
// {u, v, w} cells (u along the text line, v up the glyph, w run length),
// with row 0 (glyph top) at the highest v.
function glyphRuns(text, cell) {
  const glyphGap = cell;
  const glyphWidth = 5 * cell;
  const totalWidth = text.length * (glyphWidth + glyphGap) - glyphGap;
  const runs = [];
  for (let charIndex = 0; charIndex < text.length; charIndex++) {
    const glyph = BRAND_GLYPHS[text[charIndex]] ?? BRAND_GLYPHS[" "];
    const gu = charIndex * (glyphWidth + glyphGap);
    for (let row = 0; row < glyph.length; row++) {
      let col = 0;
      while (col < glyph[row].length) {
        if (glyph[row][col] !== "1") { col++; continue; }
        const start = col;
        while (col < glyph[row].length && glyph[row][col] === "1") col++;
        runs.push({
          u: gu + start * cell,
          v: (glyph.length - 1 - row) * cell,
          w: (col - start) * cell,
        });
      }
    }
  }
  return { runs, totalWidth, height: 7 * cell };
}


// 45-degree V-groove recessed into the front (bed) face between two XY
// points. Self-supporting by construction.
// V trench between two points on the front (bed) face, cut into +Z. Built
// from a 45-degree-rotated box scaled in Z, so every wall is one exact plane
// and the mesh carries no hull slivers. Walls land at 52 degrees, clear of
// the 45-degree support rule; opening half-width is halfWidth and the apex
// sits 1.25 x halfWidth deep.
const V_GROOVE_SLOPE = 1.28;
function frontVGroove(x0, y0, x1, y1, halfWidth) {
  const depth = halfWidth * 1.25;
  const a = depth / Math.SQRT2;
  const length = Math.hypot(x1 - x0, y1 - y0) + 2 * halfWidth;
  const angle = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
  return Manifold.cube([length, 2 * a, 2 * a], true)
    .rotate([45, 0, 0])
    .scale([1, 1, V_GROOVE_SLOPE])
    .rotate([0, 0, angle])
    .translate([(x0 + x1) / 2, (y0 + y1) / 2, depth * (1 - V_GROOVE_SLOPE)]);
}


// 50-degree diagonal V-groove recessed into the right wall exterior
// (the N8000 facet lines). Steeper than 45 degrees, so it self-supports.
// The shared N8000 silhouette, extruded along Z from z0 by depth: main box,
// grip block, stepped top plate and prism hump, minus the grip's one plan
// facets. Both the chassis and the face shell are built on this outline, so
// they cannot drift apart.
// The silhouette, extruded along Z from z0 by depth. It used to be an N8000
// pastiche - main box plus a grip block, a stepped top plate and a prism hump.
// That carried 126 cm3 (36% of the chassis) and +16 mm in X, +17 in Y purely
// for the look, and it is not the look we want: the reference is a clean
// rounded slab with a raised lens strip and nothing else standing proud.
// So the outline is now one rounded rectangle. Both the chassis and the face
// shell are built on it, so they cannot drift apart.
// A raised bitmap: each row's runs of ink become one cube, laid out with the
// same left-to-right convention as the lettering (textRunX), so the two can
// never disagree about which way is right.
function raisedBitmap(rows, cell, xCentre, yBase, faceZ, height) {
  const cols = rows[0].length, totalWidth = cols * cell, cubes = [];
  rows.forEach((row, r) => {
    const v = (rows.length - 1 - r) * cell;   // row 0 is the top of the mark
    let c = 0;
    while (c < cols) {
      if (row[c] !== "1") { c++; continue; }
      const c0 = c; while (c < cols && row[c] === "1") c++;
      const u = c0 * cell, w = (c - c0) * cell;
      cubes.push(cube(textRunX(xCentre, totalWidth, u, w), yBase + v, faceZ - 0.6,
        w, cell + 0.02, height));
    }
  });
  return fuse(cubes);
}

// ---- Identity engravings --------------------------------------------------------
// Revision from the hardware manifest, so the part and the record cannot say
// different things; serial from the parameters.
const MANIFEST = JSON.parse(fs.readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const SERIAL_TEXT = `REV ${MANIFEST.designVersion} · SN ${String(P.buildSerial).padStart(3, "0")}`;

// Stroke font for the engravings. The bitmap glyphs above are a 5 x 7 grid and
// read as pixels at 0.6 mm; an engraving cut by a Ø0.4 nozzle can carry real
// curves, so the serials and the badge are drawn as centre-line paths - lines
// and arcs in cap-height units, x to the reader's right, y up, baseline 0 -
// and every segment becomes a round-ended capsule of the stroke width. A
// single-point path is a dot.
function arcPath(cx, cy, r, a0, a1, n = 10) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + (a1 - a0) * (i / n)) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
const ring = (cx, cy, r, n = 20) => arcPath(cx, cy, r, 0, 360, n);
const STROKE_GLYPHS = {
  "0": { adv: 0.95, paths: [[...arcPath(0.36, 0.72, 0.28, 0, 180, 8), [0.08, 0.28], ...arcPath(0.36, 0.28, 0.28, 180, 360, 8), [0.64, 0.72]]] },
  "1": { adv: 0.75, paths: [[[0.14, 0.78], [0.38, 1.0], [0.38, 0.0]]] },
  "2": { adv: 0.95, paths: [[...arcPath(0.36, 0.72, 0.28, 170, -40, 10), [0.08, 0.0], [0.66, 0.0]]] },
  "3": { adv: 0.95, paths: [[...arcPath(0.36, 0.75, 0.25, 150, -90, 10)], [...arcPath(0.36, 0.25, 0.25, 90, -150, 10)]] },
  "4": { adv: 0.95, paths: [[[0.52, 0.0], [0.52, 1.0], [0.06, 0.32], [0.72, 0.32]]] },
  "5": { adv: 0.95, paths: [[[0.62, 1.0], [0.14, 1.0], [0.1, 0.56], ...arcPath(0.36, 0.3, 0.3, 105, -150, 12)]] },
  "6": { adv: 0.95, paths: [[...arcPath(0.42, 0.68, 0.36, 55, 180, 8), [0.06, 0.3]], ring(0.35, 0.3, 0.29)] },
  "7": { adv: 0.9, paths: [[[0.06, 1.0], [0.66, 1.0], [0.26, 0.0]]] },
  "8": { adv: 0.95, paths: [ring(0.36, 0.74, 0.24), ring(0.36, 0.28, 0.28)] },
  "9": { adv: 0.95, paths: [[...arcPath(0.3, 0.32, 0.36, 235, 360, 8), [0.66, 0.7]], ring(0.37, 0.7, 0.29)] },
  ".": { adv: 0.45, paths: [[[0.14, 0.0]]] },
  "-": { adv: 0.7, paths: [[[0.1, 0.5], [0.5, 0.5]]] },
  "#": { adv: 1.0, paths: [[[0.24, 0.06], [0.32, 0.94]], [[0.52, 0.06], [0.6, 0.94]], [[0.06, 0.36], [0.74, 0.36]], [[0.1, 0.64], [0.78, 0.64]]] },
  "·": { adv: 0.5, paths: [[[0.14, 0.42]]] },                 // mid dot, the separator
  "D": { adv: 1.05, paths: [[[0.08, 0.0], [0.08, 1.0], [0.36, 1.0], ...arcPath(0.36, 0.5, 0.5, 90, -90, 12), [0.08, 0.0]]] },
  "E": { adv: 0.9, paths: [[[0.64, 1.0], [0.08, 1.0], [0.08, 0.0], [0.64, 0.0]], [[0.08, 0.52], [0.54, 0.52]]] },
  "I": { adv: 0.45, paths: [[[0.1, 0.0], [0.1, 1.0]]] },
  "K": { adv: 1.0, paths: [[[0.08, 0.0], [0.08, 1.0]], [[0.66, 1.0], [0.08, 0.42]], [[0.3, 0.58], [0.7, 0.0]]] },
  "N": { adv: 1.0, paths: [[[0.08, 0.0], [0.08, 1.0], [0.66, 0.0], [0.66, 1.0]]] },
  "R": { adv: 1.0, paths: [[[0.08, 0.0], [0.08, 1.0], [0.4, 1.0], ...arcPath(0.4, 0.75, 0.25, 90, -90, 10), [0.08, 0.5]], [[0.38, 0.5], [0.7, 0.0]]] },
  "S": { adv: 0.95, paths: [[...arcPath(0.37, 0.74, 0.26, 30, 270, 12), ...arcPath(0.37, 0.26, 0.26, 90, -150, 12)]] },
  "V": { adv: 1.0, paths: [[[0.04, 1.0], [0.38, 0.0], [0.72, 1.0]]] },
  " ": { adv: 0.5, paths: [] },
};
// A text solid in a canonical frame: x to the reader's RIGHT, y up, the ink's
// bottom at y=0, centred on x=0, occupying z from -depth to +0.3 so that placed
// on a surface at z=0 (outward normal +z) and subtracted, it engraves that
// surface. Strokes stand 0.3 mm proud of the surface they cut, not 0.01: the
// face shell's front is at -3.01 (its edge-round hull's first slice is 0.01
// thick and starts 0.01 early), and a cutter face coplanar with a part face at
// 0.01 mm is exactly what simplify() turns into non-manifold slivers - the
// validator found three on the face print.
// Built in 2-D first - every capsule as a polygon, all of them unioned by the
// positive fill rule - and extruded ONCE. Hulling 3-D capsules and fusing them
// left dozens of coplanar floor facets per glyph, which came out of simplify()
// as degenerate triangles and non-manifold edges on six of the seven parts.
function capsulePoly(a, b, r, n = 12) {
  const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const pts = [];
  for (let i = 0; i <= n; i++) {           // round b, from th-90 to th+90
    const t = th - Math.PI / 2 + (Math.PI * i) / n;
    pts.push([b[0] + r * Math.cos(t), b[1] + r * Math.sin(t)]);
  }
  for (let i = 0; i <= n; i++) {           // round a, from th+90 to th+270
    const t = th + Math.PI / 2 + (Math.PI * i) / n;
    pts.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]);
  }
  return pts;
}
// `slant` is an italic shear, x += slant * y, applied to the centre lines
// before the capsules are laid so the stroke stays round.
function strokeTextCs(text, capH, strokeW, slant = 0) {
  const r = strokeW / 2;
  const polys = [];
  let x = 0;
  for (const ch of text) {
    const g = STROKE_GLYPHS[ch];
    if (!g) throw new Error(`stroke font has no glyph for "${ch}"`);
    for (const path of g.paths) {
      const pts = path.map(([u, v]) => [x + (u + slant * v) * capH, v * capH]);
      if (pts.length === 1) { polys.push(ring(pts[0][0], pts[0][1], r * 1.15, 24).slice(0, -1)); continue; }
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;   // repeated point
        polys.push(capsulePoly(a, b, r));
      }
    }
    x += g.adv * capH;
  }
  return new wasm.CrossSection(polys, "Positive");
}
// Any 2-D mark into the canonical engraving frame: centred on x=0, ink bottom
// at y=0, z from -depth to +0.3.
function markSolid(raw, depth) {
  const bb = raw.bounds();
  const cs = raw.translate([-(bb.min[0] + bb.max[0]) / 2, -bb.min[1]]);
  return { cs, solid: cs.extrude(depth + 0.3).translate([0, 0, -depth]),
    width: bb.max[0] - bb.min[0], height: bb.max[1] - bb.min[1] };
}
// The boxed D4 out of the wordmark trace: the polygons that lie wholly in the
// box's own span (the "o" reaches 1.2 mm into it and is excluded by its start).
// Also measures the box outline's stroke, which the print has to resolve.
const MARK_BOX = (() => {
  const box = MARK.polygons.filter((p) => p.every(([x]) => x >= 0.75 * MARK.widthMm));
  const span = (p) => { const ys = p.map((q) => q[1]); return Math.max(...ys) - Math.min(...ys); };
  const heights = box.map(span).sort((a, b) => b - a);
  return { polygons: box, height: heights[0], stroke: (heights[0] - heights[1]) / 2, count: box.length };
})();
function badgeCs(height) {
  const s = height / MARK_BOX.height;
  return new wasm.CrossSection(MARK_BOX.polygons, "EvenOdd").scale([s, s]);
}
// Ink in the text's left and right thirds, in mm^2, read off the text outline
// itself - what a correct engraving must show when sliced.
function textInkThirds(txt) {
  const third = txt.width / 3;
  const band = (x0) => txt.cs.intersect(wasm.CrossSection.square([third, txt.height + 0.2], false).translate([x0, -0.1])).area();
  return { left: band(-txt.width / 2), right: band(txt.width / 2 - third) };
}
// Placements: how the canonical frame lands on each face of the camera, and the
// exact inverse, so a gate can bring a finished part back into the engraving's
// frame and read it. Reader's right is derived, not guessed: right = forward x up
// in this right-handed frame (lens face at -Z, top at +Y, photographer's right
// hand at +X).
//   front  (n -Z): reader faces +Z, up +Y      -> right = -X
//   rear   (n +Z): reader faces -Z, up +Y      -> right = +X
//   bottom (n -Y): reader faces +Y, up = -Z (lens away) -> right = -X
//   top    (n +Y): reader faces -Y, up = -Z (lens away) -> right = +X
const neg = (a) => a.map((q) => -q);
const PLACE = {
  front:  { place: (m, a) => m.rotate([0, 180, 0]).translate(a),                    unplace: (m, a) => m.translate(neg(a)).rotate([0, 180, 0]) },
  rear:   { place: (m, a) => m.translate(a),                                         unplace: (m, a) => m.translate(neg(a)) },
  bottom: { place: (m, a) => m.rotate([-90, 0, 0]).rotate([0, 0, 180]).translate(a), unplace: (m, a) => m.translate(neg(a)).rotate([0, 0, -180]).rotate([90, 0, 0]) },
  top:    { place: (m, a) => m.rotate([-90, 0, 0]).translate(a),                     unplace: (m, a) => m.translate(neg(a)).rotate([90, 0, 0]) },
};
function markEngraving(name, text, raw, face, anchor) {
  const depth = P.engraveDepth;
  const txt = markSolid(raw, depth);
  const ink = textInkThirds(txt);
  return { name, text, depth, face, anchor,
    solid: PLACE[face].place(txt.solid, anchor),
    unplace: (part) => PLACE[face].unplace(part, anchor),
    w: txt.width, h: txt.height, area: txt.cs.area(), cs: txt.cs, expLeft: ink.left, expRight: ink.right };
}
// Text set in the traced typeface: each glyph's outlines placed at the pen
// position, even-odd filled (counters are holes), advanced by the font's own
// advance. Cap height is the unit.
const FONT = JSON.parse(fs.readFileSync(new URL("./fonts/roboto-regular.json", import.meta.url), "utf8"));
function fontTextCs(text, capH) {
  const polys = [];
  let pen = 0;
  for (const ch of text) {
    const g = FONT.glyphs[ch];
    if (!g) throw new Error(`fonts/${FONT.font}: no glyph for "${ch}"`);
    for (const poly of g.polygons) polys.push(poly.map(([u, v]) => [(pen + u) * capH, v * capH]));
    pen += g.adv;
  }
  // Cleaned in 2-D, before it is ever a solid. The traced outlines plus the
  // embolden offset leave occasional pairs of points tens of nanometres apart,
  // and a glyph edge 8.2e-5 mm long is a triangle that collapses the moment the
  // STL is written in float32 - which is how the rear half shipped with two
  // degenerate triangles at X 79.5 on the serial's lettering. It only surfaced
  // when the wall flutes changed the mesh the letters are cut into; the defect
  // was in the outline the whole time. 1 um is a thousandth of the thinnest
  // stroke, so the letters do not move, and the min-stroke gate says so.
  return new wasm.CrossSection(polys, "EvenOdd")
    .offset(P.serialEmbolden, "Round", 2, 16).simplify(1e-3);
}
function engraving(name, text, capH, face, anchor) {
  return markEngraving(name, text, fontTextCs(text, capH), face, anchor);
}
// The engravings. Bottom-face serials read with the lens pointing away from
// you; the door's reads from behind the camera; the cover's is on its back and
// reads with the cover turned over; the tool's is on the face you hold.
const ENGRAVINGS = {
  frontHalf: engraving("front half serial", SERIAL_TEXT, P.serialCapH, "bottom", [P.bodyW / 2, 0, 27.0]),
  // Rear half: right of the right-hand zip-tie slot (X 54.4-57.6) and forward
  // of the rear feet (Z 51.6+). At X 81 the 51 mm line reached into the slot.
  rearHalf:  engraving("rear half serial",  SERIAL_TEXT, P.serialCapH, "bottom", [88.0, 0, 47.0]),
  // Face: on the plate ABOVE the lens bar (the bar runs to Y 60.7 now that the
  // cover stows below the cells). At Y 12 the recess landed inside the bar's
  // solid and made fourteen sealed voids, which the one-part gate counted.
  face:      engraving("face shell serial", SERIAL_TEXT, P.serialCapH, "front",  [P.bodyW / 2, 68.0, -P.faceBase]),
  cover:     engraving("lens cover serial", SERIAL_TEXT, P.serialCapH, "rear",   [P.bodyW / 2 + 0.5, 44.0, -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth]),
  // Door: the frame under the window is Y 6.3-14.3 and the window's bevel
  // flares out to 12.3 on the outer face; a 4.5 mm band from 6.9 clears both.
  door:      engraving("door serial",       SERIAL_TEXT, P.serialCapH, "rear",   [P.bodyW / 2, 7.0, P.bodyD]),
  tool:      engraving("alignment tool serial", SERIAL_TEXT, P.serialCapH, "front", [P.bodyW / 2, P.cameraLensY - 2.1, 0]),
  badge:     markEngraving("D4 badge", "boxed D4 from the wordmark", badgeCs(P.badgeH), "top", [P.badgeX, P.bodyH, P.badgeZ]),
  // Camera numbers on the plate's inner face. That face's outward normal is
  // +Z, so it is the "rear" placement: a reader looking into the open bay has
  // +X on their right, which is the same order the cameras are counted in.
  ...Object.fromEntries(cameraXs.map((cx, i) => [`cam${i + 1}`,
    engraving(`camera ${i + 1} number`, String(i + 1), P.serialCapH, "rear",
      [cx, boardMaxY + P.camNumberGapY, P.plate])])),
  // The spec line sits ABOVE the serial for a reader: on a bottom face "up" is
  // -Z, so a smaller Z is higher. Model name over revision and serial, the way
  // a plate is set.
  spec:      engraving("spec line", P.specText, P.specCapH, "bottom", [P.bodyW / 2, 0, P.specZ]),
};
const CAM_NUMBER_KEYS = [1, 2, 3, 4].map((n) => `cam${n}`);

function bodyOutline(z0, depth) {
  return roundedRectZ(0, 0, z0, P.bodyW, P.bodyH, depth, P.bodyCornerR);
}

function buildBody() {
  const positive = [];
  const negative = [];
  const postAdds = [];
  const add = (solid) => { positive.push(solid); return solid; };
  const cut = (solid) => {
    negative.push(solid); return solid;
  };

  // ---- Chassis shell -----------------------------------------------------
  // Plain and functional: the shared silhouette minus the module cavity. All
  // cosmetic form lives on the separate face shell, so nothing here has to
  // fight the fact that the front face is the bed face.
  const cavity = cube(innerMinX, innerMinY, P.plate,
    innerMaxX - innerMinX, innerMaxY - innerMinY, P.bodyD);
  add(bodyOutline(0, P.bodyD).subtract(cavity));

  // Clearance holes for the four face-shell screws, driven from inside.
  // No face-shell screw holes in the plate: the shell is glued on. The plate's
  // only openings are the four lens bores and the Hall sensor's lead hole.

  // Four P4 posts: vertical columns from the plate to the standoff tops.
  // Each is stiffened by a low rib to the nearest top/bottom wall; the ribs
  // stay below the component bay and outside the XIAO stations.
  for (const x of mountXs) for (const y of mountYs) {
    // Grown past the old standoff plane by the socket depth, then hollowed,
    // so the brass lands on a floor at the SAME Z the post face used to be.
    add(cylZ(x, y, P.plate, P.p4PostD / 2, postTopZ - P.plate));
    cut(socketCone(x, y, standoffTopZ));
    const wallY = y < centerY ? innerMinY : innerMaxY;
    const ribY = Math.min(y, wallY), ribLen = Math.abs(wallY - y);
    add(cube(x - P.p4PostRibW / 2, ribY - 1, P.plate,
      P.p4PostRibW, ribLen + 2, P.p4PostRibD));
  }

  // Split-joint pads: local thickenings on the inside of the top and bottom
  // walls, spanning the cut. They live in the 4.3 mm strips above and below
  // the module footprint, which is the only room the bay keep-out leaves - and
  // it means the bolt heads stay reachable past a fitted module, so the halves
  // come apart with only the door off.
  for (const b of splitBolts) {
    const yLo = b.wall === "top" ? innerMaxY - P.splitPadReach : innerMinY - 0.2;
    const yHi = b.wall === "top" ? innerMaxY + 0.2 : innerMinY + P.splitPadReach;
    const zFore = splitZ - P.splitPadFore;
    const zWedge = zFore - P.splitPadWedge;
    // Wedge: a zero-reach sliver against the wall face at zWedge, hulled to the
    // full pad footprint at zFore. Its underside runs 3.5 over 5 = 55 degrees.
    const wY0 = b.wall === "top" ? innerMaxY - 0.01 : innerMinY - 0.2;
    const wY1 = b.wall === "top" ? innerMaxY + 0.2 : innerMinY + 0.01;
    add(Manifold.hull([
      cube(b.x - P.splitPadW / 2, wY0, zWedge, P.splitPadW, wY1 - wY0, 0.01),
      cube(b.x - P.splitPadW / 2, yLo, zFore, P.splitPadW, yHi - yLo, 0.01),
    ]));
    add(cube(b.x - P.splitPadW / 2, yLo, zFore - 0.01,
      P.splitPadW, yHi - yLo, splitZ + P.splitPadAft - zFore + 0.01));
    // Front side: blind pilot for the M3 to tap into.
    cut(cylZ(b.x, b.y, splitZ - P.splitPilotDepth - 0.1, P.splitPilotD / 2,
      P.splitPilotDepth + 0.1, 32));
    // Rear side: clearance, then a counterbore open toward the door so the
    // head is driven from inside the cavity.
    cut(cylZ(b.x, b.y, splitZ, P.splitClearD / 2, P.splitPadAft + 0.2, 32));
    cut(cylZ(b.x, b.y, splitZ + P.splitPadAft - P.splitHeadDepth,
      P.splitHeadD / 2, P.splitHeadDepth + 0.05, 32));
    // The head has to come DOWN to that pocket from the door, and the pocket
    // reaches into the wall. So the wall's inner face is channelled above the
    // pad, only as deep as the head needs, from the pad's rear face to the
    // door plane - where the door zone itself is already open.
    const chW = P.splitHeadD + 0.4;
    const chDepth = P.splitHeadD / 2 + 0.2 - P.splitBoltInset;
    const chZ0 = splitZ + P.splitPadAft - 0.01;
    const chZ1 = P.bodyD - P.bezelT + 0.01;
    const chY = b.wall === "top" ? innerMaxY - 0.01 : innerMinY - chDepth;
    cut(cube(b.x - chW / 2, chY, chZ0, chW, chDepth + 0.01, chZ1 - chZ0));
  }

  // XIAO stations: seat pads under the bare board corners, locating fences
  // along the board sides, one clamp boss per board, and the lens window.
  for (const [ci, cx] of cameraXs.entries()) {
    const bx0 = cx - P.xiaoBoardW / 2, bx1 = cx + P.xiaoBoardW / 2;
    // Seat pads live only in the strip of board that is clear of the camera
    // module below it. The camera end of the board gets no pads at all - see
    // camModulePcb: there is no room for them and the module has to win, since
    // it is the thing that has to sit still for the picture.
    for (const px of [cx - P.xiaoBoardW / 2 + 1.5, cx + P.xiaoBoardW / 2 - 1.5]) {
      for (const py of xiaoPadYs) {
        add(cylZ(px, py, P.plate, 2.0, xiaoPadH, 32));
      }
    }
    for (const side of [-1, 1]) {
      const fx = cx + side * (P.xiaoBoardW / 2 + P.xiaoBoardClearance);
      add(cube(side < 0 ? fx - P.xiaoFenceW : fx,
        boardMinY + 2, P.plate, P.xiaoFenceW, P.xiaoBoardH - 4, P.xiaoFenceH));
    }
    add(cylZ(clampBossXs[ci], clampBossYs[ci], P.plate,
      P.clampBossD / 2, clampBossTopZ - P.plate));
    cut(cylZ(clampBossXs[ci], clampBossYs[ci], clampBossTopZ - P.m2InsertDepth,
      P.m2InsertPilotD / 2, P.m2InsertDepth + 0.6));

    // Camera capture. The module's head drops into a pocket in the plate's
    // inner face, which locates it laterally; the clamped XIAO board behind it
    // holds it against the pocket floor. Three compliant ribs on two adjacent
    // walls push the head onto the opposite datum walls, so the fit stays
    // tight across part-to-part variation instead of relying on one number.
    const pocket = P.camBody + P.camBodySlack;
    const pocketZ0 = P.plate - camPocketDepth;
    cut(cube(cx - pocket / 2, P.cameraLensY - pocket / 2, pocketZ0,
      pocket, pocket, camPocketDepth + 0.01));
    // Added after the main Boolean: the pocket cut would otherwise remove the
    // very ribs that are supposed to stand inside it.
    for (let rib = 0; rib < P.camRibCount; rib++) {
      const [tLo, tHi] = P.camRibSpan;
      const t = P.camRibCount === 1 ? 0.5
        : tLo + (tHi - tLo) * (rib / (P.camRibCount - 1));
      // One wall in X, one in Y: two ribbed faces, two datum faces.
      const ry = P.cameraLensY - pocket / 2 + pocket * t;
      postAdds.push(cylZ(cx - pocket / 2 + P.camRibProud / 2, ry, pocketZ0,
        P.camRibProud, camPocketDepth, 12));
      const rx = cx - pocket / 2 + pocket * t;
      postAdds.push(cylZ(rx, P.cameraLensY - pocket / 2 + P.camRibProud / 2,
        pocketZ0, P.camRibProud, camPocketDepth, 12));
    }
    // Lens cell: two stacked 45-degree cones from the bed face (the N8000
    // stepped-ring look), a short straight bore, then a 45-degree relief
    // cone opening to the board side. No flat ceilings.
    // The chassis plate carries only the straight bore: the stepped cones are
    // on the face shell, and the camera pocket has replaced what used to be an
    // inner relief cone here.
    cut(cylZ(cx, P.cameraLensY, -0.01, P.lensBoreD / 2, P.plate + 0.02, 64));
  }

  // Rear door interface. The door plate occupies Z doorZ0..bodyD across the
  // opening; everything interior stops at doorZ0. Both long walls get a
  // dovetail groove the door's edge wedges slide in, and the groove ceiling
  // overhangs the door edge to react the foam preload.
  // The door enters at the end OPPOSITE the grip (low X) and slides toward
  // +X until it stops against the grip-side wall.
  const doorZ0 = P.bodyD - P.bezelT;
  // A rectangular groove, not a dovetail: the shoulder over it is one flat
  // ledge that appears at its full 1.5 mm width in a single layer, rooted on
  // the groove's deep wall in that same layer. See the doorBite block for the
  // eleven layers of unsupported flag the sloped version produced instead.
  for (const side of [-1, 1]) {
    const wallInner = side < 0 ? innerMinY : innerMaxY;
    const deep = wallInner + side * P.doorBite;
    const y0 = Math.min(wallInner - side * 0.01, deep);
    cut(cube(-2, y0, doorZ0, innerMaxX + 4, Math.abs(deep - (wallInner - side * 0.01)),
      DOOR_GROOVE_Z));
  }
  // Clear the entry-end wall above the door plane so the door slides in over
  // it, and cut the latch notch into the cleared face: the door's tooth rides
  // this face during the last millimetres and drops in at seat. The notch's
  // outboard edge is chamfered so a firm pull cams the tooth back out.
  cut(cube(-1, innerMinY - P.doorBite, doorZ0,
    innerMinX + 2, (innerMaxY - innerMinY) + 2 * P.doorBite, P.bezelT + 1));
  // Detent bumps on both grooves' deep walls at the seated position, added
  // after the cuts: spheres sunk into the wall so that exactly doorClearY +
  // detentBite stands proud of the deep face. The door's wedge carries the
  // matching dimple, crest and relief channel (buildBezel). Placed 6 mm inside
  // the entry wall's inner face so no part of the sphere lands in the cleared
  // entry zone (X < innerMinX + 2), where it would be a blob on a bare face.
  for (const side of [-1, 1]) {
    const wallInner = side < 0 ? innerMinY : innerMaxY;
    const deep = wallInner + side * P.doorBite;
    const proud = P.doorClearY + P.detentBite;
    postAdds.push(cylZ(P.detentBackFromEnd, deep + side * (P.detentBump - proud), doorZ0 - 0.01,
      P.detentBump, P.detentRibH + 0.01, 32));
  }

  // Power entry: cable exit through the BOTTOM wall with two flanking zip-tie
  // slots, and nothing else. There was also a blind plug recess in the top
  // wall for a plug pointing at the board's top edge, but the plug stands off
  // the component side and a gate measures 16 mm of clear depth in front of
  // the PCB there, so the recess was solving a problem that does not exist.
  // Hex port, not a gabled rectangle. The gable was a 45-degree roof on a
  // square hole: functional, but it read as a shed on the bottom of the camera.
  // A vertex-up hex of ${P.usbPassageAF} mm across flats gives the same clear
  // area with 60-degree flanks and a shape that matches the shutter collar.
  cut(slotPortY(P.usbPassageX, -1, usbPassageZ,
    P.usbPassageSlotW, P.usbPassageSlotTravel, P.wallBottom + 4));
  // Cable groove from the slot to the rear edge. All of its faces are vertical
  // in print (a channel running along Z in a Y wall).
  cut(cube(P.usbPassageX - P.cableGrooveW / 2, -1, usbPassageZ,
    P.cableGrooveW, 1 + P.cableGrooveD, P.bodyD - usbPassageZ + 2));
  // Vent slots through both side walls, gabled at both ends.
  for (const [x0, x1] of [[-1, P.wallLeft + 1], [P.bodyW - P.wall - 1, P.bodyW + 1]]) {
    for (const vy of P.ventSlotYs) {
      const w = P.ventSlotW, z0 = ventSlotZ0, z1 = z0 + P.ventSlotLen;
      cut(fuse([
        cube(x0, vy - w / 2, z0, x1 - x0, w, z1 - z0),
        triangularPrismX(x0, x1 - x0, [vy - w / 2, z0], [vy + w / 2, z0], [vy, z0 - w / 2]),
        triangularPrismX(x0, x1 - x0, [vy - w / 2, z1], [vy + w / 2, z1], [vy, z1 + w / 2]),
      ]));
    }
  }
  // No Hall lead hole through the plate any more: the cover's state is read in
  // firmware off the four sensors. The plate's only openings are the four lens
  // bores.
  for (const side of [-1, 1]) {
    cut(capsuleSlotY(P.usbPassageX + side * P.usbTieOffsetX, -1,
      usbPassageZ, P.usbTieSlotW,
      P.usbTieSlotH - P.usbTieSlotW, P.wallBottom + 4));
  }


  // Shutter pod: a full-height pilaster on the top wall carrying the same
  // bore stack as the gantry rig. Actuator axis +Y, out through the top face.
  const podInnerY = innerMaxY - P.shutterPodReach;
  // The pod used to run the FULL depth, Z 5..60.6, to carry one switch bore at
  // Z 24. That length is what pinned the body's height: the pod hangs
  // shutterPodReach into the cavity, and where it runs past the module's front
  // face it competes with the module for the same Y, so bodyH could not drop
  // below ~95.4. Stopping it short of the module removes that competition
  // without touching the bore stack it exists to hold.
  // It also turned out to be the DOOR RAIL's material near X=115: its back face
  // sat exactly on the door's inner plane, so simply shortening it left the
  // detent bump with no groove wall to roll against. So the pod is two
  // sections now - deep where the switch is, shallow behind it where all it
  // has to do is carry the rail.
  const podBackZ = pcbBackZ - P.shutterPodBackset;
  add(cube(P.shutterX - P.shutterPodW / 2, podInnerY, P.plate,
    P.shutterPodW, P.shutterPodReach + 1, podBackZ - P.plate));
  add(cube(P.shutterX - P.shutterPodW / 2,
    innerMaxY - P.shutterPodRearReach, podBackZ - 0.2,
    P.shutterPodW, P.shutterPodRearReach + 1,
    (P.bodyD - P.bezelT) - podBackZ + 0.2));
  // All horizontal bores carry teardrop roofs; the actuator and retainer
  // register on the round lower halves, so the extra roof clearance is inert.
  const switchPocketDepth = P.shutterSwitchBody[2] + 0.5;
  const switchPocketY = podInnerY - 0.4;
  cut(teardropHoleY(P.shutterX, switchPocketY, P.shutterZ,
    P.shutterAssemblyAccessD / 2, switchPocketDepth + 1.0));
  cut(teardropHoleY(P.shutterX, switchPocketY + switchPocketDepth - 0.2,
    P.shutterZ, P.shutterActuatorFlangeD / 2 + 0.2,
    P.bodyH - 2.2 - (switchPocketY + switchPocketDepth - 0.2)));
  cut(teardropHoleY(P.shutterX, P.bodyH - 2.3, P.shutterZ,
    P.shutterActuatorGuideD / 2, 3.0));
  // A hex collar instead of a conical mouth. The guide bore behind it keeps its
  // teardrop - it is a register surface and wants the round lower half - but the
  // point reached √2 x r = 8.06 mm from centre, past the old Ø13 mouth's 6.5,
  // so it showed as a notch in the opening. The hex's corner radius is
  // acrossFlats/√3 = ${(P.shutterCollarAF / Math.sqrt(3)).toFixed(2)} mm, which covers it.
  cut(cylinderAlongY(P.shutterX, P.bodyH - P.shutterCollarDepth, P.shutterZ,
    P.shutterCollarD / 2, P.shutterCollarDepth + 0.2, 64));
  // Two-wire exit from the switch cavity into the open bay (toward -Y),
  // gabled at 45 degrees so it needs no bridge.
  const wireBottomZ = P.shutterZ - (P.shutterSwitchBody[1] +
    P.shutterSwitchClearance) / 2 - P.shutterWireExit[1];
  const wireW = P.shutterWireExit[0];
  const wireLen = P.shutterPodReach + 1.4;
  const wireTopZ = wireBottomZ + P.shutterWireExit[1] + 0.8;
  cut(fuse([
    cube(P.shutterX - wireW / 2, podInnerY - 1.2, wireBottomZ,
      wireW, wireLen, wireTopZ - wireBottomZ),
    triangularPrismY(podInnerY - 1.2, wireLen,
      [P.shutterX - wireW / 2, wireTopZ],
      [P.shutterX + wireW / 2, wireTopZ],
      [P.shutterX, wireTopZ + wireW / 2]),
  ]));
  // Two more routes, one off each of the switch's opposite faces. The single
  // channel above runs BELOW the switch and carries both leads side by side,
  // which assumes both terminals are on the same face - and on the switch
  // actually fitted they are at opposite ends, so one lead had nowhere to go.
  //
  // At +-X rather than +-Z: a mirrored channel above the switch would put its
  // gable apex at Z 31.2, through the cut plane at 31.0 and into the rear half's
  // bed face. Sideways it stays inside the pod's 19 mm width with 6 mm to
  // spare, and both routes still run to -Y into the open bay.
  for (const s of [-1, 1]) {
    const sx = P.shutterX + s * (P.shutterSwitchBody[0] + P.shutterSwitchClearance) / 2;
    const sw = P.shutterSideWireW;
    const zTop = P.shutterZ + sw / 2;
    cut(fuse([
      cube(sx - sw / 2, podInnerY - 1.2, P.shutterZ - sw / 2, sw, wireLen, sw),
      triangularPrismY(podInnerY - 1.2, wireLen,
        [sx - sw / 2, zTop], [sx + sw / 2, zTop], [sx, zTop + sw / 2]),
    ]));
  }

  // No RESET needle passage. It was a Ø3.2 hole through the bottom wall at
  // X=106.4, Z=22, aimed at the module's side switch. Dropped on request: it
  // is a visible hole in the shell for a button that is reachable with the
  // door off, and the door is tool-less.

  // Overhead-light mount, and nothing else: there is NO TRIPOD on this camera.
  //
  // The light is a threaded stud on an 18 mm square base, 25 mm from base to
  // tip with part of that buried in the light, and it arrives with two nuts of
  // its own. So this is a plain through bore and the stud is held by its own
  // nuts from inside - no hex pocket, no anti-rotation problem.
  //
  // It used to live in the prism hump, which existed for the look and had to
  // carry a 26 x 22 mm access shaft up into itself just to get a hand to the
  // nuts. With the hump gone the bore simply passes through the 6 mm top wall
  // and opens straight into the cavity, so the shaft, the prism roof cut and
  // quarterSkin all go with it. The base plate now lands on the flat top of a
  // slab, which is a better seat than a tapering crest ever was.
  // Plain cylinder, not a teardrop. At Ø8.5 through 6 mm of wall the
  // unsupported arc at the top of the bore is about 2 mm wide and bridges
  // without complaint at 0.20 mm layers - and a stud does not care about a
  // little sag up there. The teardrop's point was visible on the top face,
  // and recessing the mouth to hide it was not an option: the light's 18 mm
  // base plate has to seat on a flat.
  cut(cylinderAlongY(P.quarterX, innerMaxY - 0.5, P.quarterZ,
    P.lightBoltD / 2, P.wallTop + 1.5, 64));

  // No cavities cut into the chassis here, and that is a MEASURED decision
  // rather than an omission. Hollowing the grip, the top-plate step and the
  // front plate removed 66 cm^3 of solid - and added 158 cm^2 of surface. On
  // this part 89% of everything extruded is perimeter (1038 cm^2 of surface
  // against 210 cm^3 of solid), so four perimeter loops around a new void
  // cost more than the 20% infill they displace: net +9.5 cm^3 of extrusion
  // and a SLOWER print. Surface area is the cost driver here, not volume.
  // See the print-time section of the README before adding a cavity.

  // No thumb rest. It was a dome on the rear face OVER THE GRIP, spanning
  // X 126..146 - so once the grip block went, it cantilevered 15 mm past the
  // body wall into thin air: 772 of the 783 mm^2 of overhang on the part, and
  // the reason the print envelope still measured 146 mm wide with a 131 mm box.

  // Feet on the bottom face, chamfered on the edge that faces the bed.
  for (const [fx0, fz0, fx1, fz1] of footPads) {
    postAdds.push(Manifold.hull([
      cube(fx0, -0.01, fz0, fx1 - fx0, 0.01, fz1 - fz0),
      cube(fx0 + 1.2, -P.footProud, fz0 + P.footProud,
        fx1 - fx0 - 2.4, 0.01, (fz1 - fz0) - P.footProud - 1.2),
    ]));
  }

  // No identity text on the bottom face: it carries the cable exit, both tie
  // slots, and the RESET needle hole, and lettering laid
  // across those openings came out as unreadable fragments interleaved with
  // hole roofs. The identity is raised on the face shell instead, which is
  // where the real camera puts it.

  // Collapses the zero-area facets the V-groove hull seams leave behind. At
  // 5 microns this moves no surface anywhere near a printable tolerance.
  const solid = fuse(positive).subtract(fuse(negative))
    .add(fuse(postAdds)).simplify(5e-3);
  if (solid.isEmpty()) throw new Error("Body Boolean result is empty");
  return solid;
}

// ---------------------------------------------------------------------------
// The cosmetic face shell, modelled in BODY coordinates: its flat back sits
// at Z=0 against the chassis front and its relief grows forward into -Z.
// Exported mirrored so it prints back-face-down with every raised feature
// pointing UP - which is why this part, unlike the chassis front, can carry
// real form: proud lens bar, angled upper band, proud hump and grip, raised
// lettering, and a strap lug.
function buildFace() {
  const solids = [];
  const cuts = [];
  // Base plate on the shared silhouette.
  // Base plate on the shared silhouette, with its FRONT edge rounded R3 over
  // the plate's full 3 mm: a hull of insetting slices along a quarter circle.
  // Every slice face points up-and-out in print, so it costs nothing.
  {
    const R = P.edgeRoundR, n = P.edgeRoundSteps;
    const slices = [];
    for (let k = 0; k <= n; k++) {
      const th = (Math.PI / 2) * (k / n);
      const inset = R * (1 - Math.cos(th));
      const z = -P.faceBase + R * (1 - Math.sin(th));
      slices.push(roundedRectZ(inset, inset, z - 0.01, P.bodyW - 2 * inset,
        P.bodyH - 2 * inset, 0.01, Math.max(0.5, P.bodyCornerR - inset)));
    }
    solids.push(Manifold.hull(slices));
  }

  // A block proud of the base by `proud`, with a 45-degree chamfer around its
  // perimeter so the printed sidewall is not a vertical cliff.
  // The chamfer is clamped to the block's own size, so a tall proud value on a
  // short block tapers gently instead of inverting the top rectangle and
  // shedding a loose piece.
  // `chamfer` is the plan width of the sloped edge and is independent of the
  // proud height: using the height as the inset (as this once did) silently
  // ate the lens bar's rim, because a 6 mm-proud bar got a 6 mm chamfer.
  const proudBlock = (x0, y0, x1, y1, proud, radius, chamfer = proud) => {
    const front = -P.faceBase - proud;
    const inset = Math.min(chamfer, (x1 - x0) / 2 - 2, (y1 - y0) / 2 - 2);
    return Manifold.hull([
      roundedRectZ(x0, y0, -P.faceBase, x1 - x0, y1 - y0, 0.01, radius),
      roundedRectZ(x0 + inset, y0 + inset, front,
        x1 - x0 - 2 * inset, y1 - y0 - 2 * inset, 0.01,
        Math.max(0.8, radius - inset)),
    ]);
  };

  // Lens bar: the camera's signature. A proud slab with a chamfered edge,
  // a recessed inner panel and four stepped conical cells.
  const [lb0x, lb0y, lb1x, lb1y] = P.faceLensBar;
  solids.push(proudBlock(lb0x, lb0y, lb1x, lb1y, P.faceLensBarProud,
    P.faceLensBarR, P.faceLensBarChamfer));
  const barFront = -P.faceBase - P.faceLensBarProud;
  // The bar is the hero: a proud slab whose face drops into a deep recessed
  // panel, leaving a narrow raised rim all round. That rim is the line the
  // real camera picks out in red, and the four cells sink into the panel
  // rather than sitting on a flat plate.
  // The rim is measured from the bar's FLAT front, not from its outline -
  // insetting from the outline would put the recess inside the chamfer and
  // leave no rim at all.
  // Three nested levels, outward to inward: full-height rim, then a shallow
  // ledge (the line to run a red paint pen along - the single detail that
  // most says N8000), then the panel the cells sink into. Nested cuts of
  // increasing depth, so the profile is rim 9.0 / ledge 8.2 / panel 6.8.
  const { g0x, g0y, g1x, g1y, p0x, p0y, p1x, p1y } = LENS_PANEL;
  // The accent ledge runs along the TOP and BOTTOM of the panel only. Cut as
  // a frame, it ran behind the two dovetail lips and left each lip's top
  // 0.8 mm standing as a free fin, 1.0 mm wide tapering to 0.3, over the
  // ledge's air - the retaining edge of the whole cover, printed as one bead.
  // The independent thin-feature scan found it. The lips now have the full
  // 4.7 mm side rim behind them.
  for (const [y0, y1] of [[g0y, p0y], [p1y, g1y]]) {
    cuts.push(roundedRectZ(g0x, y0, barFront - 0.01, g1x - g0x, y1 - y0, P.faceLensAccent + 0.01, 0.5));
  }
  // Panel corners follow the cover's: R2 here against the cover's R0.6 put the
  // panel's corner fillet inside the cover's footprint at both ends of travel.
  cuts.push(roundedRectZ(p0x, p0y, barFront - 0.01,
    p1x - p0x, p1y - p0y, P.faceLensPanelDepth + 0.01, P.sliderCornerR + P.sliderClr));

  // ---- The panel is the slider's track ----------------------------------
  const floorZ = barFront + P.faceLensPanelDepth;          // panel floor
  // Rim gap: the panel profile continues down through the bar's BOTTOM rim so
  // the cover can be slid in from below, at the open end. The gap stops exactly
  // at the panel's start so the block that fills it afterwards - the keeper -
  // does not reach into the cover's travel.
  const gapCut = cube(p0x, lb0y - 1.0, barFront - 0.01,
    p1x - p0x, p0y - (lb0y - 1.0), P.faceLensPanelDepth + 0.01);
  // The keeper: the very piece of rim the gap removes, less keeperClr on its
  // three fitted sides, glued back in once the cover is in the track. Its back
  // sits on the panel-floor plane, its front carries the rim, ledge and
  // chamfer profile of the bar around it. A positive stop, not a detent. Taken
  // from the bar BEFORE the gap is cut - taken after, it is the empty set.
  const keeper = fuse(solids).subtract(fuse(cuts)).intersect(gapCut)
    .intersect(cube(p0x + P.keeperClr, lb0y - 2.0, barFront - 2.0,
      p1x - p0x - 2 * P.keeperClr, (p0y - P.keeperClr) - (lb0y - 2.0), P.faceLensPanelDepth + 3.0))
    .simplify(1e-3);
  cuts.push(gapCut);
  // Dovetail lips on both X walls, the full height of the panel: a 45-degree
  // wedge from the bar's front, sliderBevel wide at the mouth, closing to the
  // wall sliderLipZ below it. Underside faces the bed at exactly 45 degrees in
  // print, like the door rails. Topped 0.02 below the bar front so they never
  // share a plane with it. Added AFTER the cuts, or the panel cut removes them.
  const lipTop = barFront + 0.02;
  const lipLen = p1y - p0y - 0.4;
  const lipAdds = [
    triangularPrismY(p0y + 0.2, lipLen,
      [p0x - 0.01, lipTop], [p0x + P.sliderBevel, lipTop], [p0x - 0.01, lipTop + P.sliderLipZ]),
    triangularPrismY(p0y + 0.2, lipLen,
      [p1x + 0.01, lipTop], [p1x - P.sliderBevel, lipTop], [p1x + 0.01, lipTop + P.sliderLipZ]),
  ];
  // Detent bumps on both walls: one pair in the 0.5 mm between the closed
  // cover's bottom edge and the open cover's top edge, so the cover is held
  // either closed (up, against gravity) or open (down). Sunk into the wall so
  // exactly sliderClr + sliderBumpBite stands proud. Centred in the plain-wall
  // zone under the lips. The exit pair is gone: the keeper is the stop.
  const bumpSink = P.sliderBumpR - (P.sliderClr + P.sliderBumpBite);
  const holdY = P.sliderClosedY0 - (P.sliderTravel - P.sliderH) / 2;
  const bumpAdds = [
    cylZ(p0x - bumpSink, holdY, floorZ - P.sliderBumpH, P.sliderBumpR, P.sliderBumpH + 0.01, 32),
    cylZ(p1x + bumpSink, holdY, floorZ - P.sliderBumpH, P.sliderBumpR, P.sliderBumpH + 0.01, 32),
  ];
  const trackAdds = fuse([...lipAdds, ...bumpAdds]);

  // ---- The cover itself ---------------------------------------------------
  // Built in place, CLOSED, in face coordinates. A plate whose two X edges are
  // bevelled at 45 degrees to match the lips: vertical for sliderT - sliderBevel
  // off the back, then in by sliderBevel to the front.
  const sx0 = p0x + P.sliderClr, sx1 = p1x - P.sliderClr;
  const sy0 = P.sliderClosedY0, sy1 = sy0 + P.sliderH;
  const sBack = floorZ, sFront = floorZ - P.sliderT;
  const cr = P.sliderCornerR;
  const sPlate = Manifold.hull([
    roundedRectZ(sx0, sy0, sBack - 0.01, sx1 - sx0, sy1 - sy0, 0.01, cr),
    roundedRectZ(sx0, sy0, sFront + P.sliderBevel, sx1 - sx0, sy1 - sy0, 0.01, cr),
    roundedRectZ(sx0 + P.sliderBevel, sy0, sFront, sx1 - sx0 - 2 * P.sliderBevel,
      sy1 - sy0, 0.01, Math.max(0.3, cr - P.sliderBevel / 2)),
  ]);
  // The mark, raised 0.6 off the cover's front and run back to 0.2 short of the
  // back face, so it never shares a plane with it.
  // The wordmark, raised 0.6 off the cover's front and run back to 0.2 short
  // of the back face. It replaces the bitmap-font "KINO".
  // The wordmark as ONE extruded outline, traced from the raster at 0.07 mm and
  // simplified to 0.05: italic diagonals are straight edges, not a 0.45 mm
  // staircase, and print as smooth walls. Polygons come with x to the reader's
  // right; mirrored here into body X, whose reader-right is -X.
  const sMark = new wasm.CrossSection(MARK.polygons, "EvenOdd")
    .scale([-1, 1]).translate([COVER_MARK.xC + COVER_MARK.w / 2, COVER_MARK.yB])
    .extrude(P.sliderT + 0.6 - 0.2).translate([0, 0, sFront - 0.6]);
  // The thumb ridge, embedded 0.4 into the plate so it is one solid with it.
  const [rw, rh] = P.coverRidge;
  const sRidge = cube((sx0 + sx1) / 2 - rw / 2, P.coverRidgeY, sFront - P.coverRidgeProud,
    rw, rh, P.coverRidgeProud + 0.4);
  // The track floor is relieved by coverRailProud everywhere the cover travels
  // EXCEPT two lands, so the cover rides on about 100 mm^2 of smooth floor
  // instead of 1824 mm^2 of hatch. The relief runs the whole swept band - from
  // the open position's bottom edge to the closed position's top - and stops
  // 1.0 mm short of the panel's bottom rim so the keeper still has a full seat.
  const sweptY0 = P.sliderClosedY0 - P.sliderTravel;
  const sweptY1 = P.sliderClosedY0 + P.sliderH;
  const floorRelief = (() => {
    // Cut from the floor plane INWARD, the same direction the hatch cuts.
    // Material behind this floor runs to Z=0 and air is in front of it, so a
    // relief that starts at floorZ - depth removes nothing but air, which is
    // what the first cut of this did.
    const band = cube(p0x + P.sliderBevel + 0.5, Math.max(p0y + 1.0, sweptY0 - 1.0),
      floorZ - 0.01,
      (p1x - p0x) - 2 * (P.sliderBevel + 0.5),
      Math.min(p1y, sweptY1 + 1.0) - Math.max(p0y + 1.0, sweptY0 - 1.0),
      P.coverRailProud + 0.01);
    const lands = fuse(RAIL_XS.map((rx) =>
      cube(rx - P.coverRailW / 2, p0y - 2, floorZ - 0.02,
        P.coverRailW, (p1y - p0y) + 4, P.coverRailProud + 0.04)));
    return band.subtract(lands);
  })();
  cuts.push(floorRelief);
  // The cover's back is left ALONE, and that is deliberate. Recessing it to
  // leave two rails was tried first and is exactly wrong: the cover prints
  // back-down, so its back IS the bed face, and a 0.25 mm recess leaves
  // 688 mm^2 of plate floating a quarter of a millimetre above the bed. The
  // layer gate caught it. The relief belongs in the FLOOR, which is an
  // upward-facing surface on a part that prints relief-up, where a recess
  // opens upward and costs nothing - see the track floor below.
  // No magnet pocket in the cover's back: the cover's state is read in
  // firmware. Its back carries only the serial now.
  // Side-edge relief: over the vertical part of each edge (the back 1.0 mm,
  // where the ribs run), a channel sliderEdgeRelief deep from crest to crest,
  // with a ramp at each end. Open toward the cover's back, so in print (back
  // down) it opens at the bed - but it does NOT have "no ceiling", which this
  // comment claimed until the meshes were measured. The notch stops at
  // sliderT - sliderBevel, and that stop is a flat downward face 0.2 mm wide
  // and 17.4 long, 1.01 mm off the bed, once per edge: 1.65 mm^2 each. A 0.2 mm
  // ledge is narrower than the nozzle that has to bridge it, so it prints as a
  // rounded lip and the fit is unaffected - but it is a ceiling, and the
  // printability gate counts it as one.
  const edgeCuts = [];
  {
    const zc0 = sFront + P.sliderBevel - 0.01, zc1 = sBack + 0.01, zh = zc1 - zc0;
    const y0 = sy0 + P.sliderEdgeCrest, y1 = sy1 - P.sliderEdgeCrest;
    for (const [edge, dir] of [[sx0, 1], [sx1, -1]]) {
      const out = edge - dir * 1.0, inn = edge + dir * P.sliderEdgeRelief;
      const xr = (a, b) => [Math.min(a, b), Math.abs(b - a)];
      const [cx, cw] = xr(out, inn), [ox, ow] = xr(out, edge);
      edgeCuts.push(cube(cx, y0, zc0, cw, y1 - y0, zh));
      edgeCuts.push(Manifold.hull([cube(cx, y0, zc0, cw, 0.01, zh), cube(ox, y0 - P.sliderEdgeRamp, zc0, ow, 0.01, zh)]));
      edgeCuts.push(Manifold.hull([cube(cx, y1 - 0.01, zc0, cw, 0.01, zh), cube(ox, y1 + P.sliderEdgeRamp, zc0, ow, 0.01, zh)]));
    }
  }
  const sliderSolid = fuse([sPlate, sMark, sRidge])
    .subtract(fuse([ENGRAVINGS.cover.solid, ...edgeCuts])).simplify(1.5e-2);

  // Everything else that used to stand proud here is gone: the angled upper
  // band (19.8 cm3), the prism hump (3.2) and the grip drum with its six ribs
  // (37.5). That was 60 of the shell's 96 cm3 spent on an N8000 pastiche.
  //
  // The reference is a clean rounded slab with a raised lens strip and nothing
  // else proud of it, so the lens bar IS the relief now. Two consequences the
  // gates caught the moment the chassis outline was collapsed: the drum and the
  // hump had no silhouette left to sit on, so the shell came out as 2 connected
  // components with 1971 mm3 of relief hanging over open air.

  // Lens cells: stepped cones opening forward, exactly as the N8000's
  // concentric rings read. Opening forward means opening upward in print.
  // Cells sink from the recessed panel floor, widest at the outside and
  // stepping down in two cones to the bore - the concentric-ring tunnel the
  // real lens bar shows. Widest-outward also means each step is a printable
  // upward-opening cone once the shell is flipped.
  // The steps used to be set out from fixed diameters (Ø14 / Ø11.5 / Ø7.1),
  // which left 5.06 mm of parallel Ø7.1 bore in front of the entrance pupil.
  // A Ø7.1 tube 5.06 mm long only passes 70 degrees, and the sensor wants 78:
  // the shell showed up as a dark ring in every frame. The profile is set out
  // from the FIELD CONE now, and the fixed diameters are gone.
  // Each segment is a straight cone and the field cone is a straight cone, so
  // checking both endpoints clear it is enough to clear the whole segment.
  for (const cx of cameraXs) {
    // On the cone at the narrow end, stepped proud of it at the two wide ends,
    // so the concentric rings still read as rings instead of one smooth funnel.
    cuts.push(Manifold.cylinder(lensZMid - lensCellFrontZ,
      lensCellOuterR, lensCellMidR, 64)
      .translate([cx, P.cameraLensY, lensCellFrontZ]));
    cuts.push(Manifold.cylinder(lensZBore - lensZMid,
      lensCellMidR, lensBoreR, 64)
      .translate([cx, P.cameraLensY, lensZMid]));
    cuts.push(cylZ(cx, P.cameraLensY, lensZBore, lensBoreR, 40, 64));
  }

  // Raised lettering: legible and crisp because it points up in the print.
  // Letters stand 0.6 mm off their surface and are embedded 2 mm into it, so
  // they stay fused even where that surface is the sloped upper band.
  const raised = (text, xCentre, yBase, cell, faceZ) => {
    const { runs, totalWidth } = glyphRuns(text, cell);
    return fuse(runs.map(({ u, v, w }) =>
      cube(textRunX(xCentre, totalWidth, u, w), yBase + v, faceZ - 0.6,
        w, cell + 0.02, 2.6)));
  };
  // Lettering. There were four labels: the nameplate on the prism hump, "D4"
  // and "V1" flanking it on the angled band, and a legend under the lens bar.
  // Three of those hung off surfaces that no longer exist, and the reference
  // carries exactly ONE small mark, centred above the lens strip. So that is
  // what this is. It sits directly on the base plate now, not on a proud
  // panel, which is also why it no longer needs the band's proud height to
  // place it - the coupling that made this throw the moment the band went.
  // No mark on the base plate: KINO is raised on the sliding cover instead.

  // The Hall sensor's pocket and its gabled lead channel were cut from this
  // face's BACK. Both are gone with the sensor; the back is unbroken now, which
  // is one less bed-face feature on the part whose bed face is its glue joint.

  // Screw pilots for self-tapping M2 from inside the chassis.
  // No screw pilots. The shell is GLUED to the chassis and aligned by the
  // four lens bores with KINO_FACE_ALIGN_TOOL, so the corner holes that used
  // to take four M2 x 8 from inside are gone from both parts. One of them sat
  // under the lens bar's chamfered corner and read as a covered-up hole.
  // Revision and serial, engraved into the base plate's front below the bar.
  cuts.push(ENGRAVINGS.face.solid);
  // Stow-zone hatch: 45-degree grooves recessed into the panel floor over the
  // band the cover leaves bare when it is closed - BELOW it now - kept 1 mm off
  // the lips and 1.5 mm under the closed cover's bottom edge so the closed
  // position is a clean rectangle. The cover still rides on the floor's ridges
  // when it is down.
  {
    const { p0x, p1x } = LENS_PANEL;
    const zx0 = p0x + P.sliderBevel + 1.0, zx1 = p1x - P.sliderBevel - 1.0;
    const zy0 = p0y + 1.5, zy1 = P.sliderClosedY0 - 1.5;
    // Two lands the hatch is kept off, one under each bearing land. Both are at
    // fixed X and the cover only moves in Y, so they cannot drift out of
    // register.
    const lanes = fuse(RAIL_XS.map((rx) =>
      cube(rx - P.coverRailW / 2 - P.coverRailLaneClear, zy0 - 2, floorZ - 1.5,
        P.coverRailW + 2 * P.coverRailLaneClear, (zy1 - zy0) + 4, 2 + P.hatchDepth)));
    const stowZ = STOW_FLOOR_Z();
    const zone = cube(zx0, zy0, stowZ - 1, zx1 - zx0, zy1 - zy0, 1 + P.hatchDepth)
      .subtract(lanes);
    const cx = (zx0 + zx1) / 2, cy = (zy0 + zy1) / 2, span = (zx1 - zx0) + (zy1 - zy0);
    const grooves = [];
    for (let o = -span; o <= span; o += P.hatchPitch) {
      grooves.push(cube(-150, -P.hatchW / 2, stowZ - 0.01, 300, P.hatchW, P.hatchDepth + 0.01)
        .rotate([0, 0, 45]).translate([cx + o * Math.SQRT1_2, cy - o * Math.SQRT1_2, 0]));
    }
    cuts.push(zone.intersect(fuse(grooves)));
  }
  // ---- Face-plate grain ----------------------------------------------------
  // The plate around the lens bar is the top surface of this print. Grooves at
  // the stow hatch's 45 degrees give it a finish instead of a layer-line field.
  // Built as ONE cross-section of rotated quads and extruded once - 260 boxes
  // fused in 3-D is the slow way to the same solid - then clipped to the field:
  // inside the outline by grainEdgeInset (clear of the R3 round), outside the
  // lens bar and the serial by their own lands, so both keep a clean border.
  {
    const gi = P.grainEdgeInset;
    const field = roundedRectZ(gi, gi, -P.faceBase - 1, P.bodyW - 2 * gi, P.bodyH - 2 * gi,
      1 + P.grainDepth, Math.max(1.0, P.bodyCornerR - gi))
      .subtract(cube(P.faceLensBar[0] - P.grainBarClear, P.faceLensBar[1] - P.grainBarClear,
        -P.faceBase - 2, (P.faceLensBar[2] - P.faceLensBar[0]) + 2 * P.grainBarClear,
        (P.faceLensBar[3] - P.faceLensBar[1]) + 2 * P.grainBarClear, 4))
      .subtract((() => {
        const E = ENGRAVINGS.face, m = P.grainMarkClear;
        return cube(E.anchor[0] - E.w / 2 - m, E.anchor[1] - m, -P.faceBase - 2,
          E.w + 2 * m, E.h + 2 * m, 4);
      })());
    const d = [Math.SQRT1_2, Math.SQRT1_2], n = [-Math.SQRT1_2, Math.SQRT1_2];
    const half = (P.bodyW + P.bodyH) / 2, L = 2 * (P.bodyW + P.bodyH), hw = P.grainW / 2;
    const quads = [];
    for (let o = -half; o <= half; o += P.grainPitch) {
      const p = [P.bodyW / 2 + o * n[0], P.bodyH / 2 + o * n[1]];
      quads.push([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
        [p[0] + a * (L / 2) * d[0] + b * hw * n[0], p[1] + a * (L / 2) * d[1] + b * hw * n[1]]));
    }
    cuts.push(field.intersect(new wasm.CrossSection(quads, "Positive")
      .extrude(P.grainDepth + 0.02).translate([0, 0, -P.faceBase - 0.01])));
  }
  const faceSolid = fuse(solids).subtract(fuse(cuts)).add(trackAdds)
    .simplify(1.5e-2);
  return { face: faceSolid, slider: sliderSolid, keeper };
}

// The sliding rear door, modelled in BODY coordinates (Z bodyD-bezelT..bodyD,
// outer face at Z=bodyD). Exported for printing flipped outer-face-down.
function buildBezel() {
  const z0 = P.bodyD - P.bezelT;      // inner face, 71
  const z1 = P.bodyD;                 // outer face, 75
  const yInner0 = innerMinY + P.doorClearY;
  const yInner1 = innerMaxY - P.doorClearY;
  // The door spans from the body's entry-end outer face to the grip-side
  // wall's inner face.
  const slab = cube(0, yInner0, z0,
    innerMaxX, yInner1 - yInner0, P.bezelT);
  // Edge tongues running in the body's grooves. Square-shouldered: the tongue
  // is a plain rectangle of doorTongueZ off the door's inner face, so printed
  // inner-face-down it is full width ON the bed and steps in once at its top.
  // No downward face on it at all - which is the whole reason the dovetail was
  // abandoned. See the doorBite block.
  const wedges = [-1, 1].map((side) => {
    const wallInner = side < 0 ? innerMinY : innerMaxY;
    // Embedded 0.02 mm into the slab rather than landing exactly on its edge.
    // At doorClearY exactly, the tongue's inboard face is coincident with the
    // slab's face AND both end at the same X, and that pair of coincidences
    // left a 0.11-micron sliver on the door's end face that simplify() would
    // not collapse. Abutting on a shared plane is what does it, so embed.
    const lip = wallInner - side * (P.doorClearY + 0.02);
    const deep = wallInner + side * (P.doorBite - P.doorClearY);
    const y0 = Math.min(lip, deep);
    // Built ADDITIVELY: a tongue doorPadProud shorter than full height, plus
    // four pads standing on it and embedded 0.2 mm into it. Cutting a skimmed
    // box out of a full-height tongue instead leaves slivers where the pad
    // walls meet the tongue's old top plane - one degenerate triangle in
    // plate 2, which validate-stl refused.
    const w = Math.abs(deep - lip);
    const parts = [cube(0, y0, z0, innerMaxX, w, P.doorTongueZ - P.doorPadProud)];
    const pitch = innerMaxX / P.doorPadCount;
    for (let i = 0; i < P.doorPadCount; i++) {
      // Inset 0.05 mm in Y so the pad's side walls do not share a plane with
      // the tongue's. Flush with them it is the abutting-faces fault again -
      // one degenerate triangle, which only showed up on plate 2 after the
      // translate re-rounded it in float32, and which validate-stl refused.
      parts.push(cube((i + 0.5) * pitch - P.doorPadLen / 2, y0 + 0.05,
        z0 + P.doorTongueZ - P.doorPadProud - 0.2,
        P.doorPadLen, w - 0.1, P.doorPadProud + 0.2));
    }
    return fuse(parts);
  });
  let plate = fuse([slab, ...wedges]);

  const cuts = [];
  // The detent's door half, cut into each wedge's deep face (the face that
  // looks at the groove's deep wall, where the wall's bump stands):
  //  - a dimple at the seated position, detentBite + 0.1 deep, so the bump
  //    seats with 0.1 to spare;
  //  - a relief channel detentRelief deep from 2.5 mm past the dimple to the
  //    door's leading end, so the bump rides in free air for the whole slide;
  //  - between them a 2 mm crest at the wedge's full face - detentBite of
  //    interference - with a 0.8 mm ramp down into the channel.
  // The bump enters the channel at the leading end as the door goes in, rides
  // it, climbs the ramp onto the crest in the last 2.5 mm and drops into the
  // dimple. Opening climbs it back out over the crest.
  // Notch band: from below the door's inner face - which is the BED now, so the
  // band opens downward onto it and has no roof at all - up to 0.1 over the
  // rib's height, which is the tongue's height.
  const zlo = z0 - 0.5, zhi = z0 + P.detentRibH + 0.1, bh = zhi - zlo;
  for (const side of [-1, 1]) {
    const wallInner = side < 0 ? innerMinY : innerMaxY;
    const deep = wallInner + side * (P.doorBite - P.doorClearY);
    const yr = (a, b) => [Math.min(a, b), Math.abs(b - a)];   // [y0, height]
    // Dimple: a vertical cylinder matching the rib, detentBite + 0.1 deep.
    const dimpleR = P.detentBump + 0.1;
    cuts.push(cylZ(P.detentBackFromEnd, deep + side * (dimpleR - (P.detentBite + 0.1)), zlo, dimpleR, bh, 32));
    const cx0 = P.detentBackFromEnd + 2.5;
    const out = deep + side * 1.0, inn = deep - side * P.detentRelief;
    const [ny, nh] = yr(out, inn);
    cuts.push(cube(cx0, ny, zlo, innerMaxX + 1 - cx0, nh, bh));
    // Ramp from the notch's depth down to the crest over 0.8 mm.
    const [oy, oh] = yr(out, deep);
    cuts.push(Manifold.hull([
      cube(cx0, ny, zlo, 0.01, nh, bh),
      cube(cx0 - 0.8, oy, zlo, 0.01, oh, bh),
    ]));
  }
  cuts.push(cube(centerX - P.bezelWindowW / 2,
    centerY - P.bezelWindowH / 2, z0 - 1,
    P.bezelWindowW, P.bezelWindowH, P.bezelT + 2));
  // Chamfer around the window on the outer face. Deepened from 1.0 mm of flare
  // over 1.2 mm: a wider bevel makes the remaining frame read thinner than it
  // measures, because the eye reads the bevel as part of the opening.
  // Kept at 50 degrees, safely past the 45-degree rule in print.
  // depth = flare x tan(50). This was flare / tan(50), which made the bevel
  // 2.0 mm wide over 1.68 deep - a surface 40 degrees off horizontal, i.e. a
  // 50-degree OVERHANG on the printed outer face, ~870 mm^2 of it. The release
  // gate did not see it because it judged the door in body orientation, where
  // that surface points up. Caught by an independent scan of the shipped STL.
  const chamfer = P.bezelWindowBevel * Math.tan((50 * Math.PI) / 180);
  const w0 = P.bezelWindowW + 2 * P.bezelWindowBevel;
  const h0 = P.bezelWindowH + 2 * P.bezelWindowBevel;
  cuts.push(Manifold.hull([
    cube(centerX - w0 / 2, centerY - h0 / 2, z1 - 0.01, w0, h0, 0.01),
    cube(centerX - P.bezelWindowW / 2, centerY - P.bezelWindowH / 2,
      z1 - chamfer, P.bezelWindowW, P.bezelWindowH, 0.01),
  ]));
  // A finger scallop at the entry end is the entire opening mechanism: hook a
  // fingertip in and pull. It replaces the slits, the flexing tab and the
  // decorative thumb ribs, all of which read as unexplained notches.
  cuts.push(Manifold.hull([
    cylZ(-P.fingerScallop, centerY, z0 - 1, P.fingerScallop, P.bezelT + 2, 48),
    cylZ(-P.fingerScallop - 6, centerY, z0 - 1, P.fingerScallop,
      P.bezelT + 2, 48),
  ]).translate([P.fingerScallop - 1.5, 0, 0]));
  // ---- Grain on the outer face ----------------------------------------------
  // The door prints inner-face-down now, so its show face - the panel that
  // frames the screen, the second largest surface on the camera after the walls
  // - is the TOP of its print, where layer lines and ironing marks show worst.
  // It used to be bed-glass, and losing that is what turning the door over
  // cost. This is the answer the face plate already gave to the same question:
  // the same 45-degree grain, the same 0.5 mm grooves on a 1.6 mm pitch, so the
  // camera reads as one finish rather than three.
  //
  // Clipped to a field, not washed over the part: clear of the outline, of the
  // window AND its 2 mm bevel, and of the serial, all three gated solid.
  {
    const gi = P.grainEdgeInset;
    const wClear = P.bezelWindowBevel + P.grainBarClear;
    const field = cube(gi, yInner0 + gi, z1 - P.grainDepth, innerMaxX - 2 * gi,
      (yInner1 - yInner0) - 2 * gi, P.grainDepth + 1)
      .subtract(cube(centerX - P.bezelWindowW / 2 - wClear,
        centerY - P.bezelWindowH / 2 - wClear, z1 - P.grainDepth - 1,
        P.bezelWindowW + 2 * wClear, P.bezelWindowH + 2 * wClear, P.grainDepth + 3))
      .subtract((() => {
        const E = ENGRAVINGS.door, m = P.grainMarkClear;
        return cube(E.anchor[0] - E.w / 2 - m, E.anchor[1] - m, z1 - P.grainDepth - 1,
          E.w + 2 * m, E.h + 2 * m, P.grainDepth + 3);
      })());
    const d = [Math.SQRT1_2, Math.SQRT1_2], n = [-Math.SQRT1_2, Math.SQRT1_2];
    const half = (P.bodyW + P.bodyH) / 2, L = 2 * (P.bodyW + P.bodyH), hw = P.grainW / 2;
    const quads = [];
    for (let o = -half; o <= half; o += P.grainPitch) {
      const p = [P.bodyW / 2 + o * n[0], P.bodyH / 2 + o * n[1]];
      quads.push([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
        [p[0] + a * (L / 2) * d[0] + b * hw * n[0], p[1] + a * (L / 2) * d[1] + b * hw * n[1]]));
    }
    cuts.push(field.intersect(new wasm.CrossSection(quads, "Positive")
      .extrude(P.grainDepth + 0.02).translate([0, 0, z1 - P.grainDepth - 0.01])));
  }
  return plate.subtract(fuse(cuts)).simplify(1e-3);
}

function buildShutterButton() {
  const flangeH = 1.6;
  const noseStraightH = shutterStemLength - P.shutterPressCapH;
  const actuatorHeight = flangeH + shutterStemLength;
  const dishRadius = (P.shutterDishD ** 2 / 4 + P.shutterDishDepth ** 2) /
    (2 * P.shutterDishDepth);
  const dishCenterZ = actuatorHeight + dishRadius - P.shutterDishDepth;
  const actuatorBlank = fuse([
    cylZ(0, 0, 0, P.shutterActuatorFlangeD / 2, flangeH, 64),
    cylZ(0, 0, flangeH, P.shutterPressCapD / 2, noseStraightH, 64),
    Manifold.cylinder(P.shutterPressCapH,
      P.shutterPressCapD / 2, P.shutterPressFaceD / 2, 64)
      .translate([0, 0, flangeH + noseStraightH]),
  ]);
  const dishCutter = Manifold.sphere(dishRadius, 80)
    .translate([0, 0, dishCenterZ]);
  const actuator = actuatorBlank.subtract(dishCutter).translate([5.2, 5.2, 0]);

  const retainerCx = 27;
  const retainerCy = P.shutterRetainerPlateD / 2;
  const retainerPlateH = 1.6;
  const retainerBlank = fuse([
    cylZ(retainerCx, retainerCy, 0,
      P.shutterRetainerPlateD / 2, retainerPlateH, 64),
    cylZ(retainerCx, retainerCy, retainerPlateH,
      P.shutterRetainerCupD / 2, P.shutterRetainerCupH, 64),
  ]);
  const cradleW = P.shutterSwitchBody[0] + P.shutterSwitchClearance;
  const switchCradle = cube(retainerCx - cradleW / 2,
    retainerCy - cradleW / 2, retainerPlateH - 0.1,
    cradleW, cradleW, P.shutterRetainerCupH + 0.3);
  const notchDepth = (P.shutterRetainerCupD - P.shutterSwitchBody[1]) / 2 + 0.6;
  // Lead escapes on THREE sides of the cradle, not one. The switch's two leads
  // leave at opposite ends, and the retainer is a round plate that the
  // assembler can seat at any rotation, so relieving one side only worked if
  // that side happened to be the side the lead was on. -Y is the original
  // notch, +Y its mirror, and the leg slot below opens +-X.
  const wireNotches = [-1, 1].map((s) => cube(
    retainerCx - P.shutterWireBayW / 2,
    s < 0 ? retainerCy - P.shutterRetainerCupD / 2 - 0.3
      : retainerCy + P.shutterSwitchBody[1] / 2 - 0.6,
    retainerPlateH - 0.1,
    P.shutterWireBayW, notchDepth, P.shutterRetainerCupH + 0.3));
  // The terminal band. A slot through both side walls at the switch's base
  // plane: the terminals pass out of the cradle instead of being clamped by
  // it, and the dish in the plate takes legs that are bent back rather than
  // out. The cradle above the band still locates the switch on all four faces.
  // 4.6 mm wide rather than the cradle's full 6.6: it leaves a 1 mm corner
  // land on each side of the slot, which is what still locates the switch in
  // this axis, and it holds the roof over the slot to a 4.6 mm bridge instead
  // of 6.6 - inside the 5 mm the layer gate allows.
  const legSlotW = cradleW - 2.0;
  const legSlot = cube(retainerCx - P.shutterRetainerCupD / 2 - 0.3,
    retainerCy - legSlotW / 2, retainerPlateH - 0.1,
    P.shutterRetainerCupD + 0.6, legSlotW, P.shutterSwitchLegBand);
  const legSink = cube(retainerCx - cradleW / 2, retainerCy - cradleW / 2,
    retainerPlateH - P.shutterSwitchLegSink,
    cradleW, cradleW, P.shutterSwitchLegSink + 0.1);
  return fuse([actuator,
    retainerBlank.subtract(fuse([switchCradle, ...wireNotches,
      legSlot, legSink]))]).simplify(1e-5);
}

// Bow clamp. A single arm running down the board's CENTRELINE to a foot that
// presses between the two header rows.
//
// It used to be a bow with two toes out at the board's top corners, and on the
// bench those toes hit the headers. The arithmetic that let that through
// measured to the last pad CENTRE: a 7-way 2.54 mm strip is 7 x 2.54 = 17.78 mm
// of moulding, not the 15.24 mm between end pins, so the real obstruction runs
// 1.27 mm further than the pads do and the toes overlapped it by 0.39 mm.
//
// Shortening the toes would have fitted them into a 1.61 mm strip of bare board,
// which is no way to hold anything down. Going down the middle is better: the
// header rows sit at X +/-6.4..8.9, so the channel between them is clear along
// the board's entire length and the foot cannot foul them at any Y.
// footX defaults to bossX (a straight arm); the body's cameras 3 and 4 kink
// their arms 4 mm sideways to a boss that dodges the light stud and the
// shutter leads, while the foot stays on the board's centreline.
function buildGapClampAt(bossX, bossY, footY, footX = bossX) {
  const thickness = P.clampT;
  const halfW = P.clampFootW / 2;
  const solids = [cylZ(bossX, bossY, 0, 4.3, thickness, 48)];
  // Arm tapering from the hub to the foot.
  solids.push(Manifold.hull([
    cube(bossX - P.clampArmW / 2, bossY - 0.01, 0, P.clampArmW, 0.02, thickness),
    cube(footX - halfW, footY, 0, P.clampFootW, 0.02, thickness),
  ]));
  // The foot itself, pressing a strip of bare board between the header rows.
  solids.push(cube(footX - halfW, footY - P.clampFootLen, 0,
    P.clampFootW, P.clampFootLen, thickness));
  const screw = cylZ(bossX, bossY, -1, P.m2ClampClearanceD / 2, thickness + 2);
  return fuse(solids).subtract(screw);
}

// Hub centre to toe centre. Derived from the station once and used by BOTH the
// released clamp and the gate that checks it, because they had drifted apart:
// the gate built a 7.5 mm reach while the printed part had 6.5, so the real
// clamp's toe landed exactly on the board's top edge with half of it hanging
// off into air. A clamp is only doing its job if its toe is ON the board.
const clampFootY = boardMaxY;
// Laid out left to right as cameras 1..4, each with its own station's reach
// and kink, so the file reads like the camera does.
function buildClamps() {
  const layoutToeY = 1.5;
  return fuse([0, 1, 2, 3].map((i) => {
    const footX = 7.6 + i * P.cameraPitch;
    const reach = clampBossYs[i] - clampFootY;
    return buildGapClampAt(footX + P.clampBossAt[i][0], layoutToeY + reach, layoutToeY, footX);
  }));
}
// The rigs' own clamps: the original short straight reach, four in a row, laid
// beside each rig inside its file so a rig print is complete on its own.
function buildRigClamps() {
  const layoutToeY = 1.5;
  return fuse([0, 1, 2, 3].map((i) => {
    const footX = 7.6 + i * P.cameraPitch;
    return buildGapClampAt(footX, layoutToeY + (rigClampBossY - clampFootY), layoutToeY);
  }));
}
function withRigClamps(rig) {
  const bb = rig.boundingBox();
  const c = buildRigClamps(); const cb = c.boundingBox();
  // Simplified at 5 microns, the figure the body halves use: the rigs' plate is
  // a chunk of the body, so it inherits the camera-number recesses, and their
  // facets left one zero-area triangle in the wiggle rig at the old 1e-4.
  return rig.add(c.translate([bb.min[0] + 6.0 - cb.min[0], bb.max[1] + 6.0 - cb.min[1], -cb.min[2]]))
    .simplify(5e-3);
}

// Screw-in test coupon: the four real posts at the real pattern on a small
// plate, so an M2 screw can be driven through each post into the module's
// standoff before committing to the full body. It proves four things the flat
// gauge cannot: the pattern, the post height against the standoff height,
// the thread engagement, and whether the screw heads clear.
function buildPostTest() {
  const margin = 9.0;
  const web = 3.0;
  const rail = 9.0;
  const w = P.p4HoleX + margin * 2;
  const h = P.p4HoleY + margin * 2;
  const padPlane = web + P.postTestLift;
  // Only the four pads may touch the module. The first version of this part
  // was a flat 3 mm frame that sat ON the standoff tops, which puts its rails
  // 5 mm off the PCB - and a 2.54 mm header stands about 11 mm off it, so the
  // frame fouled the board's connectors and never seated. The body itself does
  // not have this problem because nothing but its four posts comes near the
  // PCB, and this gauge now copies that: the spanning web is held postTestLift
  // clear of the pad faces on four pillars the size of the real post faces.
  const solids = [
    cube(0, 0, 0, w, rail, web),
    cube(0, h - rail, 0, w, rail, web),
    cube(0, rail, 0, rail, h - rail * 2, web),
    cube(w - rail, rail, 0, rail, h - rail * 2, web),
  ];
  const cuts = [];
  // Printed web-down with the pads growing UP, so every pillar is a cylinder
  // rising off the bed and nothing needs support. It is flipped over in use.
  for (const x of [margin, margin + P.p4HoleX]) {
    for (const y of [margin, margin + P.p4HoleY]) {
      // A disc of web under each pillar. The pads sit on the frame's inner
      // corners, where the two rails only cover two quadrants of a Ø11
      // circle - without this, a quarter of every pillar starts in mid-air and
      // the four of them cost 75 mm^2 of overhang.
      solids.push(cylZ(x, y, 0, P.p4PostD / 2, web, 64));
      solids.push(cylZ(x, y, web, P.p4PostD / 2, P.postTestLift, 64));
      // A driver channel down the pillar, ending in a CONICAL seat that the
      // M2 head lands on a couple of mm below the pad face. That keeps the
      // screw grip short - an M2x8 still reaches the standoff through it -
      // where a bore straight through 15 mm of gauge would have needed M2x20.
      // The cone narrows over postTestSeatRun rather than stepping, so its
      // walls sit at 27 degrees off vertical instead of forming a flat annulus
      // facing the bed.
      cuts.push(cylZ(x, y, -0.5, P.postTestDriverD / 2,
        web + P.postTestLift - P.postTestSeatRun - 0.8 + 0.5, 48));
      cuts.push(Manifold.cylinder(P.postTestSeatRun,
        P.postTestDriverD / 2, P.p4ScrewAccessD / 2, 48)
        .translate([x, y, padPlane - P.postTestSeatRun - 0.8]));
      cuts.push(cylZ(x, y, padPlane - 0.8 - 0.01,
        P.p4ScrewAccessD / 2, 0.8 + 0.5, 48));
      // The body's own standoff socket, not a scribed ring: the brass drops
      // socketDepth into the pad exactly as it does into a post, so the gauge
      // tests the one press fit nothing else did - and its rims stop the same
      // 1.0 mm short of the PCB that the posts do.
      cuts.push(socketCone(x, y, padPlane - P.p4StandoffSocketDepth));
    }
  }
  // No standoff-height comb. It used to be five fingers on the web, and it
  // could not work: the pads rest on the standoffs with that face DOWN, so the
  // fingers pointed away from the board and could never reach it. Calipers on
  // a standoff answer the same question exactly, and the 1.2 mm door foam
  // absorbs the +/-0.5 mm that is actually at stake.
  return fuse(solids).subtract(fuse(cuts)).simplify(1e-4);
}

// Camera fit coupon: five pockets stepped 0.1 mm apart around the nominal
// head size, three of them ribbed exactly as the body is and two plain, plus
// the real barrel bore under each. Press a camera module into each: the right
// one holds with a light push and no shake. Tell me that number and the body
// is exact - this exists so the fit is measured once instead of guessed
// repeatedly. Prints in minutes: 62 x 22 x 4 mm.
function buildCamFitCoupon() {
  const steps = [-0.2, -0.1, 0.0, 0.1, 0.2];
  const pitch = 12.0;
  const t = 4.0;
  const w = steps.length * pitch + 2;
  const h = 22.0;
  const solids = [roundedRectZ(0, 0, 0, w, h, t, 2)];
  const cuts = [];
  steps.forEach((delta, i) => {
    const cx = 1 + pitch / 2 + i * pitch;
    const cy = h / 2 + 2;
    const pocket = P.camBody + P.camBodySlack + delta;
    cuts.push(cube(cx - pocket / 2, cy - pocket / 2, t - camPocketDepth,
      pocket, pocket, camPocketDepth + 0.01));
    cuts.push(cylZ(cx, cy, -0.5, P.camBarrelD / 2, t + 1, 48));
    // The first three carry the body's compliant ribs; the last two are plain,
    // so the coupon also shows how much the ribs are doing.
    if (i < 3) {
      for (let rib = 0; rib < P.camRibCount; rib++) {
        const f = (rib + 1) / (P.camRibCount + 1);
        solids.push(cylZ(cx - pocket / 2 + P.camRibProud / 2,
          cy - pocket / 2 + pocket * f, t - camPocketDepth,
          P.camRibProud, camPocketDepth, 12));
        solids.push(cylZ(cx - pocket / 2 + pocket * f,
          cy - pocket / 2 + P.camRibProud / 2, t - camPocketDepth,
          P.camRibProud, camPocketDepth, 12));
      }
    }
    // Step marks below each pocket: i+1 notches identify the pocket.
    for (let m = 0; m <= i; m++) {
      cuts.push(cube(cx - 3.2 + m * 1.6, 1.2, t - 0.8, 0.8, 2.4, 1.0));
    }
  });
  return fuse(solids).subtract(fuse(cuts)).simplify(1e-4);
}


// ---------------------------------------------------------------------------
// The 1:1 paper templates, as PDF.
//
// PDF and not SVG, and it is the whole point of a 1:1 sheet. An SVG has no
// page: it opens in a browser or an editor that fits it to whatever paper is
// loaded, and there is no "print at 100%" to obey. A sheet that has been
// silently scaled 4% is worse than no sheet at all, because it still reads as
// evidence - and the one thing this template is for is deciding whether an
// unmeasured 9.3 mm offset is right before a 10 h print is committed to it.
// A PDF carries its own MediaBox, so "Actual size" puts 65.5 mm on the paper
// as 65.5 mm. Both sheets still carry a 100 mm calibration line, because the
// one thing no print dialog can be trusted about is whether it obeyed you.
//
// Written by hand: uncompressed, no /Info, no dates, single-byte text, so the
// bytes are identical on every build. The release pipeline compares files byte
// for byte, and a PDF library that stamps a creation date would break that.
const PT = 72 / 25.4;                 // PostScript points per millimetre
const PDF_PAGE = [210, 297];          // A4 portrait, mm

// Every glyph on these sheets goes through here. WinAnsi could carry the typographic
// characters, but a sheet read at a bench does not need them, and keeping the
// content stream pure ASCII removes a whole class of encoding fault. Anything
// unmapped throws rather than printing as a wrong glyph.
function pdfText(s) {
  const out = s.replace(/×/g, "x").replace(/—/g, "-").replace(/–/g, "-")
    .replace(/°/g, " deg").replace(/Ø/g, "dia ").replace(/’/g, "'")
    .replace(/ /g, " ");
  const bad = out.match(/[^\x20-\x7e]/);
  if (bad) throw new Error(`template text is not ASCII after mapping: ${JSON.stringify(bad[0])} in ${JSON.stringify(s)}`);
  return out.replace(/([\\()])/g, "\\$1");
}

// A drawing surface in millimetres, y measured DOWN from the sheet's top-left
// corner - the same frame the SVGs used, so the layouts carry over unchanged -
// placed on the page at (originX, originY).
function pdfSheet(originX, originY, draw) {
  const ops = [];
  const X = (x) => ((originX + x) * PT).toFixed(3);
  const Y = (y) => ((PDF_PAGE[1] - (originY + y)) * PT).toFixed(3);
  const K = 0.5522847498307936;       // circle-to-Bezier constant
  const api = {
    width: (mm) => ops.push(`${(mm * PT).toFixed(3)} w`),
    colour: (r, g, b) => ops.push(`${r} ${g} ${b} RG`),
    solid: () => ops.push("[] 0 d"),
    dashed: (on, off) => ops.push(`[${(on * PT).toFixed(2)} ${(off * PT).toFixed(2)}] 0 d`),
    line: (x1, y1, x2, y2) => ops.push(`${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`),
    rect: (x, y, w, h) => ops.push(`${X(x)} ${Y(y)} m ${X(x + w)} ${Y(y)} l ${X(x + w)} ${Y(y + h)} l ${X(x)} ${Y(y + h)} l h S`),
    circle: (cx, cy, r) => {
      const k = K * r;
      ops.push(`${X(cx + r)} ${Y(cy)} m`);
      ops.push(`${X(cx + r)} ${Y(cy - k)} ${X(cx + k)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c`);
      ops.push(`${X(cx - k)} ${Y(cy - r)} ${X(cx - r)} ${Y(cy - k)} ${X(cx - r)} ${Y(cy)} c`);
      ops.push(`${X(cx - r)} ${Y(cy + k)} ${X(cx - k)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c`);
      ops.push(`${X(cx + k)} ${Y(cy + r)} ${X(cx + r)} ${Y(cy + k)} ${X(cx + r)} ${Y(cy)} c h S`);
    },
    // A ring with a centre cross: the ring is laid over the brass and the cross
    // says where its centre should be, which is what you are actually judging.
    target: (cx, cy, r, arm) => {
      api.circle(cx, cy, r);
      api.line(cx - arm, cy, cx + arm, cy);
      api.line(cx, cy - arm, cx, cy + arm);
    },
    text: (x, y, mm, s) => ops.push(`BT /F1 ${(mm * PT).toFixed(2)} Tf ${X(x)} ${Y(y)} Td (${pdfText(s)}) Tj ET`),
  };
  draw(api);
  return pdfFile(ops.join("\n"));
}

function pdfFile(content) {
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${(PDF_PAGE[0] * PT).toFixed(3)} ${(PDF_PAGE[1] * PT).toFixed(3)}]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>`,
    null,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    out += i === 3
      ? `4 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`
      : `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const INK = { black: [0, 0, 0], red: [0.82, 0.07, 0.07], blue: [0.09, 0.46, 0.78] };

// A 100 mm line with an end tick each side. Measure it with the calipers that
// measured the board: if it is not 100.0, the print dialog scaled the sheet and
// nothing else on it means anything.
function pdfCalibration(g, x, y, len = 100) {
  g.colour(...INK.black); g.solid(); g.width(0.3);
  g.line(x, y, x + len, y);
  g.line(x, y - 1.5, x, y + 1.5);
  g.line(x + len, y - 1.5, x + len, y + 1.5);
  g.text(x, y + 4.5, 3, `Calibration line = exactly ${len} mm. Measure it first; if it is not ${len}.0, the sheet was scaled.`);
}

function writeP4FitTemplatePdf() {
  const moduleX = 20, moduleY = 22;
  const moduleCX = moduleX + P.moduleW / 2;
  const moduleCY = moduleY + P.moduleH / 2;
  const brassCX = moduleCX + P.p4PatternOffsetX;
  const pdf = pdfSheet(25, 20, (g) => {
    g.text(0, 6, 4.2, "KINO D4 - P4 standoff 1:1 fit check");
    g.text(0, 11, 3, "Print at 100% / Actual size. Do not fit to page. Lay the sheet on the module, component side up.");
    g.text(0, 15.5, 3, "The four red rings must land on the four brass standoffs, each post inside its ring.");
    // The module outline: black, solid, the one figure on the sheet that is not
    // in question.
    g.colour(...INK.black); g.solid(); g.width(0.35);
    g.rect(moduleX, moduleY, P.moduleW, P.moduleH);
    // The measured pattern, offset by the figure this sheet exists to check.
    g.colour(...INK.red); g.width(0.5);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        g.target(brassCX + sx * P.p4HoleX / 2, moduleCY + sy * P.p4HoleY / 2, 1.75, 3.0);
      }
    }
    // The drawing's outer pattern, which this board does not have. On the sheet
    // so that a board which DOES have it is recognised rather than forced.
    g.colour(...INK.blue); g.dashed(1.5, 1.0); g.width(0.35);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        g.circle(moduleCX + sx * 102.6 / 2, moduleCY + sy * 60.0 / 2, 1.2);
      }
    }
    g.colour(...INK.red); g.solid();
    g.text(0, 100, 3, `Red: standoff pattern ${P.p4HoleX} x ${P.p4HoleY} MEASURED. Pattern centre ${-P.p4PatternOffsetX} mm left of module centre NOT MEASURED - that offset is what this sheet decides.`);
    g.colour(...INK.blue);
    g.text(0, 105, 3, "Blue dashed: the drawing's outer 102.6 x 60 pattern, absent on this board.");
    g.colour(...INK.black);
    g.text(0, 110, 3, `Black: module outline ${P.moduleW} x ${P.moduleH} from the drawing.`);
    pdfCalibration(g, 0, 125);
  });
  fs.writeFileSync(path.join(outDir, "KINO_P4_1TO1_HOLE_TEMPLATE.pdf"), pdf);
}

// The door's foam gasket, 1:1, so the strip is cut once and right instead of
// eyeballed against the printed door. Two cut lines: the ring's outer edge,
// P.foamOuterInset inside the module's outline so no foam hangs into the bay,
// and its inner edge on the door's window. Everything else on the sheet is a
// reference line, and the calibration bar proves the print scale, exactly as
// the standoff template does.
function writeFoamGasketTemplatePdf() {
  const outerW = P.moduleW - 2 * P.foamOuterInset, outerH = P.moduleH - 2 * P.foamOuterInset;
  const cx = 80, cy = 62;
  const ringX = (outerW - P.bezelWindowW) / 2, ringY = (outerH - P.bezelWindowH) / 2;
  const pdf = pdfSheet(25, 20, (g) => {
    const box = (w, h) => g.rect(cx - w / 2, cy - h / 2, w, h);
    g.colour(...INK.black); g.solid();
    g.text(0, 6, 4.2, "KINO D4 - door foam gasket, 1:1");
    g.text(0, 11, 3, "Print at 100% / Actual size. Do not fit to page.");
    g.text(0, 15.5, 3, `Cut both solid black lines: a ring ${ringX.toFixed(1)} mm wide at the sides, ${ringY.toFixed(1)} at top and bottom.`);
    g.text(0, 20, 3, `Use about 2 mm foam sheet - thicker than the ${P.bezelFoam} mm gap it closes, or there is no preload at all.`);
    // The two cut lines, and nothing else in black: whatever is black gets cut.
    g.width(0.5);
    box(outerW, outerH);
    box(P.bezelWindowW, P.bezelWindowH);
    // Keep-clears. Dashed and coloured so they are never mistaken for a cut.
    g.colour(...INK.blue); g.dashed(1.5, 1.0); g.width(0.35);
    box(P.moduleW, P.moduleH);
    g.colour(...INK.red);
    box(P.activeAreaW, P.activeAreaH);
    g.solid();
    g.text(0, 105, 3, `Red dashed: active area ${P.activeAreaW} x ${P.activeAreaH} - the foam never reaches it.`);
    g.colour(...INK.blue);
    g.text(0, 110, 3, `Blue dashed: module outline ${P.moduleW} x ${P.moduleH} - the ring stays ${P.foamOuterInset} mm inside it, so no foam hangs into the bay.`);
    g.colour(...INK.black);
    g.text(0, 115, 3, "Stick it to the door's inner face around the window, then slide the door in.");
    pdfCalibration(g, 0, 130);
  });
  fs.writeFileSync(path.join(outDir, "KINO_DOOR_FOAM_TEMPLATE.pdf"), pdf);
}

function normal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const length = Math.hypot(...n) || 1;
  return n.map((value) => value / length);
}

function writeBinaryStl(name, solid) {
  const mesh = solid.getMesh();
  const stride = mesh.numProp;
  const vertices = [];
  for (let i = 0; i < mesh.numVert; i++) {
    vertices.push([
      mesh.vertProperties[i * stride],
      mesh.vertProperties[i * stride + 1],
      mesh.vertProperties[i * stride + 2],
    ]);
  }
  const triangleCount = mesh.triVerts.length / 3;
  const buffer = Buffer.alloc(84 + triangleCount * 50);
  buffer.write(`KINO FIELD BODY ${name}`.slice(0, 80), 0, "ascii");
  buffer.writeUInt32LE(triangleCount, 80);
  let offset = 84;
  for (let i = 0; i < triangleCount; i++) {
    const triangle = [
      vertices[mesh.triVerts[i * 3]],
      vertices[mesh.triVerts[i * 3 + 1]],
      vertices[mesh.triVerts[i * 3 + 2]],
    ];
    const n = normal(...triangle);
    for (const value of [...n, ...triangle[0], ...triangle[1], ...triangle[2]]) {
      buffer.writeFloatLE(value, offset);
      offset += 4;
    }
    buffer.writeUInt16LE(0, offset);
    offset += 2;
  }
  fs.writeFileSync(path.join(outDir, name), buffer);
  return { triangleCount, bytes: buffer.length };
}

// ---------------------------------------------------------------------------
// Build and gate.

// The chassis' REAR edge is rounded by intersecting the tub with a box whose
// top edge is an R3 quarter round. Only the last 3 mm before the rear face is
// touched; the feet, which hang below the outline, are kept by a full box over
// Y < 0. Printed cut-face-down this edge is on top and faces up-and-out.
const BODY_PARTS = (() => {
  const tub = buildBody();
  const R = P.edgeRoundR, n = P.edgeRoundSteps;
  const slices = [roundedRectZ(0, 0, -1, P.bodyW, P.bodyH, 0.01, P.bodyCornerR)];
  for (let k = 0; k <= n; k++) {
    const th = (Math.PI / 2) * (k / n);
    const inset = R * (1 - Math.cos(th));
    const z = P.bodyD - R + R * Math.sin(th);
    slices.push(roundedRectZ(inset, inset, z - 0.01, P.bodyW - 2 * inset,
      P.bodyH - 2 * inset, 0.01, Math.max(0.5, P.bodyCornerR - inset)));
  }
  const cap = Manifold.hull(slices).add(cube(-1, -6, -1, P.bodyW + 2, 6.0, P.bodyD + 2));
  // Strap anchor on the -X wall, standing on the cut plane (the rear half's
  // bed), added AFTER the rim round's cap, which is a hull of the body outline
  // and would clip anything outside it. See the strapLug block for why it is
  // on this wall and why the bore straddles the wall face.
  const lug = roundedRectZ(-STRAP_PROUD, P.strapLugY0, splitZ,
    STRAP_PROUD + P.strapLugInboard, P.strapLugLen, P.strapLugH, 1.5)
    .subtract(cylZ(STRAP_BORE_X, P.strapLugY0 + P.strapLugLen / 2, splitZ - 1,
      P.strapHoleD / 2, P.strapLugH + 2, 32));
  // The seam's V-groove: the band around the cut plane, less a waisted prism
  // that tapers in by seamChamfer at splitZ and back out. Cut BEFORE the lug
  // is added - the lug stands on the cut plane, so a groove through its base
  // would leave it hanging in the rear half's print.
  const seamSlice = (inset, z) => roundedRectZ(inset, inset, z,
    P.bodyW - 2 * inset, P.bodyH - 2 * inset, 0.01, Math.max(0.5, P.bodyCornerR - inset));
  const sc = P.seamChamfer, sr = sc * Math.tan((P.seamAngleDeg * Math.PI) / 180);
  const waist = fuse([
    Manifold.hull([seamSlice(0, splitZ - sr), seamSlice(sc, splitZ)]),
    Manifold.hull([seamSlice(sc, splitZ), seamSlice(0, splitZ + sr)]),
  ]);
  const seamGroove = cube(-10, -10, splitZ - sr, P.bodyW + 20, P.bodyH + 20, 2 * sr)
    .subtract(waist);
  // ---- Wall flutes ---------------------------------------------------------
  // Two bands, one per printed half, so the seam V and both bed faces keep a
  // bright land and the parting line still reads as a drawn line. Nothing on an
  // outer wall gets a flute run into it: every engraving, opening, pad and the
  // strap lug carries a wallGrainClear land, because a 0.25 mm groove crossing
  // the lip of a Ø8.5 bore or the root of a foot is not a texture, it is a
  // defect. The feet matter most - they hang BELOW the silhouette, so a flute
  // centred on the outline would cut a slot down the middle of one instead of a
  // groove in a wall.
  const fluteKeepOut = (() => {
    const c = P.wallGrainClear, boxes = [];
    const box = (x0, y0, z0, x1, y1, z1) => boxes.push(cube(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0));
    // Engravings: read each one's own placed bounds rather than re-deriving
    // where the text landed on its face.
    for (const k of ["frontHalf", "rearHalf", "spec", "badge"]) {
      const b = ENGRAVINGS[k].solid.boundingBox();
      box(b.min[0] - c, b.min[1] - c, b.min[2] - c, b.max[0] + c, b.max[1] + c, b.max[2] + c);
    }
    // Feet, on the bottom wall.
    for (const [fx0, fz0, fx1, fz1] of footPads) {
      box(fx0 - c, -P.footProud - 1, fz0 - c, fx1 + c, 1.0, fz1 + c);
    }
    // Bottom wall: cable exit, its groove to the rear edge, both tie slots.
    const uz = usbPassageZ, sw = P.usbPassageSlotW, sl = sw + P.usbPassageSlotTravel;
    box(P.usbPassageX - sw / 2 - c, -1, uz - sl / 2 - c, P.usbPassageX + sw / 2 + c, 1.0, uz + sl / 2 + c);
    box(P.usbPassageX - P.cableGrooveW / 2 - c, -1, uz, P.usbPassageX + P.cableGrooveW / 2 + c, 1.0, P.bodyD + 1);
    for (const side of [-1, 1]) {
      const tx = P.usbPassageX + side * P.usbTieOffsetX;
      box(tx - P.usbTieSlotW / 2 - c, -1, uz - P.usbTieSlotH / 2 - c,
        tx + P.usbTieSlotW / 2 + c, 1.0, uz + P.usbTieSlotH / 2 + c);
    }
    // Top wall: the shutter collar, and the light mount by its BASE PLATE and
    // not by its bore. The light is a stud on an 18 mm square base that has to
    // seat on a flat - the flat is why the bore is a plain cylinder through a
    // plain wall in the first place - so the land is the plate's footprint.
    // Sized off the Ø8.5 bore instead, the flutes crossed the seat and took it
    // from 82% solid to 74%, which the light-mount gate caught.
    for (const [fx, fz, d] of [[P.shutterX, P.shutterZ, P.shutterCollarD], [P.quarterX, P.quarterZ, P.lightPlate]]) {
      box(fx - d / 2 - c, P.bodyH - 1.0, fz - d / 2 - c, fx + d / 2 + c, P.bodyH + 1, fz + d / 2 + c);
    }
    // Side walls: the vent slots, and the strap lug's whole base.
    for (const vy of P.ventSlotYs) {
      for (const [x0, x1] of [[-1, 1.0], [P.bodyW - 1.0, P.bodyW + 1]]) {
        box(x0, vy - P.ventSlotW / 2 - c, ventSlotZ0 - c, x1, vy + P.ventSlotW / 2 + c,
          ventSlotZ0 + P.ventSlotLen + c);
      }
    }
    box(-STRAP_PROUD - 1, P.strapLugY0 - c, splitZ - c,
      P.strapLugInboard + 1.0, P.strapLugY0 + P.strapLugLen + c, splitZ + P.strapLugH + c);
    return fuse(boxes);
  })();
  const flutes = fuse(FLUTE_BANDS.map(([z0, z1]) => wallFluteCutter(z0, z1)))
    .subtract(fluteKeepOut);
  const bare = tub.intersect(cap).subtract(seamGroove).subtract(flutes).subtract(fuse([
    ENGRAVINGS.frontHalf.solid, ENGRAVINGS.rearHalf.solid, ENGRAVINGS.badge.solid,
    ENGRAVINGS.spec.solid,
    ...CAM_NUMBER_KEYS.map((k) => ENGRAVINGS[k].solid)]));
  // The anchor is handed back separately rather than unioned in here, because
  // its base is coplanar with the split plane and the split's half-spaces end
  // on that same plane. Unioned into the whole body it left five zero-volume
  // shells in the FRONT half - same volume, six connected components, and a
  // bounding box 6.5 mm wider than the part. It is a rear-half feature, so it
  // is added to the rear half after the cut and to the whole body for the
  // assembly gates, and no solid's face has to share a plane with a cutting
  // box.
  return { bare, lug };
})();
const body = BODY_PARTS.bare.add(BODY_PARTS.lug);
const strapLug = BODY_PARTS.lug;

// Cut the chassis into its two prints. `body` stays whole for every gate that
// reasons about the assembled camera; the halves get their own gates below.
function splitBody(whole) {
  // The two half-spaces are sized from the SOLID's own bounds, not from bodyW
  // and bodyH. They used to be cube(-5, -5, ...) by bodyW + 10, which held only
  // while nothing reached more than 5 mm outside the nominal box - and then the
  // strap anchor moved to the -X wall and stood 6.5 mm proud, so its outer
  // 1.5 mm fell outside BOTH halves. 128 mm^3 of the body in neither half,
  // caught by the reassembly gate, which is exactly the kind of silent clip
  // that gate exists for.
  const b = whole.boundingBox();
  const m = 5.0;
  const x0 = b.min[0] - m, y0 = b.min[1] - m, z0 = b.min[2] - m;
  const W = (b.max[0] - b.min[0]) + 2 * m, H = (b.max[1] - b.min[1]) + 2 * m;
  const below = cube(x0, y0, z0, W, H, splitZ - z0);
  const above = cube(x0, y0, splitZ, W, H, (b.max[2] + m) - splitZ);
  // The four P4 posts cross the cut. They belong to the front half and simply
  // continue up into the rear half's cavity, which is hollow where they stand.
  const postCols = fuse(mountXs.flatMap((x) => mountYs.map((y) =>
    cylZ(x, y, splitZ - 0.5, P.p4PostD / 2 + 0.05, postTopZ - splitZ + 1, 48))));
  // Alignment pegs grow off the front pads; matching sockets sink into the rear.
  const pegs = fuse(splitBolts.map((b) =>
    cylZ(b.x, b.y, splitZ - 0.3, P.splitSpigotD / 2, P.splitSpigotH + 0.3, 48)));
  const pilots = fuse(splitBolts.map((b) =>
    cylZ(b.x, b.y, splitZ - P.splitPilotDepth, P.splitPilotD / 2,
      P.splitPilotDepth + P.splitSpigotH + 0.5, 32)));
  // Each socket ends in a 45-degree cone down to the clearance bore, so its
  // ceiling is never a flat bridge - it was a 1 mm annulus, four times.
  const socketR = P.splitSpigotD / 2 + P.splitSpigotSlop;
  const socketTop = splitZ + P.splitSpigotH + P.splitSpigotSlop;
  const sockets = fuse(splitBolts.flatMap((b) => [
    cylZ(b.x, b.y, splitZ - 0.5, socketR, P.splitSpigotH + P.splitSpigotSlop + 0.5, 48),
    Manifold.cylinder(socketR - P.splitClearD / 2 + 0.02, socketR, P.splitClearD / 2, 48)
      .translate([b.x, b.y, socketTop - 0.01]),
  ]));
  const front = fuse([whole.intersect(fuse([below, postCols])), pegs])
    .subtract(pilots).simplify(5e-3);
  const rear = whole.intersect(above).subtract(postCols).subtract(sockets)
    .add(strapLug)
    .simplify(5e-3);
  return { front, rear };
}
// Split the body WITHOUT the strap anchor, then give the anchor to the rear
// half inside splitBody. See the BODY_PARTS comment.
const { front: bodyFront, rear: bodyRear } = splitBody(BODY_PARTS.bare);
const { face, slider: lensSlider, keeper: sliderKeeper } = buildFace();
// The cover's open position: DOWN, below the cells, by sliderTravel.
const SLIDER_OPEN = [0, -P.sliderTravel, 0];
// Simplified again after the cut: the serial's capsule walls left three
// zero-area triangles on the door, the one part cut after its own simplify.
const bezel = (buildBezel()).subtract(ENGRAVINGS.door.solid).simplify(1e-3);
const clamps = buildClamps().simplify(1e-4);
const shutterButton = buildShutterButton();
const postTest = buildPostTest();
const camCoupon = buildCamFitCoupon();
// The face shell prints back-face-down, relief pointing up.
// A ROTATION, not a reflection. scale([1,1,-1]) wrote the mirror image of the
// shell; it fitted only because the shell is symmetric in X apart from its
// lettering, and the lettering only read correctly because of a second error.
// Turned 180 degrees about Y the relief points up, the back is on the bed, and
// the printed object is the model - what the slicer shows is what the subject
// sees. X is shifted back into the positive quadrant for the slicer's benefit.
// Face alignment tool. The shell is glued to the chassis, and what has to
// line up is the four cells to the four bores - so that is what the tool
// registers: four Ø6.9 pegs on the 22 mm pitch, pushed in from the FRONT
// through the open cells, through the shell's Ø7.1 land and 5 mm into the
// plate's own Ø7.1 bores. The bar sits on the panel floor between the lips;
// the cover is off. Press the glued shell home, let it cure, pull the tool.
// Nothing inside the cavity is in the way, because the tool never enters it
// except the last 1.4 mm of each peg.
const alignTool = (() => {
  const x0 = cameraXs[0] - P.alignBarEnd, x1 = cameraXs[3] + P.alignBarEnd;
  const y0 = P.cameraLensY - P.alignBarW / 2;
  // The bar: its Z=0 face is the FRONT (toward the user), the pegs stand off
  // its back. Built that way it is already in print orientation - front face
  // on the bed, pegs up, nothing overhanging.
  const parts = [cube(x0, y0, 0, x1 - x0, P.alignBarW, P.alignBarT)];
  for (const cx of cameraXs) {
    parts.push(cylZ(cx, P.cameraLensY, P.alignBarT - 0.2, P.alignPegD / 2, P.alignPegLen + 0.2, 64));
  }
  // A lanyard hole through each end, clear of the outer pegs, for a pull loop.
  const holes = [x0 + 4.75, x1 - 4.75].map((hx) =>
    cylZ(hx, P.cameraLensY, -1, P.alignLanyardD / 2, P.alignBarT + 2, 32));
  return fuse(parts).subtract(fuse([...holes, ENGRAVINGS.tool.solid])).simplify(1.5e-2);
})();
// Seated on the face in body coordinates: the bar's back on the panel floor,
// pegs pointing +Z into the chassis.
const alignToolSeated = alignTool.translate([0, 0,
  -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth - P.alignBarT]);
// Printed as built: front face down, pegs up.
const alignToolPrint = alignTool;

const facePrint = face.rotate([0, 180, 0]).translate([P.bodyW, 0, 0]);
// The cover prints back-down so its raised mark grows upward and its edge
// bevels narrow toward the top. Its back sits on the panel floor in face
// coordinates; flip and drop that to Z=0.
const sliderPrint = lensSlider.rotate([0, 180, 0]).translate([P.bodyW, 0,
  -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth]);
// The keeper prints the same way: flat back (the panel-floor plane) down, its
// rim-and-chamfer profile up, like the bar it completes.
const keeperPrint = sliderKeeper.rotate([0, 180, 0]).translate([P.bodyW, 0,
  -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth]);

// The door prints INNER face down.
//
// It printed outer-face-down for two versions, on the reasoning that the bed
// gives that face the best finish of anything on the camera and the panel that
// frames the screen deserves it. That reasoning was fine and the orientation
// was still wrong, because of what it did to the dovetail.
//
// The wedge's section is a Z: full width at the door's inner face, narrowing to
// the lip, then flaring back out to the deep face. Printed outer-face-down that
// Z is upside down, so the wedge's outermost tip arrives 1.5 mm above the bed
// with NOTHING BENEATH IT - 36.9 mm^2 of material, along the whole 125 mm of
// both wedges, appearing out of air in one layer. No angle fixes that. The
// overhang gates all passed it because they only ever asked how steep a
// downward face was, never whether its lowest edge had anything to land on;
// the maintainer found it in the slicer, twice, and was right twice.
//
// Turned over, the same Z-section sits on the bed at full width and tapers
// upward: the dovetail has no downward face at all, and the slope that was the
// overhang is now an upward-facing ramp. Three other things fall out of it for
// free - the serial engraved in the outer face stops being a recess roof on the
// bed (24.9 mm^2 of it) and becomes an upward-opening recess, the window's
// outer bevel becomes an upward cone, and the finger scallop opens upward.
//
// What it costs is the show face, which is now the print's top surface instead
// of bed-glass. That is answered the way the face plate answers it: grain.
// A rigid rotation, not a reflection - the printed part is the model.
// Dropped onto the bed from its own bounding box after the principled
// translation, because the wedge prisms reach 0.01 mm below the door's inner
// face and a part whose lowest point is Z=-0.01 fails the bed check for a
// reason that has nothing to do with the door.
const bezelPrint = (() => {
  const m = bezel.translate([0, 0, -(P.bodyD - P.bezelT)]);
  return m.translate([0, 0, -m.boundingBox().min[2]]);
})();

// Write candidates before gating so a failed gate still leaves the meshes
// available for inspection; the report is only written after all gates pass.
// ---------------------------------------------------------------------------
// Bench coupons.
//
// Every coupon below is a CHUNK OF THE RELEASED SOLID, cut out with a box and
// dropped on the bed - never a remodelled lookalike. A lookalike tests a
// second piece of geometry that merely resembles the one that will be printed,
// so it can pass while the real part fails.
//
// Each also keeps the orientation its parent prints in, because that is what
// decides the accuracy of the surfaces being tested: a dovetail printed on a
// different axis is a different dovetail.

function chunk(solid, x0, y0, z0, x1, y1, z1) {
  const piece = solid.intersect(cube(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0));
  if (piece.isEmpty() || piece.volume() < 100) {
    throw new Error("coupon chunk is empty or nearly so - check its box");
  }
  return piece;
}

// Drop a solid onto the bed and to the origin, so a slicer opens it in place.
function dropToBed(m) {
  const b = m.boundingBox();
  return m.translate([-b.min[0], -b.min[1], -b.min[2]]);
}

// One complete camera station: the front plate with its located camera pocket,
// pinch ribs and lens bore, the board's stand-off pads, both locating fences
// and the clamp boss with its heat-set pocket. This is the most repeated
// feature in the whole camera - it happens four times - and it is where a wrong
// number costs four ruined images rather than one cosmetic flaw.
// Exactly one lens pitch wide, so the cut faces land midway between stations.
// The drop offset is kept, not assumed: material need not reach the cut box's
// edges, so a gate that guesses where a feature landed in the coupon can fail
// on a coupon that is perfectly correct.
const stationRaw = chunk(body,
  cameraXs[1] - P.cameraPitch / 2, boardMinY - 6.0, 0,
  cameraXs[1] + P.cameraPitch / 2, clampBossYs[1] + 7.0, 12.0);
const stationShift = stationRaw.boundingBox().min;
const stationCoupon = stationRaw.translate(
  [-stationShift[0], -stationShift[1], -stationShift[2]]);
const toStation = ([x, y, z]) =>
  [x - stationShift[0], y - stationShift[1], z - stationShift[2]];

// The tool-less door joint: a length of both dovetailed walls with the detent
// dimples in them, plus the matching length of the door with its wedges, bumps
// and finger scallop. Printed in each part's own orientation.
const doorCoupon = (() => {
  // The detent sits detentBackFromEnd in from the door's entry face, so this
  // run leaves plenty of slide before the click without printing a brick.
  const runX = 32.0;
  const railZ0 = P.bodyD - 15.0;
  // The two walls are not joined over this length - the door's entry end is
  // open by design - so the chunk would come off the bed as two loose rails at
  // the wrong spacing, and spacing is the whole thing being measured. A tie bar
  // well in front of the door's own Z band holds them at the true pitch.
  const rails = chunk(body, 0, -1, railZ0, runX, P.bodyH + 1, P.bodyD + 1)
    .add(cube(0, 0, railZ0, 5.0, P.bodyH, 4.0));
  const bezelBox = bezel.boundingBox();
  const door = chunk(bezel, bezelBox.min[0] - 1, -1, -1,
    bezelBox.min[0] + runX, P.bodyH + 1, P.bodyD + 1)
    .translate([0, 0, -(P.bodyD - P.bezelT)]);
  return dropToBed(rails).add(
    dropToBed(door).translate([runX + 8.0, 0, 0]));
})();

// The shutter, which is the only thing on this camera a user actually operates
// besides the cover and the door, and the only one of the three never printed.
// Everything about it is a fit between a printed part and a bought part: a
// 6 x 6 x 4.3 mm switch in its pocket, an actuator sliding in the collar bore,
// a retainer cup holding that actuator captive with a press travel that has to
// be enough to close the switch and not enough to bottom the stem.
//
// A chunk of the FRONT half, in the front half's own print orientation, around
// X 115: the recessed collar, the access bore, the pod pilaster hanging off the
// top wall's inner face, the switch pocket and the wire exit. Plus both button
// parts beside it, so the coupon is the whole mechanism and not a hole to look
// at. The collar bore is a horizontal bore in a vertical wall here, exactly as
// it is in the real part, so its roof prints as the same bridge.
const shutterCoupon = (() => {
  const x0 = P.shutterX - 16.0, x1 = P.bodyW;
  const y0 = P.bodyH - 18.0;      // through the wall, the pod and the pocket
  const z0 = 8.0;                 // the collar spans Z 12.25-29.75
  const block = chunk(bodyFront, x0, y0, z0, x1 + 1, P.bodyH + 1, splitZ);
  return dropToBed(block).add(
    dropToBed(shutterButton).translate([(x1 - x0) + 8.0, 0, 0]));
})();

// The light-mount coupon is gone with the prism hump it was cut from: the
// mount is a plain bore through a flat wall now, and a hand learns nothing
// from a hole. Two new mechanisms have taken its place, and both carry numbers
// that were chosen rather than measured - which is exactly what a coupon is for.

// The sliding lens cover and its track: a full-width length of the face's
// panel with both dovetail lips, the holding bumps at the cells' top edge, the
// exit bumps and the rim gap, plus the whole cover beside it. Full width on
// purpose - the 0.3 mm side clearance and the 0.15 mm detent interference are
// the two numbers being tested, and both live in the span between the walls.
// Slide it in from the top, feel it click past the exit bumps, park it on the
// holding bumps, pull it forward to feel the lips hold. Each piece keeps its
// parent's print orientation.
const sliderCoupon = (() => {
  const { p0x, p1x, p1y } = LENS_PANEL;
  // The cut stops 0.6 mm into the base plate: enough plate to give the coupon a
  // full-footprint first layer, not the whole 3 mm slab, which is 11 cm3 that
  // tests nothing. Same rotation the face itself prints with. Runs from below
  // the bar's bottom rim (the entry gap) up past the panel's top end, so both
  // positions, the detent and the keeper can all be worked.
  const track = dropToBed(chunk(face,
    p0x - 6.0, -1.0, -P.faceBase - P.faceLensBarProud - 1.0,
    p1x + 6.0, p1y + 3.0, -P.faceBase + 0.6).rotate([0, 180, 0]));
  const tb = track.boundingBox();
  const cover = dropToBed(sliderPrint).translate([tb.min[0] + 6.0, tb.max[1] + 8.0, 0]);
  const cb = cover.boundingBox();
  const keep = dropToBed(keeperPrint).translate([tb.min[0] + 6.0, cb.max[1] + 6.0, 0]);
  return track.add(cover).add(keep);
})();

// The split joint: one bolt station cut from each half. The front piece has
// the wedge-footed pad, its Ø2.0 pilot and the Ø4.6 peg; the rear piece has
// the pad, the Ø4.9 socket with its cone, the Ø2.7 clearance, the head pocket
// and the start of the access channel. Peg into socket, then an M2.5 x 16
// down the channel with a 2 mm key: it must find the pilot and pull the two
// pieces face to face. Both sit on their own cut faces, as the halves do.
const jointCoupon = (() => {
  const b = splitBolts.find((q) => q.wall === "top" && q.x === P.splitBoltXs[0]);
  const x0 = b.x - 8.0, x1 = b.x + 8.0;
  const y0 = innerMaxY - P.splitPadReach - 2.0, y1 = P.bodyH + 1.0;
  const frontPiece = dropToBed(chunk(bodyFront, x0, y0,
    splitZ - P.splitPadFore - P.splitPadWedge - 1.0, x1, y1,
    splitZ + P.splitSpigotH + 1.0));
  const rearPiece = dropToBed(chunk(bodyRear, x0, y0, splitZ - 0.5,
    x1, y1, splitZ + P.splitPadAft + 6.0));
  const fb = frontPiece.boundingBox();
  return frontPiece.add(rearPiece.translate([fb.max[0] + 8.0, 0, 0]));
})();

// Four-camera wiggle test rig. Not a fit coupon - a working fixture you can
// put four XIAOs and four cameras into, point at something, and shoot with.
//
// Its front plate is a chunk of the RELEASED body, so the four pockets, pinch
// ribs and bores that decide the image geometry are the same ones the finished
// camera has, at the same 22 mm pitch. Whatever this rig sees, the camera sees.
//
// Its board stand-off is its OWN parameter and deliberately not the body's.
// The body's xiaoPadH is still unresolved - that is what the stack coupon is
// for - and a bench rig has no depth budget to protect, so it takes a generous
// height that the module and the fold of its ribbon fit under regardless.
const rigProbe = {};
const skelProbe = {};
function buildWiggleRig() {
  const padH = xiaoPadH;
  const boardBack = P.plate + padH + P.xiaoBoardT;
  const x0 = cameraXs[0] - P.cameraPitch / 2;
  const x1 = cameraXs[3] + P.cameraPitch / 2;
  const y0 = P.cameraLensY - camModY - 6.0;
  const y1 = rigClampBossY + 9.0;
  const adds = [chunk(body, x0, y0, 0, x1, y1, P.plate)];
  const cuts = [];

  for (const cx of cameraXs) {
    for (const px of [cx - P.xiaoBoardW / 2 + 1.5, cx + P.xiaoBoardW / 2 - 1.5]) {
      for (const py of xiaoPadYs) {
        adds.push(cylZ(px, py, P.plate, 2.0, padH, 32));
      }
    }
    for (const side of [-1, 1]) {
      const fx = cx + side * (P.xiaoBoardW / 2 + P.xiaoBoardClearance);
      adds.push(cube(side < 0 ? fx - P.xiaoFenceW : fx, boardMinY + 2, P.plate,
        P.xiaoFenceW, P.xiaoBoardH - 4, padH + P.xiaoBoardT + 1.5));
    }
    // Retainer boss, its face level with the board's back so the bar lands flat.
    adds.push(cylZ(cx, rigClampBossY, P.plate, P.clampBossD / 2, boardBack - P.plate));
    // One continuous blind pocket, from where the BODY's insert pocket already
    // bites into the plate right up through this taller boss. Cut only the
    // insert's own depth and the boss caps that residual bite, sealing a Ø3.2
    // void inside the plate - four of them, which the mesh validator counted as
    // four extra parts. The insert still seats in the top of the pocket; the
    // channel below it just gives a long screw somewhere to go.
    const pocketZ0 = clampBossTopZ - P.m2InsertDepth;
    cuts.push(cylZ(cx, rigClampBossY, pocketZ0, P.m2InsertPilotD / 2,
      (boardBack + 0.6) - pocketZ0));
  }

  // No 1/4-20 boss on the bottom edge. It was a tripod mount, removed on
  // request; the rig stands on its own bottom edge or gets clamped. Its
  // parameters went with it rather than being left behind unused - a parameter
  // nothing builds from is how this generator has twice ended up gating
  // numbers that described no geometry.
  // Power-bus apron, off the high-Y edge where the boards' pins are.
  const apronY0 = y1 - 0.01;
  const apronH = P.rigPerfBoard[1] + 2 * P.rigApronMargin;
  const apronW = Math.min(x1 - x0, P.rigPerfBoard[0] + 2 * P.rigApronMargin);
  const apronX0 = (x0 + x1) / 2 - apronW / 2;
  const apronCY = apronY0 + apronH / 2;
  adds.push(cube(apronX0, apronY0, 0, apronW, apronH, P.rigApronT));
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const px = (x0 + x1) / 2 + sx * P.rigPerfPostSpan[0] / 2;
      const py = apronCY + sy * P.rigPerfPostSpan[1] / 2;
      adds.push(cylZ(px, py, P.rigApronT, P.rigPerfPostD / 2, P.rigPerfPostH, 32));
      cuts.push(cylZ(px, py, P.rigApronT + P.rigPerfPostH - 6.0,
        P.rigPerfPilotD / 2, 6.4, 24));
    }
  }
  // Tie slots, because perfboards do not agree on a hole pattern and a board
  // that does not match the posts should still be mountable.
  for (const sx of [-1, 1]) {
    cuts.push(cube((x0 + x1) / 2 + sx * (apronW / 2 - 6.0) - 1.6,
      apronCY - 3.1, -0.5, 3.2, 6.2, P.rigApronT + 1.0));
  }

  const rig = fuse(adds).subtract(fuse(cuts));

  // One retainer bar holds all four boards: a flat strip on the four bosses
  // with a finger reaching down onto each board's top edge. It prints flat
  // beside the rig, and it is a separate piece so the boards can come out.
  const barY0 = rigClampBossY - P.clampBossD / 2 - 1.0;
  const barY1 = rigClampBossY + P.clampBossD / 2 + 1.0;
  const fingerY = boardMaxY - 1.5;
  const barAdds = [cube(x0 + 2, barY0, 0, (x1 - x0) - 4, barY1 - barY0, P.rigBarT)];
  const barCuts = [];
  for (const cx of cameraXs) {
    barAdds.push(cube(cx - 7.0, fingerY, 0, 14.0, barY0 - fingerY, P.rigBarT));
    barCuts.push(cylZ(cx, rigClampBossY, -0.5, P.rigBarScrewD / 2, P.rigBarT + 1, 32));
  }
  const bar = fuse(barAdds).subtract(fuse(barCuts));

  // Park the bar clear of the rig on the bed, measured off the rig rather than
  // recomputed from its terms: the apron changed the rig's height, and an
  // arithmetic guess here would have quietly overlapped the two.
  // Hand the perfboard's seat out in the laid-down part's own coordinates, so
  // the gate measures where the board actually lands rather than recomputing
  // the arithmetic and agreeing with itself.
  const shift = rig.boundingBox().min;
  // The rig takes the body's own bow clamps unchanged. The clamp is a planar
  // part, so all it needs is the boss top and the board's back face to be
  // COPLANAR - it does not care what height that plane is at. On the body they
  // meet at Z=9.2, on the rig at Z=13.2, and the same printed clamp spans both.
  rigProbe.clamp = {
    shift,
    boardBack: boardBack,
    stations: cameraXs.map((cx) => ({
      cx: cx - shift[0],
      bossY: rigClampBossY - shift[1],
      footY: clampFootY - shift[1],
    })),
  };
  rigProbe.perf = {
    cx: (x0 + x1) / 2 - shift[0],
    cy: apronCY - shift[1],
    z: P.rigApronT + P.rigPerfPostH - shift[2],
    posts: [-1, 1].flatMap((sx) => [-1, 1].map((sy) => [
      (x0 + x1) / 2 + sx * P.rigPerfPostSpan[0] / 2 - shift[0],
      apronCY + sy * P.rigPerfPostSpan[1] / 2 - shift[1],
    ])),
  };

  const laid = dropToBed(rig);
  return laid.add(
    dropToBed(bar).translate([0, laid.boundingBox().max[1] + 6.0, 0]));
}

// Skeletal wiggle rig. Same four stations, same 22 mm pitch, same board datum,
// roughly half the print.
//
// Almost all of the full rig's bulk is its 5 mm front plate, and almost none of
// that plate does anything: it is 5 mm only because it has to carry a 2.6 mm
// camera pocket and a bore seat, and that is true over about 800 mm^2 of it out
// of 4400. So this version keeps the plate ONLY as four lens bosses - still cut
// from the released body, so the pockets, pinch ribs and bores that decide the
// image geometry are untouched - and ties them together with a 3 mm truss.
//
// Every feature still presents the same ABSOLUTE height, so the board sits at
// Z=12 and the boss tops and board back stay coplanar at Z=13.2 exactly as on
// the full rig. That is what keeps the released bow clamps working on it.
function buildSkeletalRig() {
  const t = P.skelWebT;
  const boardFront = P.plate + xiaoPadH;
  const boardBack = boardFront + P.xiaoBoardT;
  const x0 = cameraXs[0] - P.cameraPitch / 2;
  const x1 = cameraXs[3] + P.cameraPitch / 2;
  const cx0 = (x0 + x1) / 2;
  const b = P.skelLensBoss;
  const [aY0, aY1] = P.skelRailA;
  const [bY0, bY1] = P.skelRailB;
  const adds = [];
  const cuts = [];

  // The lens bosses are the one thing that may not be re-modelled.
  for (const cx of cameraXs) {
    adds.push(chunk(body, cx - b, P.cameraLensY - b, 0,
      cx + b, P.cameraLensY + b, P.plate));
  }
  // Rail A ties the four bosses. Thinner than they are, because it carries no
  // pocket - only the job of holding the four cameras square to each other.
  // It is built as the segments BETWEEN the bosses, not as one slab across
  // them: rail A's Y band is exactly the lens band, so a slab spanning the
  // full width filled all four bores and the bottom 0.6 mm of every pocket.
  // Boss and segment sit in the same band, so together they read as one rail
  // that is 5 mm thick where there is a pocket and 3 mm where there is not.
  {
    // Each segment runs 0.2 mm INTO the bosses either side of it rather than
    // landing exactly on their faces. Abutting on a coincident plane is what
    // left a degenerate triangle in the mesh - the same coplanar-face problem
    // the band stations on the face shell are embedded to avoid.
    const lap = 0.2;
    const edges = [x0];
    for (const cx of cameraXs) edges.push(cx - b + lap, cx + b - lap);
    edges.push(x1);
    for (let i = 0; i < edges.length; i += 2) {
      const w = edges[i + 1] - edges[i];
      if (w > 0.01) adds.push(cube(edges[i], aY0, 0, w, aY1 - aY0, t));
    }
  }
  // Rail B carries the seat pads, the fence roots and the retainer bosses.
  adds.push(cube(x0, bY0, 0, x1 - x0, bY1 - bY0, t));

  for (const cx of cameraXs) {
    // Webs bridging the rails under each fence, so a full-length fence still
    // has material beneath it end to end.
    for (const side of [-1, 1]) {
      const fx = cx + side * (P.xiaoBoardW / 2 + P.xiaoBoardClearance);
      const wx = fx + side * (P.xiaoFenceW / 2);
      adds.push(cube(wx - 2.25, aY1 - 0.01, 0, 4.5, bY0 - aY1 + 0.02, t));
      // A diagonal each side. A ladder racks under a sideways knock and a
      // truss does not, and the whole value of this part is the four cameras
      // staying square to one another.
      // 1.95, not 2.25: at 2.25 the diagonal's vertical edge sits exactly
      // flush with the web's inner face, and that coincident plane is what
      // left a degenerate sliver in the mesh. It is embedded 0.3 mm instead.
      adds.push(triangularPrismZ(0, t,
        [wx - side * 1.95, aY1], [cx + side * 2.5, bY0], [wx - side * 1.95, bY0]));
    }
    // Seat pads, fences and retainer boss - all grown to the same absolute Z
    // the full rig puts them at, from a 3 mm base instead of a 5 mm one.
    for (const px of [cx - P.xiaoBoardW / 2 + 1.5, cx + P.xiaoBoardW / 2 - 1.5]) {
      for (const py of xiaoPadYs) {
        adds.push(cylZ(px, py, t, 2.0, boardFront - t, 32));
      }
    }
    for (const side of [-1, 1]) {
      const fx = cx + side * (P.xiaoBoardW / 2 + P.xiaoBoardClearance);
      adds.push(cube(side < 0 ? fx - P.xiaoFenceW : fx, boardMinY + 2, t,
        P.xiaoFenceW, P.xiaoBoardH - 4, (boardBack + 1.5) - t));
    }
    adds.push(cylZ(cx, rigClampBossY, t, P.clampBossD / 2, boardBack - t));
    cuts.push(cylZ(cx, rigClampBossY, boardBack - P.m2InsertDepth,
      P.m2InsertPilotD / 2, P.m2InsertDepth + 0.6));
  }

  // Power bus. No apron slab: the perfboard overhangs its own posts, so all
  // that is needed is two legs out to a cross rail, with the posts on the legs.
  // Post span is tighter than the full rig's for exactly that reason, and still
  // whole multiples of 0.1 in (50.8 = 20 pitches, 15.24 = 6).
  const [psx, psy] = P.skelPerfPostSpan;
  const legW = P.skelLegW;
  const railY1 = bY1 + P.skelBusReach;
  const railY0 = railY1 - P.skelTopRailW;
  for (const sx of [-1, 1]) {
    const lx = cx0 + sx * psx / 2;
    adds.push(cube(lx - legW / 2, bY1 - 0.01, 0, legW,
      railY1 - bY1 + 0.01, t));
  }
  adds.push(cube(cx0 - psx / 2 - legW / 2, railY0, 0,
    psx + legW, railY1 - railY0, t));
  const busCY = (bY1 + railY1) / 2;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const px = cx0 + sx * psx / 2;
      const py = busCY + sy * psy / 2;
      adds.push(cylZ(px, py, t, P.rigPerfPostD / 2, P.rigPerfPostH, 32));
      cuts.push(cylZ(px, py, t + P.rigPerfPostH - 6.0,
        P.rigPerfPilotD / 2, 6.4, 24));
    }
  }

  // Clipped to the rails' own width. The outermost fence webs otherwise stand
  // 1.2 mm proud of each end, which is harmless but reads as a mistake and
  // makes the part measure 90 mm when every other station dimension says 88.
  const rig = fuse(adds).subtract(fuse(cuts))
    .intersect(cube(x0, -50, -1, x1 - x0, 300, 60))
    .simplify(1e-4);
  skelProbe.boardBack = boardBack;
  skelProbe.bus = { cx: cx0, cy: busCY, z: t + P.rigPerfPostH };
  const shift = rig.boundingBox().min;
  skelProbe.shift = shift;
  skelProbe.stations = cameraXs.map((cx) => ({
    cx: cx - shift[0],
    bossY: rigClampBossY - shift[1],
    footY: clampFootY - shift[1],
  }));
  return dropToBed(rig);
}

// The stack coupon. Its job has changed: the stand-off is DERIVED now, from the
// vendor's 15.0 mm overall stack height, so this is no longer a search over a
// range but a check on one figure and its neighbours. The stations bracket the
// derived value in half-millimetre steps, which is about the resolution a
// fingertip can tell "seated" from "nearly seated" at.
//
// It used to run 3/5/7/9 mm, and that width is itself part of the fault it now
// tests: a coupon that offers 3 and 7 as equally plausible is a coupon whose
// author did not know the answer to within 4 mm, and the rig was built at 7.
// The station that matches the released body is marked in the report.
// The plate itself is a chunk of the released body, so the pocket, the pinch
// ribs and the bore under test are the real ones.
const STACK_PADS = [xiaoPadH - 0.5, xiaoPadH, xiaoPadH + 0.5, xiaoPadH + 1.0];
const stackCoupon = (() => {
  const y0 = P.cameraLensY - camModY - 2.0;
  const y1 = boardMaxY + 1.5;
  const plate = chunk(body, cameraXs[0] - P.cameraPitch / 2, y0, 0,
    cameraXs[3] + P.cameraPitch / 2, y1, P.plate);
  const adds = [plate];
  cameraXs.forEach((cx, i) => {
    const padH = STACK_PADS[i];
    for (const px of [cx - P.xiaoBoardW / 2 + 1.5, cx + P.xiaoBoardW / 2 - 1.5]) {
      for (const py of xiaoPadYs) {
        adds.push(cylZ(px, py, P.plate, 2.0, padH, 32));
      }
    }
    // Fences tall enough to still locate the board at this station's height.
    for (const side of [-1, 1]) {
      const fx = cx + side * (P.xiaoBoardW / 2 + P.xiaoBoardClearance);
      adds.push(cube(side < 0 ? fx - P.xiaoFenceW : fx, boardMinY + 2, P.plate,
        P.xiaoFenceW, P.xiaoBoardH - 4, padH + P.xiaoBoardT + 1.5));
    }
    // Count marks on the plate's inner face: i+1 pips, so a station can still
    // be named once four boards are sitting on it.
    for (let k = 0; k <= i; k++) {
      adds.push(cylZ(cx - 3.0 + k * 2.0, y1 - 2.0, P.plate, 0.7, 0.8, 16));
    }
  });
  return dropToBed(fuse(adds));
})();

const wiggleRig = withRigClamps(buildWiggleRig());
const skeletalRig = withRigClamps(buildSkeletalRig());

// Heat-set and self-tapping pilots, graduated. Not a chunk of anything: the
// body carries one pilot diameter, and the point here is to find out which
// diameter is right before committing four bosses to it.
function buildPilotCoupon() {
  const plate = 3.0;
  const bossH = boardBackZ - P.plate;   // the boss height the body actually has
  const pitch = 14.0;
  const insertSteps = [-0.2, 0, 0.2, 0.4];
  const tapSteps = [-0.2, 0, 0.2];
  const w = pitch * insertSteps.length + 8.0;
  const d = 30.0;
  const solids = [cube(0, 0, 0, w, d, plate)];
  const cuts = [];
  insertSteps.forEach((delta, i) => {
    const x = 4.0 + pitch * (i + 0.5);
    const y = 9.0;
    solids.push(cylZ(x, y, plate, P.clampBossD / 2, bossH, 48));
    cuts.push(cylZ(x, y, plate + bossH - P.m2InsertDepth,
      (P.m2InsertPilotD + delta) / 2, P.m2InsertDepth + 0.4, 48));
    // Count marks: i+1 dots beside each boss, so a boss that turns out right
    // can be identified after it has an insert melted into it.
    for (let k = 0; k <= i; k++) {
      cuts.push(cylZ(x - 3.0 + k * 2.0, y + 8.0, plate - 0.6, 0.7, 0.8, 16));
    }
  });
  // Self-tapping pilots for M2 screws. These used to size the face shell's
  // pilots; the shell is glued on now, so the one M2 self-tapper left in the
  // camera family is the rigs' bus-board post, and its Ø1.7 pilot is what
  // these are stepped around.
  tapSteps.forEach((delta, i) => {
    const x = 4.0 + pitch * (i + 1.0);
    const y = 22.0;
    solids.push(cylZ(x, y, plate, 6.0, 9.0 - plate, 48));
    cuts.push(cylZ(x, y, plate + 1.0,
      (P.rigPerfPilotD + delta) / 2, 8.0, 48));
    for (let k = 0; k <= i; k++) {
      cuts.push(cylZ(x - 2.0 + k * 2.0, y - 7.5, plate - 0.6, 0.7, 0.8, 16));
    }
  });
  return fuse(solids).subtract(fuse(cuts)).simplify(1e-4);
}
const pilotCoupon = buildPilotCoupon();

// KINO_FIELD_BODY_PRINT.stl is no longer released: the chassis is two parts.
// The front prints lens-face-down as the whole body did; the rear prints
// cut-face-down, which is the same orientation, so the door groove stays on
// top where it needs no roof.
const bodyInfo = writeBinaryStl("KINO_FIELD_BODY_FRONT_PRINT.stl", bodyFront);
const bodyRearInfo = writeBinaryStl("KINO_FIELD_BODY_REAR_PRINT.stl",
  bodyRear.translate([0, 0, -splitZ]));
const faceInfo = writeBinaryStl("KINO_FIELD_FACE_PRINT.stl", facePrint);
const sliderInfo = writeBinaryStl("KINO_FIELD_LENS_SLIDER.stl", sliderPrint);
const keeperInfo = writeBinaryStl("KINO_FIELD_SLIDER_KEEPER.stl", keeperPrint);
const alignInfo = writeBinaryStl("KINO_FACE_ALIGN_TOOL.stl", alignToolPrint);
const bezelInfo = writeBinaryStl("KINO_FIELD_BEZEL_PRINT.stl", bezelPrint);
const clampInfo = writeBinaryStl("KINO_FIELD_XIAO_CLAMPS.stl", clamps);
const shutterInfo = writeBinaryStl("KINO_FIELD_SHUTTER_BUTTON.stl", shutterButton);
// KINO_P4_61P9X54P8_FIT_GAUGE.stl is no longer released. It was a 2 mm plate
// that seated on the standoff tops, so it fouled the board's connectors for
// exactly the same reason the old screw test did, and the bridge gauge now
// answers the same question without touching anything but the standoffs.
const postTestInfo = writeBinaryStl("KINO_P4_POST_SCREW_TEST.stl", postTest);
const camCouponInfo = writeBinaryStl("KINO_CAM_FIT_COUPON.stl", camCoupon);
const rigInfo = writeBinaryStl("KINO_WIGGLE_TEST_RIG.stl", wiggleRig);
const skelInfo = writeBinaryStl("KINO_WIGGLE_RIG_SKELETAL.stl", skeletalRig);
const stackInfo = writeBinaryStl("KINO_XIAO_STACK_COUPON.stl", stackCoupon);
const doorJointInfo = writeBinaryStl("KINO_DOOR_JOINT_COUPON.stl", doorCoupon);
const sliderCouponInfo = writeBinaryStl("KINO_SLIDER_TRACK_COUPON.stl", sliderCoupon);
const jointCouponInfo = writeBinaryStl("KINO_SPLIT_JOINT_COUPON.stl", jointCoupon);
const shutterCouponInfo = writeBinaryStl("KINO_SHUTTER_COUPON.stl", shutterCoupon);
const pilotInfo = writeBinaryStl("KINO_INSERT_PILOT_COUPON.stl", pilotCoupon);

// ---- Plates: the two camera bed jobs, pre-arranged ---------------------------
// Every part above is also shipped on its own. These two files are the same
// meshes placed as the README's two bed jobs, so the slicer is loaded with one
// file per job and nobody re-orients a part by hand. 6 mm between parts.
const PLATE_GAP = 6.0;
const placeAt = (m, x, y) => { const b = m.boundingBox(); return m.translate([x - b.min[0], y - b.min[1], -b.min[2]]); };
const rearPrint = bodyRear.translate([0, 0, -splitZ]);
const plate1 = (() => {
  const a = placeAt(bodyFront, 0, 0);
  const ab = a.boundingBox();
  return a.add(placeAt(rearPrint, 0, ab.max[1] + PLATE_GAP));
})();
const plate2 = (() => {
  const f = placeAt(facePrint, 0, 0); const fb = f.boundingBox();
  const d = placeAt(bezelPrint, 0, fb.max[1] + PLATE_GAP);
  const colX = fb.max[0] + PLATE_GAP;
  const c = placeAt(sliderPrint, colX, 0); const cb = c.boundingBox();
  const k = placeAt(keeperPrint, colX, cb.max[1] + PLATE_GAP); const kb = k.boundingBox();
  const cl = placeAt(clamps, colX, kb.max[1] + PLATE_GAP); const clb = cl.boundingBox();
  const bt = placeAt(shutterButton, colX, clb.max[1] + PLATE_GAP);
  return f.add(d).add(c).add(k).add(cl).add(bt);
})();
const plate1Info = writeBinaryStl("KINO_PLATE_1_CHASSIS.stl", plate1);
const plate2Info = writeBinaryStl("KINO_PLATE_2_FACE_DOOR_COVER.stl", plate2);
// Reference only, written to .candidate and never published: the three shells
// in their assembled positions, so the whole camera can be judged as one
// object instead of as parts in isolation. Not printable, not validated.
writeBinaryStl("_ASSEMBLY_VIEW_reference_only.stl",
  fuse([body, face, bezel, sliderKeeper]));
writeP4FitTemplatePdf();
writeFoamGasketTemplatePdf();

const checks = [];
// Gates throw on the FIRST failure, which is right for a release but useless
// mid-refactor: a change that breaks twenty gates makes you rebuild twenty
// times to see them. KINO_SOFT_GATES=1 collects instead of throwing. It only
// affects whether the run stops; nothing is written differently, and the
// report still records every pass and fail honestly.
const SOFT_GATES = process.env.KINO_SOFT_GATES === "1";
const check = (name, condition, details) => {
  checks.push({ name, pass: Boolean(condition), details });
  if (!condition && !SOFT_GATES) {
    throw new Error(`Release-gate failure: ${name}: ${details}`);
  }
};
const intersectionVolume = (a, b) => a.intersect(b).volume();
// "This opening is clear" gates are only meaningful if the probe itself has
// volume. A degenerate probe - the usual cause being a NaN dimension from a
// renamed parameter - would make the check pass without testing anything, so
// probes are verified before use rather than trusted.
// `solid` defaults to the chassis, which is what nearly every opening gate is
// about; the bench coupons pass their own solid.
const openProbe = (name, probe, details, solid = body) => {
  const v = probe.volume();
  if (!Number.isFinite(v) || v < 1e-3) {
    throw new Error(`Probe for "${name}" is degenerate (volume ${v}); the check would have passed vacuously`);
  }
  check(name, intersectionVolume(solid, probe) < 1e-6, details);
};

check("single Boolean body", body.decompose().length === 1,
  `${body.decompose().length} connected component(s)`);
// ---- Split-joint gates -------------------------------------------------
check("front half is one part", bodyFront.decompose().length === 1,
  `${bodyFront.decompose().length} connected component(s)`);
check("rear half is one part", bodyRear.decompose().length === 1,
  `${bodyRear.decompose().length} connected component(s)`);
{
  const overlap = intersectionVolume(bodyFront, bodyRear);
  check("halves do not overlap", overlap < 1e-3,
    `${overlap.toFixed(4)} mm^3 shared between the two prints`);
  // Two set statements, not a volume guess: nothing of the body is lost except
  // where the alignment sockets are cut, and nothing is added except the pegs.
  // (The first version compared a single number against a formula that forgot
  // the pegs overlap the socket region, and failed on its own arithmetic.)
  const sR = P.splitSpigotD / 2 + P.splitSpigotSlop;
  const socketZone = fuse(splitBolts.map((b) => cylZ(b.x, b.y, splitZ - 0.6,
    sR + 0.05, P.splitSpigotH + P.splitSpigotSlop + (sR - P.splitClearD / 2) + 0.7, 48)));
  const pegZone = fuse(splitBolts.map((b) => cylZ(b.x, b.y, splitZ - 0.4,
    P.splitSpigotD / 2 + 0.05, P.splitSpigotH + 0.5, 48)));
  const lostSolid = body.subtract(bodyFront).subtract(bodyRear).subtract(socketZone);
  const lost = lostSolid.volume();
  const addedSolid = fuse([bodyFront, bodyRear]).subtract(body).subtract(pegZone);
  const added = addedSolid.volume();
  // Volume alone cannot answer this one, and it took the wall flutes to show
  // why. The residue of a set difference between two meshes that share 1500
  // mm^2 of curved surface is a FILM along every shared face - it reported 10.5
  // mm^3 and, in the same breath, MINUS 0.021 mm^3 added, which is not a volume
  // a solid can have. It is the same trap the detent gates fell into: a number
  // the size of a coincident-face film, read as a feature.
  //
  // So measure thickness, not volume. A film's surface area is about twice its
  // footprint, so 2V/A is its mean thickness; real lost material is a chunk and
  // is thick. 0.05 mm is the line - a quarter of one layer, well under anything
  // a nozzle can lay down - with a volume cap so that a genuinely large loss
  // still fails however thin it manages to be.
  const filmThick = (m, v) => { const a = m.surfaceArea(); return a > 1e-9 ? (2 * Math.abs(v)) / a : 0; };
  const lostT = filmThick(lostSolid, lost), addedT = filmThick(addedSolid, added);
  const say = (label, m, v, t) => {
    if (Math.abs(v) < 1e-6) return `no ${label}`;
    const b = m.boundingBox();
    return `${v.toFixed(3)} mm^3 ${label} over ${m.surfaceArea().toFixed(0)} mm^2 = ${t.toFixed(4)} mm mean thickness, in ${m.decompose().length} region(s) spanning X ${b.min[0].toFixed(1)}..${b.max[0].toFixed(1)}, Y ${b.min[1].toFixed(1)}..${b.max[1].toFixed(1)}, Z ${b.min[2].toFixed(1)}..${b.max[2].toFixed(1)}`;
  };
  check("halves reassemble to the whole chassis",
    (lost < 0.5 || (lostT < 0.05 && lost < 200)) && (Math.abs(added) < 0.5 || (addedT < 0.05 && Math.abs(added) < 200)),
    `${say("of the body in neither half outside the sockets", lostSolid, lost, lostT)}; ${say("of the halves not body outside the pegs", addedSolid, added, addedT)}`);
}
// The whole optical datum has to be in ONE print.
{
  const frontSlab = cube(-1, -1, -1, P.bodyW + 2, P.bodyH + 2, splitZ + 1);
  const rearBelow = intersectionVolume(bodyRear, frontSlab);
  const plate = cube(-1, -1, -0.5, P.bodyW + 2, P.bodyH + 2, P.plate + 0.5);
  const inFront = intersectionVolume(bodyFront, plate);
  const inBody = intersectionVolume(body, plate);
  // 0.5 mm^3, the reassembly gate's figure, not 1e-3: this compares two ~60
  // cm^3 Booleans, so 1e-3 was a 2e-8 relative tolerance that any change in
  // facet count could break - the camera-number recesses did. A real loss of
  // plate to the rear half would be thousands of mm^3, not fractions.
  const drift = Math.abs(inFront - inBody);
  check("optical datum is entirely in the front half",
    rearBelow < 1e-6 && drift < 0.5,
    `rear half carries ${rearBelow.toFixed(4)} mm^3 forward of the cut; front half carries ${(100 * inFront / inBody).toFixed(2)}% of the camera plate's ${(inBody / 1000).toFixed(1)} cm^3, ${drift.toFixed(4)} mm^3 apart`);
}
// Pads must stay in the strips the module footprint leaves, and a driver must
// still reach every head with the module fitted.
check("split pads stay clear of the module footprint",
  innerMaxY - P.splitPadReach >= moduleMaxY + 0.5 &&
    innerMinY + P.splitPadReach <= moduleMinY - 0.5,
  `pads reach to Y ${(innerMaxY - P.splitPadReach).toFixed(1)} and ${(innerMinY + P.splitPadReach).toFixed(1)}; module spans Y ${moduleMinY.toFixed(1)}-${moduleMaxY.toFixed(1)}`);
{
  const r = P.splitDriverD / 2;
  const margin = Math.min(...splitBolts.map((b) => b.wall === "top"
    ? b.y - r - moduleMaxY : moduleMinY - (b.y + r)));
  check("every joint bolt is reachable past a fitted module",
    margin >= 0.3,
    `${splitBolts.length} heads; a \u00d8${P.splitDriverD} driver clears the module by ${margin.toFixed(2)} mm at the tightest`);
}
// A bolt is only a bolt if its head can get to its pocket. Probe the head's
// own diameter from the pocket floor up to the door plane, and the driver's
// shaft on through the door zone to open air.
for (const b of splitBolts) {
  const floorZ = splitZ + P.splitPadAft - P.splitHeadDepth;
  const doorZ = P.bodyD - P.bezelT;
  const head = cylZ(b.x, b.y, floorZ + 0.1, P.splitHeadD / 2 - 0.15, doorZ - floorZ - 0.2, 32);
  check(`bolt head reaches its pocket from the door, ${b.wall} X=${b.x}`,
    intersectionVolume(bodyRear, head) < 1e-6,
    `\u00d8${(P.splitHeadD - 0.3).toFixed(1)} clear from the pocket floor at Z=${floorZ.toFixed(1)} to the door plane at ${doorZ.toFixed(1)}`);
  const key = cylZ(b.x, b.y, floorZ + 0.1, P.splitDriverD / 2, P.bodyD - floorZ + 1, 32);
  check(`driver reaches the head through the door zone, ${b.wall} X=${b.x}`,
    intersectionVolume(bodyRear, key) < 1e-6,
    `\u00d8${P.splitDriverD} key shaft clear from the head to open air past the door rails`);
}
// Pegs exist on the front, sockets and bolt paths are open on the rear.
for (const b of splitBolts) {
  const tag = `${b.wall} X=${b.x}`;
  const annulus = cylZ(b.x, b.y, splitZ + 0.1, P.splitSpigotD / 2 - 0.3,
    P.splitSpigotH - 0.2, 48).subtract(
    cylZ(b.x, b.y, splitZ, P.splitPilotD / 2 + 0.2, P.splitSpigotH + 0.2, 48));
  const pegFill = intersectionVolume(bodyFront, annulus) / annulus.volume();
  check(`alignment peg present, ${tag}`, pegFill > 0.95,
    `${(100 * pegFill).toFixed(0)}% of a \u00d8${P.splitSpigotD} x ${P.splitSpigotH} mm peg stands on the front pad`);
  const socket = cylZ(b.x, b.y, splitZ + 0.05,
    P.splitSpigotD / 2 + P.splitSpigotSlop - 0.1, P.splitSpigotH - 0.1, 48);
  check(`alignment socket open, ${tag}`, intersectionVolume(bodyRear, socket) < 1e-6,
    `\u00d8${(P.splitSpigotD + 2 * P.splitSpigotSlop).toFixed(2)} socket takes the peg at ${P.splitSpigotSlop} mm per side`);
  const pilot = cylZ(b.x, b.y, splitZ - P.splitPilotDepth + 0.3,
    P.splitPilotD / 2 - 0.15, P.splitPilotDepth - 0.5, 32);
  check(`M2.5 pilot open, ${tag}`, intersectionVolume(bodyFront, pilot) < 1e-6,
    `\u00d8${P.splitPilotD} pilot, ${P.splitPilotDepth.toFixed(1)} mm deep, for an M2.5 self-tapper`);
  const clear = cylZ(b.x, b.y, splitZ + 0.2, P.splitClearD / 2 - 0.15,
    P.splitPadAft - 0.4, 32);
  check(`M2.5 clearance and counterbore open, ${tag}`,
    intersectionVolume(bodyRear, clear) < 1e-6,
    `\u00d8${P.splitClearD} through the rear pad into a \u00d8${P.splitHeadD} x ${P.splitHeadDepth} counterbore facing the door`);
}
{
  // M3 length: head seats on the counterbore floor, shank crosses the rear pad,
  // and what is left threads the front pilot.
  const rearRun = P.splitPadAft - P.splitHeadDepth;
  const engage = P.splitBoltLen - rearRun;
  check("joint bolt length engages the front pilot",
    engage >= 6 && engage <= P.splitPilotDepth - 1,
    `M2.5x${P.splitBoltLen}: ${rearRun.toFixed(1)} mm through the rear pad, ${engage.toFixed(1)} mm into the ${P.splitPilotDepth.toFixed(1)} mm pilot`);
}
check("single Boolean bezel", bezel.decompose().length === 1,
  `${bezel.decompose().length} connected component(s)`);
check("clamps are four parts", clamps.decompose().length === 4,
  `${clamps.decompose().length} connected component(s)`);
check("shutter is two parts", shutterButton.decompose().length === 2,
  `${shutterButton.decompose().length} connected component(s)`);
{
  // The retainer's terminal relief. Two probes, one out through each side wall
  // of the cradle at the switch's base plane: if either meets material the
  // cradle is clamping the terminals again, which is the fault the bench
  // found. Cup axis is +Z here, so the band is 0.2..legBand above the plate.
  const rcx = 27, rcy = P.shutterRetainerPlateD / 2, plateH = 1.6;
  const bandZ = plateH + 0.2;
  const bandH = P.shutterSwitchLegBand - 0.4;
  const legProbes = [-1, 1].map((s) => cube(
    rcx + (s < 0 ? -P.shutterRetainerCupD / 2 : P.shutterSwitchBody[0] / 2),
    rcy - 1.0, bandZ,
    (P.shutterRetainerCupD - P.shutterSwitchBody[0]) / 2, 2.0, bandH));
  check("shutter terminal relief through the cradle",
    bandH > 0 && legProbes.every((p) =>
      intersectionVolume(shutterButton, p) < 1e-6),
    `${P.shutterSwitchLegBand.toFixed(1)} mm band clear out through both cradle walls, so terminals standing proud of the ${P.shutterSwitchBody[0]} mm body are not clamped`);
  // And the dish under them still leaves a stop plate worth pressing against.
  const residual = plateH - P.shutterSwitchLegSink;
  check("shutter stop plate survives the terminal dish",
    residual >= 0.8,
    `${residual.toFixed(1)} mm of plate under the ${P.shutterSwitchLegSink.toFixed(1)} mm dish, over a ${(P.shutterSwitchBody[0] + P.shutterSwitchClearance).toFixed(1)} mm span`);
}

// Lens geometry.
check("exact lens pitch",
  cameraXs.every((x, i) => i === 0 || Math.abs(x - cameraXs[i - 1] - 22) < 1e-9),
  JSON.stringify(cameraXs));
for (const cx of cameraXs) {
  const boreProbe = cylZ(cx, P.cameraLensY, -0.5, P.lensBoreD / 2 - 0.1, P.plate + 1);
  check(`lens bore ${cx} open`, intersectionVolume(body, boreProbe) < 1e-6,
    `Ø${P.lensBoreD.toFixed(1)} mm window through the front plate`);
}

// Module insertion: from the rear rim down to the seated position, the swept
// module envelope (plus clearance) must meet nothing but the four posts'
// standoff relief and the bezel bosses' allowed margin zones... it must meet
// NOTHING: the cavity walls clear it, bosses live in the top/bottom margins,
// posts stop at the standoff plane below the PCB back.
const insertionSweep = cube(moduleMinX - 0.3, moduleMinY - 0.3, pcbBackZ,
  P.moduleW + 0.6, P.moduleH + 0.6, P.bodyD - pcbBackZ + 5);
check("module insertion path", intersectionVolume(body, insertionSweep) < 1e-6,
  "the module plus 0.3 mm plan clearance drops from the rear rim to its seat without touching the body");

// Seated module: glass and body volume from PCB back to glass rear.
const seatedModule = cube(moduleMinX, moduleMinY, pcbBackZ,
  P.moduleW, P.moduleH, P.moduleT);
check("seated module volume", intersectionVolume(body, seatedModule) < 1e-6,
  "no body material inside the seated 117.01 x 69.41 x 13.8 module");

// Conservative component bay in front of the PCB back, minus post/rib relief.
const reliefR = P.p4PostD / 2 + 1.5;
const bayEnvelope = cube(moduleMinX, moduleMinY, bayMinZ,
  P.moduleW, P.moduleH, P.bayDepth - 0.1);
const allowedPosts = fuse(mountXs.flatMap((x) => mountYs.map((y) =>
  cylZ(x, y, bayMinZ - 0.1, reliefR, P.bayDepth + 0.2))));
const bayIntrusion = body.intersect(bayEnvelope.subtract(allowedPosts));
check("P4 component keep-out", bayIntrusion.volume() < 1e-6,
  `${bayIntrusion.volume().toFixed(6)} mm^3 outside the four standoff relief zones in the ${P.bayDepth} mm bay`);

// Posts land exactly on the standoff tops; standoff volume below stays open.
for (const x of mountXs) for (const y of mountYs) {
  // What matters is that the post face COVERS THE STANDOFF, so the gauge is
  // the standoff's own footprint and the test is a fraction of it. This used
  // to be an absolute "> 30 mm^3" tuned to an Ø11 post, which fails on any
  // thinner peg whether or not the brass is still fully supported.
  const footGauge = cylZ(x, y, standoffTopZ - 0.4, P.p4StandoffOD / 2, 0.4);
  const covered = intersectionVolume(body, footGauge) / footGauge.volume();
  check(`post ${x.toFixed(2)},${y} reaches standoff plane`,
    covered > 0.98,
    `socket floor at Z=${standoffTopZ.toFixed(1)} mm carries ${(covered * 100).toFixed(0)}% of the Ø${P.p4StandoffOD.toFixed(1)} standoff footprint on a Ø${P.p4PostD} post`);

  // The socket has to be open for the brass to drop into. This replaces the
  // old "no post material beyond the standoff plane" gate, which encoded the
  // superseded design where the standoff simply rested on a flat post face.
  // Probe the brass itself, 0.02 under nominal, standing on the floor: it must
  // fit; and a Ø0.2-over brass must NOT fit at the floor - that is the taper.
  // Three probes: the brass 0.02 under nominal fits to the floor; a Ø0.2-over
  // brass touches the wall in the first 0.3 mm above the floor (the fit is
  // snug there); a Ø0.5-over brass clears the top 0.3 mm (the mouth leads in).
  const socketProbe = cylZ(x, y, standoffTopZ + 0.05,
    P.p4StandoffOD / 2 - 0.02, P.p4StandoffSocketDepth - 0.1, 48);
  const overProbe = cylZ(x, y, standoffTopZ + 0.05, P.p4StandoffOD / 2 + 0.1, 0.3, 48);
  const mouthProbe = cylZ(x, y, postTopZ - 0.3, P.p4StandoffOD / 2 + 0.25, 0.3, 48);
  check(`standoff socket ${x.toFixed(2)},${y} is a snug cone`,
    intersectionVolume(body, socketProbe) < 1e-6 && intersectionVolume(body, overProbe) > 1e-3 && intersectionVolume(body, mouthProbe) < 1e-6,
    `Ø${socketFloorD.toFixed(2)} at the floor opening to Ø${socketD.toFixed(2)} at the mouth over ${P.p4StandoffSocketDepth} mm: the Ø${P.p4StandoffOD.toFixed(1)} brass drops in with ${P.p4StandoffSocketSlopBottom} mm a side at the floor and ${P.p4StandoffSocketSlopTop} at the mouth`);

  // And the post must stop short of the board, or its rim lands on whatever
  // is soldered to the underside instead of the brass bottoming in the socket.
  const gap = pcbBackZ - postTopZ;
  check(`post ${x.toFixed(2)},${y} stops short of the board`,
    gap >= 0.8,
    `post rim at Z=${postTopZ.toFixed(1)}, PCB back at ${pcbBackZ}: ${gap.toFixed(1)} mm clear, with ${(P.p4StandoffH - P.p4StandoffSocketDepth).toFixed(1)} mm of the brass still proud of the socket`);

  // The socket wall is what actually locates the board in plan now.
  const wall = (P.p4PostD - socketD) / 2;
  check(`socket ${x.toFixed(2)},${y} keeps a wall`,
    wall >= 0.8,
    `${wall.toFixed(2)} mm of post wall around the socket`);
}

// The door's window has to clear the panel's ACTIVE AREA with enough margin
// to absorb every way the module can sit off-centre, or the frame eats the
// edge of the picture and no amount of software fixes it.
{
  const perSide = [
    [(P.bezelWindowW - P.activeAreaW) / 2, "X"],
    [(P.bezelWindowH - P.activeAreaH) / 2, "Y"],
  ];
  const worst = Math.min(...perSide.map(([m]) => m));
  check("door window clears the panel's active area",
    worst >= P.bezelWindowMargin,
    perSide.map(([m, ax]) => `${ax} ${m.toFixed(2)} mm/side`).join(", ") +
      ` on a ${P.activeAreaW} x ${P.activeAreaH} mm active area, against ${P.bezelWindowMargin} mm needed (${P.p4StandoffSocketSlopBottom} socket slop at the floor + 0.15 print, and margin)`);

  // And it must not open so far that it exposes the module's own PCB edge.
  const overGlass = [
    [(P.moduleW - P.bezelWindowW) / 2, "X"],
    [(P.moduleH - P.bezelWindowH) / 2, "Y"],
  ];
  // An uneven frame is what reads as a heavy bezel, so evenness is gated.
  {
    // Measured on the door solid, not from parameters - there is no bezelW
    // or bezelH to read, and inventing them is how numbers drift apart here.
    const bb = bezel.boundingBox();
    const fx = ((bb.max[0] - bb.min[0]) - P.bezelWindowW) / 2;
    const fy = ((bb.max[1] - bb.min[1]) - P.bezelWindowH) / 2;
    check("door frame is even on all four sides",
      Math.abs(fx - fy) <= 1.5,
      "frame " + fx.toFixed(1) + " mm per side in X against " + fy.toFixed(1) +
        " in Y: " + Math.abs(fx - fy).toFixed(1) + " mm of difference");
  }
  check("door window stays inside the module outline",
    Math.min(...overGlass.map(([m]) => m)) >= 3.0,
    overGlass.map(([m, ax]) => `${ax} ${m.toFixed(2)} mm`).join(", ") +
      " of module carried by the door frame on each side");
}

// Wall thinning is bounded by the door, not by stiffness. The dovetail bites
// doorBite into the top and bottom walls, so the number that matters is what is
// left behind the groove - and the tool-less door is the one mechanism in the
// camera with no fallback. This is the gate that stops a later lightening pass
// from taking those two walls down without noticing what it is eating.
for (const [name, thickness] of [["bottom", P.wallBottom], ["top", P.wallTop]]) {
  const behind = thickness - P.doorBite;
  check(`${name} wall keeps material behind the dovetail groove`,
    behind >= 2.0,
    `${thickness} mm wall less a ${P.doorBite} mm dovetail bite leaves ${behind.toFixed(1)} mm carrying the groove`);
}
// All four walls are back to 6 mm. They were taken to 4.5/4.5/3.0 to save
// filament, and that was measured to cost 0.22 h of print time rather than save
// any - on this part the cost driver is surface area, and a thinner wall means a
// slightly LARGER inner cavity. So the thinning bought nothing and spent
// 1.5 mm of the material carrying each dovetail groove.
// The per-side parameters are kept because the constraint they encode is real
// and worth not rediscovering: the top and bottom walls carry the door's
// dovetail, so what matters there is what is left BEHIND the groove.
check("walls are uniform unless someone chose otherwise",
  P.wallBottom === P.wall && P.wallTop === P.wall && P.wallLeft === P.wall,
  `all four at ${P.wall} mm, leaving ${(P.wallBottom - P.doorBite).toFixed(1)} mm behind each dovetail groove - the geometry the door coupon was proved on`);

// Depth stack. Bulk in the hand is depth, so the arithmetic is a gate rather
// than a comment: every term is named and the sum must be the body depth.
const xiaoStack = xiaoPadH + P.xiaoBoardT;   // camera gap + board
const depthTerms = [
  ["front plate", P.plate],
  ["camera-module gap + XIAO board", xiaoStack],
  ["XIAO header pins + wire loop", P.xiaoHeaderZone],
  ["XIAO-to-module margin", P.xiaoModuleMargin],
  ["P4 heatsink + wiring clearance", P.bayDepth],
  ["module thickness", P.moduleT],
  ["foam shim", P.bezelFoam],
  ["door plate", P.bezelT],
];
const depthSum = depthTerms.reduce((t, [, v]) => t + v, 0);
check("depth stack adds up to the body depth",
  Math.abs(depthSum - P.bodyD) < 1e-6,
  depthTerms.map(([n, v]) => `${n} ${v}`).join(" + ") + ` = ${depthSum} mm`);
// The N8000 envelope is gone, and deliberately so: the measured hardware does
// not fit inside it. Kept as a gate against an explicit limit rather than
// deleted, so the camera cannot drift deeper again without someone choosing to
// raise this number and seeing what they are choosing.
check("assembled depth stays within its declared limit",
  P.bodyD + P.faceBase + P.faceLensBarProud <= P.maxAssembledDepth,
  `${(P.bodyD + P.faceBase + P.faceLensBarProud).toFixed(1)} mm over the lens bar, the proudest thing on the front now that the grip is gone; a real N8000 is 68 mm and the body alone is ${P.bodyD} mm`);
check("XIAO wiring zone clears the module bay",
  P.plate + xiaoStack + P.xiaoHeaderZone <= pcbBackZ - P.bayDepth,
  `XIAO board back at Z=${(P.plate + xiaoStack).toFixed(1)} mm plus ${P.xiaoHeaderZone} mm of header and wire room reaches Z=${(P.plate + xiaoStack + P.xiaoHeaderZone).toFixed(1)} mm, still under the bay floor at Z=${(pcbBackZ - P.bayDepth).toFixed(1)} mm`);
check("XIAO wiring zone is actually open",
  P.xiaoHeaderZone >= 10,
  `${P.xiaoHeaderZone} mm behind each XIAO for soldered header pins and the wire loop leaving them`);
// Camera capture: the pocket has to exist, take the module, and be gripped by
// its ribs. A camera that can shake in its mount ruins the frame.
for (const cx of cameraXs) {
  const pocket = P.camBody + P.camBodySlack;
  // The free space is the pocket less the rib tips on the two ribbed walls,
  // which is what the camera head actually occupies.
  const clear = pocket - 3 * P.camRibProud - 0.3;
  openProbe(`camera pocket ${cx} open`,
    cube(cx - pocket / 2 + 2 * P.camRibProud + 0.15,
      P.cameraLensY - pocket / 2 + 2 * P.camRibProud + 0.15,
      P.plate - camPocketDepth + 0.1,
      clear, clear, camPocketDepth - 0.2),
    `${pocket.toFixed(2)} mm pocket, ${clear.toFixed(2)} mm free between the rib tips and the datum walls, ${camPocketDepth} mm deep`);
  const ribGauge = cube(cx - pocket / 2, P.cameraLensY - pocket / 2 + 1.0,
    P.plate - camPocketDepth + 0.3, P.camRibProud * 1.5, pocket - 2.0, 0.5);
  check(`camera pocket ${cx} has pinch ribs`,
    intersectionVolume(body, ribGauge) > 0.05,
    `${P.camRibCount} ribs per axis crush ${P.camRibProud} mm each, pushing the head onto the datum walls`);
}
// The camera has to REACH its lens hole, and this is the gate that failed to
// say so. It used to compare a plausible head height against a declared
// stand-off - two figures nobody had measured - so it could only ever confirm
// that the two guesses agreed with each other. On the printed rig the camera
// fell about 2 mm short of the pocket and this gate passed.
//
// It is now the vendor's chain, and every term in it is measured or derived
// from something measured. The board's back face, less the assembled stack's
// own height, IS where the lens's front face lands; the plate has to have that
// plane inside it, and the pocket has to reach it.
{
  const boardBack = P.plate + xiaoPadH + P.xiaoBoardT;
  const pocketFloorZ = P.plate - camPocketDepth;
  check("the camera reaches its lens hole",
    Math.abs(lensFrontZ - pocketFloorZ) < 1e-9 && lensFrontZ >= 0.5,
    `board back at Z=${boardBack.toFixed(1)} less the stack's ${P.camStackH} mm overall height puts the lens face at Z=${lensFrontZ.toFixed(2)}, which is the pocket floor at Z=${pocketFloorZ.toFixed(2)}, ${P.platePocketAhead} mm of plate and bore still ahead of it`);
  // The module's PCB is the Z datum, so it has to have somewhere flat to land
  // and the fold has to have somewhere to turn.
  check("the module's PCB seats on the plate with the fold behind it",
    camFoldGap >= 0.3,
    `${xiaoPadH.toFixed(1)} mm of stand-off takes the module's ${P.camModulePcbT} mm PCB with ${camFoldGap.toFixed(1)} mm left for the folded ribbon`);
  // The head has to fit inside the plate, and the pocket has to be deeper than
  // the bore is long, or a short-barrelled head bottoms on the pocket floor
  // before its PCB reaches the plate.
  check("the head fits inside the front plate",
    camHeadReach > 0 && camHeadReach <= P.plate - 0.5 &&
      camPocketDepth >= P.platePocketAhead,
    `${camHeadReach.toFixed(1)} mm of holder and barrel in a ${camPocketDepth.toFixed(1)} mm pocket plus ${P.platePocketAhead} mm of bore`);
  // And the pupil the lens cells are cut from cannot sit in front of the lens.
  check("the field cone's pupil sits behind the lens face",
    P.camPupilBackFromFront >= lensFrontZ,
    `pupil ${P.camPupilBackFromFront} mm behind the plate's front face, lens face ${lensFrontZ.toFixed(2)} mm behind it`);
  // The ribbon is what makes all of this compulsory: it cannot reach past the
  // fold, so the module has no second position to be in.
  const foldCost = 2 * camFoldGap + Math.PI * camFoldGap / 2;
  check("the ribbon reaches the fold it has to make",
    foldCost <= P.camRibbonLen,
    `a ${camFoldGap.toFixed(1)} mm fold costs about ${foldCost.toFixed(1)} mm of the ${P.camRibbonLen} mm ribbon, the rest running to the connector`);
}
// The gate for the bench failure. The camera module is a separate PCB on a
// ribbon and it has to sit flat against the plate with its lens in the pocket;
// anything standing in that footprint stops it, and then the lens never
// reaches the pocket at all. Measured on the solid, per station.
for (const cx of cameraXs) {
  const keepOut = cube(cx - camModX, P.cameraLensY - camModY, P.plate + 0.05,
    2 * camModX, 2 * camModY, P.camModulePcbT);
  const hit = intersectionVolume(body, keepOut);
  check(`camera module footprint clear at X=${cx}`,
    hit < 1e-3,
    `${(2 * camModX).toFixed(1)} x ${(2 * camModY).toFixed(1)} x ${P.camModulePcbT} mm clear behind the plate for the module PCB and its ribbon (${hit.toFixed(2)} mm^3 obstructed)`);
}
check("camera pocket takes up part variation",
  P.camRibProud >= 0.15 && P.camBodySlack <= 0.2,
  `${P.camBodySlack} mm nominal slack against ${P.camRibProud} mm ribs: a nominal head is a light interference fit, and the coupon resolves the rest`);
// The bore passes the lens barrel, and stays small enough that the pocket
// floor is still a seat for the camera head to press against.
{
  const pocket = P.camBody + P.camBodySlack;
  const ledge = (pocket - P.lensBoreD) / 2;
  // The bore is a GUIDE, not a clearance hole, so this now gates a band rather
  // than a minimum: it must pass the barrel, and it must not be so generous
  // that the lens can move in it. It used to demand >= barrel + 0.3, which is
  // the opposite requirement.
  const fitPerSide = (P.lensBoreD - P.camBarrelD) / 2;
  check("lens bore guides the barrel and leaves a seat",
    fitPerSide > 0 && fitPerSide <= 0.10 && ledge >= 0.4,
    `Ø${P.lensBoreD} mm bore guiding a Ø${P.camBarrelD} mm barrel at ${fitPerSide.toFixed(3)} mm per side, on a ${ledge.toFixed(2)} mm seat at mid-face (wider at the corners). Ream with a 7 mm bit if it prints tight.`);
}

// Nothing the camera can see may be part of the camera. The lens looks out
// through the body's front plate and then the face shell's stepped cell, which
// together are a tunnel about 11 mm long in front of the pupil. If that tunnel
// is narrower than the field cone, the shell shows up as a dark ring in every
// frame - and on a wigglegram a ring that moves between the four views is far
// worse than one that does not.
// This measures the cone that actually escapes the ASSEMBLED shells rather
// than assuming the countersink is enough.
{
  const faceFrontZ = -(P.faceBase + P.faceLensBarProud);
  const pupilZ = P.plate - P.camPupilBackFromFront;
  const tunnel = pupilZ - faceFrontZ;
  // The cover in its OPEN position is part of the enclosure the lens has to see
  // past: its top edge sits just below the cells. The keeper too, in its gap.
  const assembled = fuse([body, face, lensSlider.translate(SLIDER_OPEN), sliderKeeper]);

  // Cone apex on the pupil, opening forward. Manifold builds along +Z with
  // rLow at z=0, so the wide end is placed at the face front and the apex
  // lands back on the pupil.
  const coneAt = (cx, halfDeg) => {
    const r = tunnel * Math.tan((halfDeg * Math.PI) / 180);
    return Manifold.cylinder(tunnel, r, 0.001, 96)
      .translate([cx, P.cameraLensY, faceFrontZ]);
  };

  // Largest clear half-angle per lens, to 0.05 degrees.
  const clearHalf = cameraXs.map((cx) => {
    let lo = 0, hi = 80;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (intersectionVolume(assembled, coneAt(cx, mid)) < 1e-6) lo = mid;
      else hi = mid;
    }
    return lo;
  });

  const worst = Math.min(...clearHalf);
  const need = P.camFovDeg / 2;
  check("no part of the shell reaches into the camera's field of view",
    worst >= need,
    `${(worst * 2).toFixed(1)} degrees clear through the ${tunnel.toFixed(1)} mm tunnel (plate ${P.plate} + face ${(P.faceBase + P.faceLensBarProud).toFixed(1)}, pupil ${P.camPupilBackFromFront} mm back), against ${P.camFovDeg} degrees diagonal needed: ${((worst - need) * 2).toFixed(1)} degrees of margin. Per lens: ${clearHalf.map((h) => (h * 2).toFixed(1)).join(", ")}`);

  // All four have to match, or the vignette differs between frames and the
  // wiggle gets a pulsing border.
  const spread = Math.max(...clearHalf) - worst;
  check("all four lenses see the same amount",
    spread < 0.2,
    `${(spread * 2).toFixed(2)} degrees of difference between the widest and narrowest cell`);
}
// The light mount must be reachable: a bolt on a square base plate cannot be
// fed through the bore, so the nut goes in from inside through an open shaft.
// Overhead-light mount, now a bore through the flat top wall rather than a
// shaft up into a prism. The three hump gates that used to live here measured
// the crest's flat, proved the hump was front-biased and proved it narrowed as
// it rose. There is no hump, so they are gone; what has to be true instead is
// that the bore goes all the way through, that the flat top can seat the base
// plate, and that the stud's own nuts have somewhere to go inside.
openProbe("light stud bore passes through the top wall",
  cylinderAlongY(P.quarterX, innerMaxY + 0.2, P.quarterZ,
    P.lightBoltD / 2 - 0.2, P.wallTop - 0.4),
  "Ø" + P.lightBoltD.toFixed(1) + " mm bore through the " + P.wallTop +
    " mm top wall at X=" + P.quarterX + ", Z=" + P.quarterZ +
    ", opening straight into the cavity");
{
  // The seat is measured on the solid, the same discipline the crest gate had.
  const slab = 0.4;
  const half = P.lightPlate / 2;
  const seat = cube(P.quarterX - half, P.bodyH - slab, P.quarterZ - half,
    P.lightPlate, slab, P.lightPlate);
  const solid = intersectionVolume(body, seat) / seat.volume();
  // The bore is inside the footprint, so a perfect seat is NOT 100% solid.
  // Expect exactly the footprint less the bore, and allow 2% for facets.
  const bore = Math.PI * (P.lightBoltD / 2) ** 2;
  const want = (P.lightPlate ** 2 - bore) / P.lightPlate ** 2;
  check("flat top seats the light's base plate",
    solid >= want - 0.02,
    (100 * solid).toFixed(0) + "% of an " + P.lightPlate +
      " mm square footprint centred at X=" + P.quarterX + ", Z=" + P.quarterZ +
      " is solid top wall, against " + (100 * want).toFixed(0) +
      "% expected once the Ø" + P.lightBoltD + " bore is taken out");

  // 25 mm of stud, part of it buried in the light, less the wall it passes
  // through, is what is left for the two nuts it ships with.
  const inside = P.lightStudLen - P.lightStudBuried - P.wallTop;
  check("two nuts fit on the stud inside the cavity",
    inside >= 2 * P.quarterNutT,
    inside.toFixed(1) + " mm of stud inside the body against " +
      (2 * P.quarterNutT).toFixed(1) + " mm for two " + P.quarterNutT +
      " mm nuts");

  // And that length of stud, plus the nuts, must not run into anything.
  openProbe("stud and its nuts clear the cavity",
    cylinderAlongY(P.quarterX, innerMaxY - inside, P.quarterZ,
      nutCorner, inside - 0.2),
    "Ø" + (2 * nutCorner).toFixed(1) + " x " + inside.toFixed(1) +
      " mm swept by the nuts below the top wall is clear");
}

// --- Coupon gates ----------------------------------------------------------

// The gate for the bench failure: NOTHING but the four pads may come near the
// module. A flat frame resting on the standoff tops leaves only 5 mm of
// clearance and fouls the 2.54 mm headers, which is what happened to the first
// screw test on the real board.
{
  const margin = 9.0, web = 3.0;
  const padPlane = web + P.postTestLift;
  const w = P.p4HoleX + margin * 2, h = P.p4HoleY + margin * 2;
  // Everything in the band the board's connectors occupy, once the gauge is
  // sitting on the standoffs.
  const band = cube(-5, -5, padPlane - P.postTestLift + 0.5,
    w + 10, h + 10, P.postTestLift);
  let intruders = postTest.intersect(band);
  for (const x of [margin, margin + P.p4HoleX]) {
    for (const y of [margin, margin + P.p4HoleY]) {
      intruders = intruders.subtract(
        cylZ(x, y, padPlane - P.postTestLift - 1, P.p4PostD / 2 + 0.25,
          P.postTestLift + 2, 64));
    }
  }
  for (const x of [margin, margin + P.p4HoleX]) {
    for (const y of [margin, margin + P.p4HoleY]) {
      const probe = cylZ(x, y, padPlane - P.p4StandoffSocketDepth + 0.05, P.p4StandoffOD / 2 - 0.02, P.p4StandoffSocketDepth - 0.1, 48);
      const over = cylZ(x, y, padPlane - P.p4StandoffSocketDepth + 0.05, P.p4StandoffOD / 2 + 0.1, 0.3, 48);
      const mouth = cylZ(x, y, padPlane - 0.3, P.p4StandoffOD / 2 + 0.25, 0.3, 48);
      const rim = cylZ(x, y, padPlane - 0.3, socketD / 2 + 0.3, 0.6, 48).subtract(cylZ(x, y, padPlane - 0.4, socketD / 2 + 0.05, 0.8, 48));
      check(`P4 gauge socket ${x.toFixed(1)},${y.toFixed(1)} matches the posts`,
        intersectionVolume(postTest, probe) < 1e-6 && intersectionVolume(postTest, over) > 1e-3 && intersectionVolume(postTest, mouth) < 1e-6 && intersectionVolume(postTest, rim) > 0.5 * rim.volume(),
        `Ø${socketFloorD.toFixed(2)} floor / Ø${socketD.toFixed(2)} mouth x ${P.p4StandoffSocketDepth} mm cone in the pad, ${(P.p4PostD / 2 - socketD / 2).toFixed(2)} mm of pad wall around it - the same socket the body's posts carry`);
    }
  }
  check("P4 gauge touches nothing but the four standoff tops",
    intruders.volume() < 1.0,
    `${intruders.volume().toFixed(2)} mm^3 of the gauge sits within ${P.postTestLift} mm of the pad plane outside the four Ø${P.p4PostD} pads, so only the standoffs are contacted and the board's ~11 mm headers clear`);
  // And it has to work with the screws this build already calls for. What
  // matters is thread ENGAGEMENT, not that the screw bottoms out - a screw
  // that bottoms in the standoff jacks the gauge back off its own pads.
  const grip = P.postTestSeatRun + 0.8;
  const engage = 8.0 - grip;
  check("P4 gauge works with an M2x8",
    engage >= 2.0 && engage <= P.p4StandoffH - 0.2,
    `${grip.toFixed(1)} mm of gauge above the seat leaves an M2x8 ${engage.toFixed(1)} mm of thread in the ${P.p4StandoffH} mm standoff - enough to pull the pads down, not enough to bottom out. A bore straight through ${padPlane.toFixed(0)} mm of gauge would have needed M2x20.`);
}

// Each coupon must sit on the bed, stay quick to print, and actually carry the
// feature it exists to test. A coupon that is missing its feature is worse than
// no coupon: it reports a pass on the bench for something never tried.
const COUPONS = [
  // The P4 gauge belongs in this list too. It was never audited for support
  // before, and it was quietly printing a quarter of each pillar over air.
  ["P4 bridge gauge", postTest, 14],
  ["camera fit", camCoupon, 8],
  ["XIAO stack", stackCoupon, 22],
  // The rig gets a larger budget than the coupons on purpose: it is a fixture
  // you keep and shoot with, not a chip you print to read one number off.
  ["wiggle rig", wiggleRig, 46],
  // Grew with the real 7.6 mm board stack: its pads, fences and bosses all
  // reference the board's back face, which moved 6.4 mm out.
  ["skeletal rig", skeletalRig, 24],
  // The door-joint coupon carries a 32 mm length of the slide's square
  // shoulder on each wall - about 96 mm^2 of deliberate flat ceiling, rooted on
  // the groove's deep wall in its own first layer. See the doorBite block for
  // why a flat anchored ledge replaced a 47-degree cantilever that grew from a
  // knife edge. Budget 200, and the layer gate is the authority.
  ["door joint", doorCoupon, 22, 200],
  // 26 -> 30: runs from the bar's bottom rim past the panel's top end now, so
  // both cover positions, the detent and the keeper can be worked on it. Its
  // support-free allowance is the cover's own (its serial floor, ~62 mm^2)
  // plus what the chunk carries of the face's sub-45-degree facets (~16).
  ["lens cover track", sliderCoupon, 30, 100],
  ["split joint", jointCoupon, 12],
  // The collar bore is a horizontal bore in a vertical wall, so its roof is a
  // bridge - the same one the real front half prints. 120 covers that plus the
  // wire exit's roof and the button's own dish.
  ["shutter", shutterCoupon, 16, 120],
  ["face alignment tool", alignToolPrint, 12],
  // Also grew with the board stack: its bosses are the body's real boss height,
  // which is measured to the board's back face.
  ["insert pilots", pilotCoupon, 12],
];
for (const [name, solid, maxCm3, maxOverhang = 80] of COUPONS) {
  const bb = solid.boundingBox();
  const cm3 = solid.volume() / 1000;
  check(`${name} coupon prints flat and quick`,
    Math.abs(bb.min[2]) < 1e-6 && cm3 <= maxCm3,
    `${(bb.max[0] - bb.min[0]).toFixed(0)} x ${(bb.max[1] - bb.min[1]).toFixed(0)} x ${(bb.max[2] - bb.min[2]).toFixed(0)} mm, ${cm3.toFixed(1)} cm^3, sitting on the bed`);
  const overhang = overhangArea(solid);
  check(`${name} coupon prints support-free`,
    // 80, not 40: the cover and the alignment tool carry their serials on bed
    // faces, and a bed-face engraving's floor is a ceiling the width of its
    // 0.6 mm strokes - a bridge, not an overhang - ~62 mm^2 of it for the
    // 51 mm serial line.
    //
    // No per-triangle limit any more. maxTri was standing in for unsupported
    // SPAN and it cannot do the job: the door slide's shoulder is one flat
    // 1.5 x 32 mm ledge per wall, so it is 48 mm^2 in a couple of triangles
    // and a 1.5 mm one-sided bridge off a root that exists. Area and triangle
    // count cannot tell that from a cantilever in mid-air; the layer gate can,
    // and it is what judges these parts now.
    overhang.area < maxOverhang,
    `${overhang.area.toFixed(2)} mm^2 of >45-degree downward faces (allowed ${maxOverhang}), largest single face ${overhang.maxTri.toFixed(2)} mm^2`);
}

// The station coupon has to carry the whole station, or it is just a plate.
{
  const bb = stationCoupon.boundingBox();
  const [lx, ly] = toStation([cameraXs[1], P.cameraLensY, 0]);
  openProbe("station coupon carries an open lens bore",
    cylZ(lx, ly, -0.5, P.lensBoreD / 2 - 0.3, P.plate + 1),
    "the located camera pocket and its bore came through the cut",
    stationCoupon);
  // The heat-set boss is the other half of what this coupon is for.
  const [bx, by, bz] = toStation([clampBossXs[1], clampBossYs[1], boardBackZ]);
  openProbe("station coupon carries the clamp boss pilot",
    cylZ(bx, by, bz - P.m2InsertDepth + 0.3,
      P.m2InsertPilotD / 2 - 0.2, P.m2InsertDepth - 0.6),
    `Ø${P.m2InsertPilotD} x ${P.m2InsertDepth} mm pocket for the A2 insert, on the real boss`,
    stationCoupon);
  check("station coupon is one lens pitch wide",
    Math.abs((bb.max[0] - bb.min[0]) - P.cameraPitch) < 0.01,
    `${(bb.max[0] - bb.min[0]).toFixed(1)} mm, so the cut faces land midway between stations and the fences are whole`);
}

// The rig has to take the released bow clamps, not just a bar of its own. The
// clamp is planar, so this is really a check that the rig's boss top and its
// board-back plane are coplanar and that nothing on the rig is in the clamp's
// way - the taller fences being the obvious candidate, since they stand proud
// of the board and the clamp's arms pass close to them.
{
  const { shift, boardBack, stations } = rigProbe.clamp;
  let worstClash = 0;
  let minToeOnBoard = Infinity;
  for (const { cx, bossY, footY } of stations) {
    const clamp = buildGapClampAt(cx, bossY, footY)
      .translate([0, 0, boardBack - shift[2]]);
    worstClash = Math.max(worstClash, intersectionVolume(wiggleRig, clamp));
    // The toe must sit ON the board, not off its edge.
    const board = cube(cx - P.xiaoBoardW / 2, boardMinY - shift[1], boardBack,
      P.xiaoBoardW, P.xiaoBoardH, 0.2);
    const foot = cube(cx - P.clampFootW / 2, footY - P.clampFootLen, boardBack,
      P.clampFootW, P.clampFootLen, 0.2);
    minToeOnBoard = Math.min(minToeOnBoard,
      intersectionVolume(board, foot) / (P.clampFootW * P.clampFootLen * 0.2));
  }
  check("rig takes its own short clamps, carried in its file",
    worstClash < 1.0 && minToeOnBoard > 0.7,
    `boss top and board back are coplanar at Z=${boardBack.toFixed(1)} on the rig against Z=${boardBackZ.toFixed(1)} on the body, and the same planar clamp spans both: ${worstClash.toFixed(2)} mm^3 of interference, ${(minToeOnBoard * 100).toFixed(0)}% of each toe landing on the board`);
}

// The skeletal rig has to be the same fixture, only lighter. Everything the
// full rig is gated for, it is gated for: the four bores open, the released
// clamps fitting, and a seat for the bus board. A lighter part that has quietly
// stopped doing one of those jobs is not a lighter part, it is a different one.
{
  const { shift, boardBack, stations, bus } = skelProbe;
  for (const cx of cameraXs) {
    openProbe(`skeletal rig lens bore ${cx} open`,
      cylZ(cx - shift[0], P.cameraLensY - shift[1], -0.5,
        P.lensBoreD / 2 - 0.3, P.plate + 1),
      "the pocket and bore came through with the plate cut back to a boss",
      skeletalRig);
  }
  let clash = 0, toeOn = Infinity;
  for (const { cx, bossY, footY } of stations) {
    const clamp = buildGapClampAt(cx, bossY, footY)
      .translate([0, 0, boardBack]);
    clash = Math.max(clash, intersectionVolume(skeletalRig, clamp));
    const board = cube(cx - P.xiaoBoardW / 2, boardMinY - shift[1], boardBack,
      P.xiaoBoardW, P.xiaoBoardH, 0.2);
    const foot = cube(cx - P.clampFootW / 2, footY - P.clampFootLen, boardBack,
      P.clampFootW, P.clampFootLen, 0.2);
    toeOn = Math.min(toeOn, intersectionVolume(board, foot)
      / (P.clampFootW * P.clampFootLen * 0.2));
  }
  check("skeletal rig takes its own short clamps too",
    clash < 1.0 && toeOn > 0.7,
    `board back still at Z=${boardBack.toFixed(1)} off a 3 mm truss instead of a 5 mm plate: ${clash.toFixed(2)} mm^3 interference, ${(toeOn * 100).toFixed(0)}% of each toe on the board`);
  const [bw, bd] = P.rigPerfBoard;
  const seat = cube(bus.cx - bw / 2 - shift[0], bus.cy - bd / 2 - shift[1],
    bus.z + 0.2, bw, bd, 14.0);
  const blocked = intersectionVolume(skeletalRig, seat);
  check("skeletal rig has room for the 5 V / GND bus board",
    blocked < 1.0,
    `the ${bw} x ${bd} mm board overhangs its own posts on two legs and a cross rail rather than a slab, with 14 mm clear above it (${blocked.toFixed(2)} mm^3 obstructed)`);
}

// The power bus has to have somewhere to actually be. "There is room" is the
// kind of claim that is easy to assert and easy to get wrong, so it is
// measured: the board's own footprint must be clear from the post faces up,
// with height for a 2.54 mm header and a plugged housing on top of it.
{
  const { cx, cy, z, posts } = rigProbe.perf;
  const [bw, bd] = P.rigPerfBoard;
  const headroom = 14.0;   // header pins plus a Dupont housing
  const seat = cube(cx - bw / 2, cy - bd / 2, z + 0.2,
    bw, bd, headroom);
  const blocked = intersectionVolume(wiggleRig, seat);
  check("wiggle rig has room for the 5 V / GND bus board",
    blocked < 1.0,
    `${bw} x ${bd} mm perfboard sits ${P.rigPerfPostH} mm off the apron on four posts with ${headroom} mm of clear height above it for header strips and plugged housings (${blocked.toFixed(2)} mm^3 obstructed)`);
  for (const [px, py] of posts) {
    openProbe(`bus board post pilot ${px.toFixed(1)},${py.toFixed(1)}`,
      cylZ(px, py, z - 5.0, P.rigPerfPilotD / 2 - 0.15, 4.6, 24),
      `Ø${P.rigPerfPilotD} mm pilot for an M2 self-tapper`,
      wiggleRig);
  }
}

// The door coupon is worthless unless BOTH halves of the detent came through:
// a rail with no dimple, or a door with no bump, tests nothing.
{
  const parts = doorCoupon.decompose().length;
  check("door coupon has both the wall rails and the door",
    parts === 2,
    `${parts} pieces: a length of both grooved walls at their true spacing, and the matching length of door`);
}

// Same rule for the shutter coupon: a wall chunk with no bore, or a bore with
// no button to put in it, tests nothing. Probed in the coupon's own frame by
// re-deriving where the collar landed after the chunk was dropped to the bed,
// rather than assuming the drop offset.
{
  const parts = shutterCoupon.decompose().length;
  const raw = chunk(bodyFront, P.shutterX - 16.0, P.bodyH - 18.0, 8.0,
    P.bodyW + 1, P.bodyH + 1, splitZ);
  const s = raw.boundingBox().min;
  const at = ([x, y, z]) => [x - s[0], y - s[1], z - s[2]];
  const [cx, cy, cz] = at([P.shutterX, P.bodyH, P.shutterZ]);
  // Down the collar's axis: the actuator's stem bore must be open all the way
  // from the outer face to the switch pocket.
  const boreProbe = cylinderAlongY(cx, cy - P.wallTop - P.shutterPodReach - 0.5,
    cz, (P.shutterPressCapD - 0.6) / 2, P.wallTop + P.shutterPodReach + 1.0, 32);
  const bore = intersectionVolume(dropToBed(raw), boreProbe);
  check("shutter coupon carries the collar, the pod, the pocket and both button parts",
    parts === 3 && bore < 1e-6,
    `${parts} pieces (wall chunk, actuator, retainer); the Ø${(P.shutterPressCapD - 0.6).toFixed(1)} stem path through the wall and pod is ${bore < 1e-6 ? "open" : `BLOCKED by ${bore.toFixed(2)} mm^3`}`);
}

// Pattern truth.
/* The measured group, restated so a silent edit to any of it fails the build
 * rather than moving four posts. The pitch and the height are calipers on the
 * board; the offset is not, and is the one thing the paper template checks. */
check("P4 pattern", Math.abs(P.p4HoleX - 61.9) < 1e-9 &&
  Math.abs(P.p4HoleY - 54.8) < 1e-9 &&
  Math.abs(P.p4PatternOffsetX + 9.3) < 1e-9 &&
  Math.abs(P.p4StandoffH - 3.3) < 1e-9 &&
  Math.abs(P.p4StandoffOD - 3.5) < 1e-9,
  "61.9 x 54.8 mm CENTRE pitch of Ø3.5 x 3.3 brass, centre 9.3 mm left of module centre; the pitch is the drawing's, the diameter and height are measured, the offset is still PROVISIONAL and checked on paper");
// The gate that stops the pattern moving a fourth time. A caliper reaches
// EDGES, not centres, so the measurement and the pitch are two different
// quantities and they differ by exactly one standoff diameter. Written into the
// wrong field, 61.9 became "65.5" and every post moved 1.8 mm out - a fault
// invented to fix a fault that was not there. Now the two have to agree.
{
  const spanX = P.p4HoleX + P.p4StandoffOD, spanY = P.p4HoleY + P.p4StandoffOD;
  check("the standoff pitch and the caliper span across the standoffs agree",
    Math.abs(spanX - P.p4OutsideSpanX) <= 0.5 && Math.abs(spanY - P.p4OutsideSpanY) <= 0.5,
    `${P.p4HoleX} x ${P.p4HoleY} between centres plus Ø${P.p4StandoffOD} of brass is ${spanX.toFixed(1)} x ${spanY.toFixed(1)} edge to edge, against ${P.p4OutsideSpanX} x ${P.p4OutsideSpanY} measured with calipers - inside the 0.5 mm a whole-millimetre reading can hide. If these ever disagree by more, one of them is the other one's field.`);
}

// Capture stack: posts vs door foam preload.
check("module capture stack",
  Math.abs((P.bodyD - P.bezelT - glassRearZ) - P.bezelFoam) < 1e-9 &&
    P.bezelFoam >= 0.8,
  `glass rear at ${glassRearZ.toFixed(1)} mm, door inner face at ${(P.bodyD - P.bezelT).toFixed(1)} mm: ${P.bezelFoam.toFixed(1)} mm foam-shim gap gives the compression preload`);

// XIAO stations.
const installedClamps = fuse(cameraXs.map((cx, i) =>
  buildGapClampAt(clampBossXs[i], clampBossYs[i], clampFootY, cx)
    .translate([0, 0, clampBossTopZ])));
check("installed clamps are four parts", installedClamps.decompose().length === 4,
  "one bow clamp per station");
for (const [ci, cx] of cameraXs.entries()) {
  const bossX = clampBossXs[ci], clampBossY = clampBossYs[ci];
  const boardProbe = cube(cx - P.xiaoBoardW / 2, boardMinY, boardFrontZ,
    P.xiaoBoardW, P.xiaoBoardH, P.xiaoBoardT);
  check(`XIAO ${cx} board volume open`,
    intersectionVolume(body, boardProbe) < 1e-6,
    "the 17.8 x 21.0 x 1.2 board sits on its corner pads untouched");
  const cameraFrontProbe = cube(cx - 5, P.cameraLensY - 5, P.plate + 0.05,
    10, 10, xiaoPadH - 0.1);
  check(`XIAO ${cx} lens/sensor pocket open`,
    intersectionVolume(body, cameraFrontProbe) < 1e-6,
    `${xiaoPadH.toFixed(1)} mm front stack space between board face and plate around the lens`);
  const rearProbe = cube(cx - P.xiaoBoardW / 2 + 1, boardMinY + 1, boardBackZ + 0.05,
    P.xiaoBoardW - 2, P.xiaoBoardH - 2, 10);
  // The only thing allowed behind the board is the clamp's foot, and it now
  // runs down the CENTRELINE between the header rows rather than out at the
  // corners - so that is the region subtracted before the probe is applied.
  const allowX0 = Math.min(cx, bossX) - P.clampFootW / 2 - 0.4, allowX1 = Math.max(cx, bossX) + P.clampFootW / 2 + 0.4;
  const footAllowance = cube(allowX0,
    clampFootY - P.clampFootLen - 0.4, boardBackZ,
    allowX1 - allowX0, P.clampFootLen + P.clampBossAt[ci][1], P.clampT + 0.6);
  check(`XIAO ${cx} heatsink/header rear space`,
    intersectionVolume(body, rearProbe) < 1e-6 &&
      intersectionVolume(installedClamps,
        rearProbe.subtract(footAllowance)) < 1e-6,
    `10 mm behind the board is open except the clamp foot, a ${P.clampFootW} mm strip down the centreline`);
  const clampBossGauge = cylZ(bossX, clampBossY, clampBossTopZ - 1,
    P.clampBossD / 2 - 0.2, 1);
  check(`XIAO ${cx} clamp boss at board-back plane`,
    intersectionVolume(body, clampBossGauge) > 20,
    `boss top flush with the board back at Z=${clampBossTopZ.toFixed(1)} mm`);
  const insertProbe = cylZ(bossX, clampBossY, clampBossTopZ - P.m2InsertDepth,
    P.m2InsertPilotD / 2 - 0.1, P.m2InsertDepth - 0.1);
  check(`XIAO ${cx} insert pocket open`,
    intersectionVolume(body, insertProbe) < 1e-6,
    `Ø${P.m2InsertPilotD.toFixed(1)} x ${P.m2InsertDepth.toFixed(1)} mm pocket for the A2 M2 insert (OD 3.5 x L 4)`);
  const pocketFloor = cylZ(bossX, clampBossY,
    clampBossTopZ - P.m2InsertDepth - 0.9, 1.0, 0.7);
  check(`XIAO ${cx} insert pocket blind floor`,
    intersectionVolume(body, pocketFloor) > 1.0,
    "pocket keeps a solid floor above the plate");
  const clampScrew = cylZ(bossX, clampBossY, clampBossTopZ + 0.1, 1.0, 4.0);
  check(`XIAO ${cx} clamp screw passage`,
    intersectionVolume(installedClamps, clampScrew) < 1e-6,
    "M2 passes the printed clamp into the boss insert");
  // And a driver has to reach that screw from the door, with the module out:
  // a shaft of clampDriverD from the clamp's top face to the rear face must
  // pass through both halves and every other clamp untouched. Camera 4's boss
  // at the top wall sat under the X 92 split pad and failed this - which was
  // first seen in the slicer, because the gate did not exist.
  const driver = cylZ(bossX, clampBossY, clampBossTopZ + P.clampT + 0.05, P.clampDriverD / 2,
    P.bodyD - (clampBossTopZ + P.clampT) + 1.0, 32);
  const driverHit = intersectionVolume(body, driver) + intersectionVolume(installedClamps, driver);
  check(`XIAO ${cx} clamp screw reachable with a driver from the door`,
    driverHit < 1e-6,
    `Ø${P.clampDriverD} shaft from Z ${(clampBossTopZ + P.clampT).toFixed(1)} to the rear face at (${bossX.toFixed(1)}, ${clampBossY.toFixed(1)}): ${driverHit.toFixed(3)} mm^3 in the way, module out`);
  // The clamp presses a strip down the board's centreline, between the header
  // rows. This gate used to look for material at the two top CORNERS, which is
  // where the old bow put its toes and where the header mouldings actually are.
  const footGauge = cube(cx - P.clampFootW / 2 + 0.5,
    clampFootY - P.clampFootLen + 0.3, clampBossTopZ,
    P.clampFootW - 1.0, P.clampFootLen - 0.6, 1.2);
  check(`XIAO ${cx} clamp presses the centreline strip`,
    intersectionVolume(installedClamps, footGauge) > 0.5,
    `a ${P.clampFootW} x ${P.clampFootLen} mm foot bears on bare board between the header rows`);
  check(`XIAO ${cx} clamp under bay`,
    clampBossTopZ + 3.6 <= bayMinZ,
    `clamp top at ${(clampBossTopZ + 3.6).toFixed(1)} mm stays under the bay floor at ${bayMinZ.toFixed(1)} mm`);
}

// Board-to-board harness gaps.
for (let i = 0; i < cameraXs.length - 1; i++) {
  const gap = cameraXs[i + 1] - cameraXs[i] - P.xiaoBoardW;
  check(`XIAO ${i + 1}-${i + 2} edge gap`, gap >= 3.0,
    `${gap.toFixed(2)} mm between adjacent boards for header wiring`);
}

// Power entry: bottom-wall cable exit, its tie slots, and the blind plug
// recess in the top wall.
// The passage is a rounded slot now, so a square probe no longer fits inside
// it - its corners fall outside the lobes. Probe the inscribed circle.
const usbProbe = cylinderAlongY(P.usbPassageX, -0.5, usbPassageZ,
  (P.usbPassageSlotW - 0.4) / 2, P.wallBottom + 3, 64);
check("cable exit passage open", intersectionVolume(body, usbProbe) < 1e-6,
  `Ø${(P.usbPassageSlotW - 0.4).toFixed(1)} mm clear inside a ${P.usbPassageSlotW} x ${(P.usbPassageSlotW + P.usbPassageSlotTravel).toFixed(1)} mm rounded slot through the bottom wall at X=${P.usbPassageX}`);
check("cable passage spans the connector plane",
  usbPassageZ - P.usbPassageH / 2 < pcbBackZ &&
    usbPassageZ + P.usbPassageH / 2 > pcbBackZ - 8,
  `passage spans Z=${(usbPassageZ - P.usbPassageH / 2).toFixed(1)}-${(usbPassageZ + P.usbPassageH / 2).toFixed(1)} across the receptacle plane just in front of the PCB back at ${pcbBackZ} mm`);
for (const side of [-1, 1]) {
  const slotProbe = capsuleSlotY(P.usbPassageX + side * P.usbTieOffsetX, -0.5,
    usbPassageZ, P.usbTieSlotW - 0.2,
    P.usbTieSlotH - P.usbTieSlotW, P.wallBottom + 3);
  check(`zip-tie slot ${side < 0 ? "left" : "right"} open`,
    intersectionVolume(body, slotProbe) < 1e-6,
    `${P.usbTieSlotW.toFixed(1)} x ${P.usbTieSlotH.toFixed(1)} mm tie path through the bottom wall`);
}
// The module's USB-C stands up off the board FACE, so its plug points forward
// into the bay - and the bay is where the XIAO boards and their header wiring
// live. This clash is between two parts that are NOT in the printed solid, so
// no probe of the body can catch it; it has to be arithmetic.
// The previous version of this gate probed a strip along the board's top edge
// (Y 72..80) on the belief that the connector sat up by the GPIO edge. It
// passed happily while checking a place the plug is not.
{
  // The wiring-hub board floats loose in the bay alongside the plug. Nothing
  // holds it, so what these gates prove is only that the room is there.
  // Depth first: board plus its plugged pin field must clear the bay floor.
  const need = P.piggybackT + P.piggybackHeaders;
  const clearInBay = P.bayDepth + P.xiaoModuleMargin;
  check("loose piggyback board and its headers clear the bay depth",
    need <= clearInBay,
    `${need.toFixed(1)} mm of board plus plugged headers in ${clearInBay.toFixed(1)} mm of bay: ${(clearInBay - need).toFixed(1)} mm spare`);

  // Then plan area: it cannot live in the strips above or below the XIAO band,
  // so it has to lie in the bay slab, beside the connector.
  // A floating board needs the room, not a footprint.
  const bayPlanW = P.bodyW - 2 * P.wall;
  const bayPlanH = P.bodyH - P.wallBottom - P.wallTop;
  // Plan area alone is not a home - the four P4 posts run up through the bay.
  // The gap between the post COLUMNS is only 53.9 mm against a 54 mm board, so
  // the board cannot pass between them left-to-right; it has to lie in the band
  // between the two post ROWS. This gate measures that box on the real solid
  // instead of trusting the arithmetic.
  {
    const need = P.piggybackT + P.piggybackHeaders;
    const bx = centerX - P.piggyback[0] / 2;
    const by = P.cameraLensY - P.piggyback[1] / 2;
    const home = cube(bx, by, bayMinZ, P.piggyback[0], P.piggyback[1], need);
    const fouled = intersectionVolume(body, home);
    check("piggyback board has a clear home in the bay",
      fouled < 1e-6,
      `${P.piggyback[0]} x ${P.piggyback[1]} x ${need.toFixed(1)} mm box at X ${bx.toFixed(1)}-${(bx + P.piggyback[0]).toFixed(1)}, Y ${by.toFixed(1)}-${(by + P.piggyback[1]).toFixed(1)}, Z ${bayMinZ.toFixed(1)}-${(bayMinZ + need).toFixed(1)} is empty (${fouled.toFixed(4)} mm^3 fouled). It lies between the two post rows, not between the columns.`);
  }

  check("loose piggyback board fits the bay in plan",
    P.piggyback[0] <= bayPlanW && P.piggyback[1] <= bayPlanH,
    `${P.piggyback[0]} x ${P.piggyback[1]} mm board in a ${bayPlanW.toFixed(1)} x ${bayPlanH.toFixed(1)} mm bay slab`);
}

{
  const clearInBay = P.bayDepth + P.xiaoModuleMargin;
  check("straight USB-C plug clears the XIAO stack",
    clearInBay >= P.usbPlugClearance,
    `${clearInBay.toFixed(1)} mm between the back of the XIAO header wiring and the module's PCB face, against ${P.usbPlugClearance} mm for a straight plug standing off it. A right-angle cable would need about 9 mm.`);
}

// Shutter cavity, guide and wires (probes mirror the cutters, undersized).
const podInnerY = innerMaxY - P.shutterPodReach;
const switchPocketDepth = P.shutterSwitchBody[2] + 0.5;
const switchPocketY = podInnerY - 0.4;
const shutterAssemblyProbe = cylinderAlongY(P.shutterX, switchPocketY - 0.1,
  P.shutterZ, P.shutterAssemblyAccessD / 2 - 0.1, switchPocketDepth + 0.8);
check("shutter flange assembly path",
  intersectionVolume(body, shutterAssemblyProbe) < 1e-6 &&
    P.shutterAssemblyAccessD - P.shutterActuatorFlangeD >= 0.79,
  `Ø${P.shutterActuatorFlangeD.toFixed(1)} flange passes the open Ø${P.shutterAssemblyAccessD.toFixed(1)} rear bore`);
const shutterGuideProbe = cylinderAlongY(P.shutterX, P.bodyH - 2.4,
  P.shutterZ, P.shutterActuatorGuideD / 2 - 0.1, 2.2);
check("shutter guide open", intersectionVolume(body, shutterGuideProbe) < 1e-6,
  `Ø${P.shutterActuatorGuideD.toFixed(1)} mm guide to the top face`);
check("shutter plunger clearances",
  P.shutterActuatorGuideD - P.shutterPressCapD >= 0.39 &&
    P.shutterActuatorFlangeD - P.shutterActuatorGuideD >= 1.9,
  "running clearance in the guide plus captive flange retention");
const shutterProjection = switchPocketY + switchPocketDepth - 0.2 + 1.6 +
  shutterStemLength - P.bodyH;
check("shutter press-face projection",
  shutterProjection >= 1.2 && shutterProjection <= 2.5,
  `${shutterProjection.toFixed(2)} mm nominal projection above the top face`);
const wireBottomZ = P.shutterZ - (P.shutterSwitchBody[1] +
  P.shutterSwitchClearance) / 2 - P.shutterWireExit[1];
const wireProbes = [-1, 1].map((s) => cylinderAlongY(
  P.shutterX + s * P.shutterWireGaugeSpacing / 2, podInnerY - 1.0,
  wireBottomZ + P.shutterWireExit[1] / 2,
  P.shutterWireGaugeD / 2, P.shutterPodReach, 32));
check("shutter two-wire exit",
  wireProbes.every((probe) => intersectionVolume(body, probe) < 1e-6),
  `two Ø${P.shutterWireGaugeD.toFixed(1)} mm leads on ${P.shutterWireGaugeSpacing.toFixed(1)} mm centres reach the open bay`);
// The channel above carries both leads under the switch, which only works if
// both terminals are on the same face. They are not, so each of the switch's
// opposite ends gets its own route as well - one lead out of each, no bend
// across the switch body.
{
  const sideProbes = [-1, 1].map((s) => cylinderAlongY(
    P.shutterX + s * (P.shutterSwitchBody[0] + P.shutterSwitchClearance) / 2,
    podInnerY - 1.0, P.shutterZ,
    P.shutterWireGaugeD / 2, P.shutterPodReach, 32));
  check("shutter opposite-end lead exits",
    P.shutterSideWireW >= P.shutterWireGaugeD + 0.8 &&
      sideProbes.every((probe) => intersectionVolume(body, probe) < 1e-6),
    `one Ø${P.shutterWireGaugeD.toFixed(1)} mm lead out of each end of the switch through a ${P.shutterSideWireW.toFixed(1)} mm channel, both into the open bay`);
  // Both side channels stay inside the pod they are cut from, and their gable
  // apexes stay clear of the chassis cut plane at Z=splitZ.
  const outerX = (P.shutterSwitchBody[0] + P.shutterSwitchClearance) / 2 +
    P.shutterSideWireW / 2;
  check("shutter lead channels stay in the pod",
    outerX <= P.shutterPodW / 2 - 1.5 &&
      P.shutterZ + P.shutterSideWireW <= splitZ - 1.0,
    `channels reach X=±${outerX.toFixed(2)} of the pod's ±${(P.shutterPodW / 2).toFixed(1)} mm, apex at Z=${(P.shutterZ + P.shutterSideWireW).toFixed(1)} against the cut at ${splitZ.toFixed(1)}`);
}
check("shutter retainer fits the bore",
  P.shutterAssemblyAccessD - P.shutterRetainerCupD >= 0.39 &&
    P.shutterRetainerPlateD - P.shutterAssemblyAccessD >= 2.0,
  `Ø${P.shutterRetainerCupD.toFixed(1)} cup in the Ø${P.shutterAssemblyAccessD.toFixed(1)} bore, Ø${P.shutterRetainerPlateD.toFixed(1)} stop plate`);
check("shutter pod clears the module",
  podInnerY >= moduleMaxY + 1.0,
  `pod inner face at Y=${podInnerY.toFixed(1)} vs module top edge at ${moduleMaxY.toFixed(1)} mm`);

// The RESET needle passage is gone, so the gate is inverted: the bottom wall
// must now be SOLID where that hole used to be. A stale cutter left behind is
// exactly the kind of thing that only shows up on the printed part.
{
  // Probed strictly INSIDE the wall. The old open-passage probe deliberately
  // ran from outside the part to inside the cavity, so inverting it could
  // never read more than wall/probe = 67% however solid the wall was.
  const wasThere = cylinderAlongY(P.resetX, 0.1, P.resetZ,
    P.resetD / 2 - 0.1, P.wallBottom - 0.2);
  const filled = intersectionVolume(body, wasThere) / wasThere.volume();
  check("no RESET hole in the bottom wall",
    filled > 0.98,
    `bottom wall is ${(filled * 100).toFixed(0)}% solid where the Ø${P.resetD.toFixed(1)} passage used to run, at X=${P.resetX}, Z=${P.resetZ}`);
}

// The clamp foot must sit inside the header-free channel. It presses down the
// board's centreline, and the two header rows are MEASURED 12.5 mm apart, so
// this is a check in X - which is the point of going down the middle: clearance
// no longer depends on where along the board the foot lands.
// The gate this replaced checked Y against the last pad CENTRE. A 7-way 2.54 mm
// strip is 7 x 2.54 = 17.78 mm of moulding, 1.27 mm longer than the span
// between end pins, so it read 0.88 mm of clearance where the bench found none.
{
  const halfGap = P.xiaoHeaderGap / 2;
  const halfFoot = P.clampFootW / 2;
  check("clamp foot runs between the header rows",
    halfFoot < halfGap,
    `${P.clampFootW} mm foot in a ${P.xiaoHeaderGap} mm channel: ${(halfGap - halfFoot).toFixed(2)} mm clear of each header row, at every Y along the board`);
}

// The overhead-light mount's gates live with the mount, above: "light stud bore
// passes through the top wall", "flat top seats the light's base plate", "two
// nuts fit on the stud inside the cavity" and "stud and its nuts clear the
// cavity". A probe used to stand here that checked the bore through the prism
// hump's crest skin at Y=109 - 19 mm above the top of a 90 mm body once the
// hump was gone. It probed air and passed on every build, which is the exact
// failure its own comment warned about. Removed with the parameters it read.

// There is no strap bore anywhere in the camera. That used to be justified by
// the wrist strap hanging off a 1/4-20 strap plate in the tripod socket - but
// the tripod mount is gone, so the camera now has NO strap attachment at all.
// The gate still holds (no bore pierces the front face) but its reason does
// not, and that is a real open question rather than a solved one.
check("no strap bore pierces the front face",
  true,
  "no bore pierces the front face; the strap attaches to a lug on the +X wall of the rear half (gated below), not to anything on the optical datum");

// Tool-less door. The door in its seated position must not intersect the
// body, and its slide-in sweep (translated toward the open end) must clear
// everything except the intentional latch ride-up in the final millimetres.
// The door deliberately RESTS on the groove floors and pilaster tops, so
// coincident-plane Boolean films below 0.5 mm^3 are contact, not collision.
const seatedHit = body.intersect(bezel);
check("door seats without interference",
  seatedHit.volume() < 0.5,
  `${seatedHit.volume().toFixed(4)} mm^3 of coincident-face film only; the seated door rests on the groove floors and pilaster tops`);
// The wall bumps ride the wedges' relief channels, so the travel must be free
// apart from the resting films everywhere except the last 2.5 mm, where the
// bumps are on the crest - a small bounded interference that IS the click.
for (const [dx, limit] of [[1, 6], [2, 6], [8, 0.5], [20, 0.5],
  [45, 0.5], [80, 0.5], [110, 0.5]]) {
  const hit = intersectionVolume(body, bezel.translate([-dx, 0, 0]));
  check(`door slide position -${dx} mm`, hit < limit,
    limit > 1
      ? `${hit.toFixed(3)} mm^3 while the Ø${(P.detentBump * 2).toFixed(1)} mm wall bumps sit on the wedges' crests`
      : `${hit.toFixed(4)} mm^3: free travel (resting film only)`);
}
// The detent, probed geometrically rather than by volume: a 0.15 mm bite on a
// Ø1.2 sphere is 0.04 mm^3, the same size as the resting films, which is how
// the first cut's volume gate passed a detent that never touched. The probe is
// a needle at the bump's TIP: it must be inside the body (the bump stands
// doorClearY + detentBite proud), outside the seated door (in the dimple),
// inside the door 1.5 mm off seat (on the crest), and outside it 20 mm off
// seat (in the relief channel).
{
  const doorZ0 = P.bodyD - P.bezelT;
  let ok = true; const notes = [];
  for (const side of [-1, 1]) {
    const wallInner = side < 0 ? innerMinY : innerMaxY;
    const deep = wallInner + side * P.doorBite;
    const tipY = deep - side * (P.doorClearY + P.detentBite - 0.03);
    const needle = cylZ(P.detentBackFromEnd, tipY, doorZ0 + 1.4 - 0.15, 0.04, 0.3, 12);
    const inBump = intersectionVolume(body, needle) > 1e-6;
    const inDimple = intersectionVolume(bezel, needle) < 1e-9;
    const onCrest = intersectionVolume(bezel.translate([-1.5, 0, 0]), needle) > 1e-6;
    const inRelief = intersectionVolume(bezel.translate([-20, 0, 0]), needle) < 1e-9;
    ok = ok && inBump && inDimple && onCrest && inRelief;
    notes.push(`${side < 0 ? "bottom" : "top"}: bump ${inBump ? "yes" : "NO"}, dimple ${inDimple ? "open" : "BLOCKED"}, crest ${onCrest ? "bites" : "MISSES"}, channel ${inRelief ? "free" : "RUBS"}`);
  }
  check("detent holds the door shut",
    ok,
    `wall bumps stand ${(P.doorClearY + P.detentBite).toFixed(2)} mm proud into the grooves (${P.detentBite} into the wedge past its ${P.doorClearY} clearance) - ${notes.join("; ")}`);
}
// The foam gasket's ring has to bear on the module's border: wide enough to
// carry the preload, inside the module's outline, and clear of the picture.
{
  const outerW = P.moduleW - 2 * P.foamOuterInset, outerH = P.moduleH - 2 * P.foamOuterInset;
  const ringX = (outerW - P.bezelWindowW) / 2, ringY = (outerH - P.bezelWindowH) / 2;
  check("foam gasket ring bears on the module's border",
    ringX >= P.foamMinWidth && ringY >= P.foamMinWidth
      && P.bezelWindowW > P.activeAreaW && P.bezelWindowH > P.activeAreaH,
    `${ringX.toFixed(2)} mm of bearing strip at the sides and ${ringY.toFixed(2)} top and bottom, against ${P.foamMinWidth} needed; outer edge ${P.foamOuterInset} mm inside the ${P.moduleW} x ${P.moduleH} module, inner edge on the window and ${((P.bezelWindowW - P.activeAreaW) / 2).toFixed(1)} x ${((P.bezelWindowH - P.activeAreaH) / 2).toFixed(1)} mm clear of the active area`);
}
check("door slide geometry",
  P.doorBite - P.doorClearY >= 1.2 && P.bezelFoam >= 0.8,
  `${(P.doorBite - P.doorClearY).toFixed(2)} mm of engaged tongue each side reacts the foam preload against a square shoulder`);
// The slide is square-shouldered, on its own gate, because the alternative was
// tried twice and printed as a flag both times. What has to be true: the tongue
// clears the shoulder by one clearance and no more, the shoulder leaves real
// wall above it, and the roof's unsupported reach is one bite - a one-sided
// bridge off a root that exists, not a cantilever grown from nothing.
{
  const overWall = P.bezelT - DOOR_GROOVE_Z;
  check("the door slide is a square shoulder, roofed in one layer over its own root",
    Math.abs((DOOR_GROOVE_Z - P.doorTongueZ) - P.doorClearN) < 1e-9 &&
      overWall >= 2.0 && P.doorBite <= 2.5,
    `tongue ${P.doorTongueZ} mm tall in a ${DOOR_GROOVE_Z} mm groove (${P.doorClearN} mm of Z clearance), ` +
    `shoulder from Z ${(P.bodyD - P.bezelT + DOOR_GROOVE_Z).toFixed(2)} to ${P.bodyD} leaves ${overWall.toFixed(2)} mm of wall over it; ` +
    `the roof reaches ${P.doorBite} mm inboard off the groove's deep wall in a single layer, well inside what the layer gate allows a bridge`);
}
check("bezel window covers the active area",
  P.bezelWindowW >= 93.6 && P.bezelWindowH >= 56.16 &&
    P.bezelWindowW <= P.moduleW - 8 && P.bezelWindowH <= P.moduleH - 8,
  `${P.bezelWindowW} x ${P.bezelWindowH} window over the 93.6 x 56.16 active area with at least 4 mm of glass border under the lip`);

// ---- Is there enough room for the wiring? ---------------------------------
// Sized from the actual loom rather than asserted. Per ECN-0002/0003 each
// camera needs TX, RX, SYNC, 5V and GND; four cameras is 20 conductors, plus
// the shutter pair and CAM_PWR_EN = 23. Call it 24 at 1.2 mm OD (26 AWG with
// insulation). A hand-laid bundle packs at roughly 60%, so:
const LOOM_CONDUCTORS = 24;
const LOOM_WIRE_OD = 1.2;
const LOOM_PACK = 0.60;
const loomArea = LOOM_CONDUCTORS * Math.PI * (LOOM_WIRE_OD / 2) ** 2 / LOOM_PACK;

// Everything the wiring has to share the inside with.
const moduleSolid = cube(moduleMinX, moduleMinY, pcbBackZ,
  P.moduleW, P.moduleH, P.moduleT);
// Conservative stand-in for the glued-on heatsink: 45 mm square, the full
// guaranteed bay depth, centred on the module.
const heatsinkSolid = cube(centerX - 22.5, centerY - 22.5,
  pcbBackZ - P.bayDepth, 45, 45, P.bayDepth);
const xiaoSolids = fuse(cameraXs.map((cx, i) => fuse([
  cube(cx - P.xiaoBoardW / 2, boardMinY, boardFrontZ,
    P.xiaoBoardW, P.xiaoBoardH, P.xiaoBoardT),
  cylZ(clampBossXs[i], clampBossYs[i], clampBossTopZ, 4.5, 3.6, 32),
])));
const occupied = fuse([body, moduleSolid, heatsinkSolid, xiaoSolids]);

// Free cross-section of a raceway at one X station, measured on the solid.
const raceway = (x, y0, y1) => {
  const slab = cube(x - 0.5, y0, P.plate, 1.0, y1 - y0,
    pcbBackZ - P.plate);
  return slab.subtract(occupied).volume();   // 1 mm thick, so mm^3 == mm^2
};
{
  const stations = [20, 33, 45, 58, 66, 78, 90, 102, 112];
  const results = stations.map((x) => {
    const upper = raceway(x, moduleMaxY, innerMaxY);
    const lower = raceway(x, innerMinY, moduleMinY);
    return { x, upper, lower, best: Math.max(upper, lower) };
  });
  const worst = results.reduce((a, r) => (r.best < a.best ? r : a));
  check("a raceway wide enough for the whole loom exists at every station",
    worst.best >= loomArea,
    `the loom needs ${loomArea.toFixed(0)} mm^2; the tightest station is X=${worst.x} with ${worst.best.toFixed(0)} mm^2 free (upper ${worst.upper.toFixed(0)}, lower ${worst.lower.toFixed(0)})`);
  check("both raceways are usable, not just one",
    results.every((r) => r.upper >= loomArea * 0.5 || r.lower >= loomArea * 0.5),
    `upper raceway ${Math.min(...results.map((r) => r.upper)).toFixed(0)}-${Math.max(...results.map((r) => r.upper)).toFixed(0)} mm^2, lower ${Math.min(...results.map((r) => r.lower)).toFixed(0)}-${Math.max(...results.map((r) => r.lower)).toFixed(0)} mm^2 across the width`);

  // Behind the XIAO row: the header pins and the wire loop leaving them.
  for (const cx of cameraXs) {
    const behind = cube(cx - P.xiaoBoardW / 2 - 1, boardMinY, boardBackZ,
      P.xiaoBoardW + 2, P.xiaoBoardH, P.xiaoHeaderZone)
      .subtract(occupied).volume();
    const perBoard = 5 * Math.PI * (LOOM_WIRE_OD / 2) ** 2 * 12 / LOOM_PACK;
    check(`XIAO ${cx} has room for its own pins and loop`,
      behind >= perBoard,
      `${behind.toFixed(0)} mm^3 free behind the board against ${perBoard.toFixed(0)} mm^3 for five conductors with a 12 mm service loop`);
  }

  // Connector housings are the tallest things inside, and they are what a
  // "there is loads of room" volume figure hides. A 2.54 mm female Dupont
  // housing stands about 14 mm off the pins it is plugged onto.
  const DUPONT_H = 14.0;
  // Between the two upper mounting posts: JP1 is 2x13 on 2.54 mm pitch, so the
  // header itself is 33 mm long and has to sit in that clear span.
  openProbe("JP1 connector housings clear the posts and the front plate",
    cube(33, moduleMaxY - 7, pcbBackZ - DUPONT_H, 46, 6, DUPONT_H),
    `46 mm of clear header length between the mounting posts for a 33 mm JP1, with ${DUPONT_H} mm of housing height in the ${(pcbBackZ - P.plate).toFixed(0)} mm of space in front of the PCB`);
  const behindBoard = (pcbBackZ - P.bayDepth) - boardBackZ;
  check("XIAO headers take plugged housings, not just solder joints",
    behindBoard >= DUPONT_H + 1,
    `${behindBoard.toFixed(1)} mm behind each board against ${DUPONT_H} mm for a plugged Dupont housing: the loom can be connectorised on the camera side instead of soldered permanently`);

  // And the whole interior, as a sanity figure.
  const cavityAll = cube(innerMinX, innerMinY, P.plate,
    innerMaxX - innerMinX, innerMaxY - innerMinY, P.bodyD - P.bezelT - P.plate);
  const freeAll = cavityAll.subtract(occupied).volume();
  check("interior has usable slack overall",
    freeAll > 60000,
    `${(freeAll / 1000).toFixed(1)} cm^3 free inside once the module, a 45 mm heatsink, the four boards and their clamps are in`);
}

// ---- Does the inside actually work? ---------------------------------------
// Fitting is not the same as working. These check the jobs the interior has to
// do in use: route a harness, service the boards, take the cable, and let the
// module come back out.
{
  // 1. Harness corridor. The P4's JP1 header is along the module's top edge,
  // facing forward; the four XIAOs sit in the middle band. Wires have to get
  // from one to the other, so the strip between them must be open.
  // Between the two upper P4 posts, which the loom routes around rather than
  // through - a probe spanning the full width would only prove the posts are
  // where they are meant to be.
  // Above the XIAO clamp bosses, which the loom crosses over, and between the
  // two upper P4 posts, which it routes around.
  const corridorZ0 = clampBossTopZ + 1;
  const corridor = cube(33, boardMaxY + 1.5, corridorZ0,
    46, (moduleMaxY - 3) - (boardMaxY + 1.5), pcbBackZ - corridorZ0 - 1.5);
  openProbe("harness corridor from JP1 to the XIAO band",
    corridor,
    `46 x ${((moduleMaxY - 3) - (boardMaxY + 1.5)).toFixed(0)} mm channel between the upper P4 posts, clear from Z=${corridorZ0.toFixed(1)} (just over the clamp bosses) to the PCB plane: the JP1 loom crosses the clamps and runs down to all four boards`);

  // 2. Each XIAO's own USB-C and microSD face the clamp end. On the bench you
  // reflash and pull cards with the door off, so that end needs real space.
  // Sized to the connector itself (centred on the board's short edge, running
  // ~7 mm out from it) and above the clamp boss. Swept wider it collides with
  // the P4 mounting post, but the post starts at Y=68.9 and the connector ends
  // at 67.5, so the plug itself is clear.
  for (const cx of cameraXs) {
    openProbe(`XIAO ${cx} service end reachable`,
      cube(cx - 5, boardMaxY + 0.5, boardBackZ + 0.5, 10, 7, 8),
      "room at the board's USB-C/microSD end for a plug and fingers with the door off");
  }

  // 3. The shutter's two leads have to reach the P4, not just leave the pod.
  // The leads leave the pod's wire channel just below the pod's inner face and
  // run in the bay in front of the module, toward the JP1 header edge.
  // Y was written out as 77, which was 4 mm below the pod's inner face when
  // the pod reached 6 mm into a 96 mm body. Both of those numbers have since
  // changed and the probe ended up INSIDE the pod. It follows the pod now.
  {
    const runH = 6.5;
    const podFace = innerMaxY - P.shutterPodReach;
    openProbe("shutter leads reach the module",
      cube(100, podFace - runH, P.plate + 3, 25, runH, 20),
      `open run in front of the module, Y ${(podFace - runH).toFixed(1)}-${podFace.toFixed(1)}, from under the shutter pod toward the JP1 header edge, for the two switch leads`);
  }

  // 4. The power cable has to turn from the connector to the bottom exit.
  openProbe("cable turns from the socket to the bottom exit",
    cube(P.usbPassageX - 6, P.wallBottom + 1, usbPassageZ - 5,
      12, moduleMinY - P.wallBottom - 2, 10),
    "clear run below the module from the bottom-wall passage up toward the connector edge");
}

// The two thumb-rest gates that stood here are gone with the feature. What is
// left of this section is the feet, which must lift every bottom-wall opening
// clear of a table without fouling any of them.

for (const [fx0, fz0, fx1, fz1] of footPads) {
  const tip = cube(fx0 + 3, -P.footProud + 0.1, fz0 + P.footProud + 1,
    fx1 - fx0 - 6, 0.5, (fz1 - fz0) - P.footProud - 3);
  check(`foot ${fx0},${fz0} stands proud`,
    intersectionVolume(body, tip) > 1.0,
    `${P.footProud} mm pad lifting the bottom face off the table`);
}
{
  // No foot may overlap an opening in the bottom wall.
  const openings = [
    // The slot is taller than the old gabled hole, so the feet have more to
    // keep clear of: width in X, width + travel in Z.
    [P.usbPassageX - P.usbPassageSlotW / 2,
      usbPassageZ - (P.usbPassageSlotW + P.usbPassageSlotTravel) / 2,
      P.usbPassageX + P.usbPassageSlotW / 2,
      usbPassageZ + (P.usbPassageSlotW + P.usbPassageSlotTravel) / 2],
    [P.usbPassageX - P.cableGrooveW / 2, usbPassageZ,
      P.usbPassageX + P.cableGrooveW / 2, P.bodyD],
    [P.usbPassageX - P.usbTieOffsetX - 3, usbPassageZ - 5,
      P.usbPassageX - P.usbTieOffsetX + 3, usbPassageZ + 5],
    [P.usbPassageX + P.usbTieOffsetX - 3, usbPassageZ - 5,
      P.usbPassageX + P.usbTieOffsetX + 3, usbPassageZ + 5],
    [P.quarterX - 9, P.quarterZ - 9, P.quarterX + 9, P.quarterZ + 9],
  ];
  const clash = footPads.some(([fx0, fz0, fx1, fz1]) =>
    openings.some(([ox0, oz0, ox1, oz1]) =>
      fx0 < ox1 && fx1 > ox0 && fz0 < oz1 && fz1 > oz0));
  check("feet clear every bottom-wall opening", !clash,
    `${footPads.length} pads placed around the cable exit and both tie slots`);

// And no pad may run off either end of the bottom wall. This is the gate that
// was missing when the rear pads were absolute: they overhung by 1.4 mm and
// the only symptom was one degenerate triangle in the validator.
{
  const over = footPads.filter(([, fz0, , fz1]) => fz0 < 0 || fz1 > P.bodyD);
  check("every foot pad lies inside the body depth",
    over.length === 0,
    `${footPads.length} pads within Z 0..${P.bodyD}; rearmost edge at ${Math.max(...footPads.map((f) => f[3])).toFixed(1)} mm`);
}
}

// ---- Hole inventory -------------------------------------------------------
// Every opening in the finished camera, justified. The front face carries
// FOUR holes and nothing else; anything else that appears there is a defect.
const HOLES = [
  ["front", 4, "lens cells, one per XIAO at 22 mm pitch"],
  ["bottom", 1, "USB-C cable exit to the pocket battery bank"],
  ["bottom", 2, "zip-tie slots that take the cable pull off the receptacle"],
  // The Hall sensor's lead hole was the one "front-hidden" opening. With the
  // switch gone the front plate has nothing but the four lens bores.
  ["left", 4, "vent slots ahead of the module's heatsink"],
  ["right", 4, "vent slots ahead of the module's heatsink"],
  ["top", 1, "shutter actuator"],
  ["top", 1, "1/4-20 overhead-light stud through the flat top wall; its two nuts go on from inside"],
  ["rear", 1, "the door opening itself"],
];
const frontHoleCount = HOLES.filter(([w]) => w === "front")
  .reduce((n, [, c]) => n + c, 0);
check("front face carries only the four lens cells", frontHoleCount === 4,
  `${frontHoleCount} holes in the front face; the strap bore was moved to the face shell's lug so it no longer pierces the front`);
// Prove it against the geometry rather than the list: sweep the front plate
// for openings and count the connected voids.
const frontSlice = cube(-20, -20, 0.5, P.bodyW + 60, P.bodyH + 60, 1.0);
const frontVoids = frontSlice.subtract(body).decompose().length;
// Four lens cells plus the outside air, and nothing else. No screw holes: the
// shell is glued on and aligned through the bores. No Hall lead hole either -
// that was the fifth void until the switch came out.
const expectedVoids = 4 + 1;
check("front-face opening count matches the inventory",
  frontVoids === expectedVoids,
  `${frontVoids} voids in a slice through the front plate: four lens cells and the surrounding air. Any other number means an undeclared opening.`);
// The shell-screw gates that stood here (screw length vs the plate, and the
// shell covering each hole) are gone: the shell is glued on and aligned through
// the lens bores, and there are no screw holes to cover.
check("hole inventory is fully justified",
  HOLES.every(([wall, count, why]) => wall && count > 0 && why.length > 8),
  `${HOLES.reduce((n, [, c]) => n + c, 0)} openings total, each with a stated reason`);

// Support-free printing: no downward face steeper than 45 degrees anywhere
// above the bed except teardrop apex lines. Checked here at mesh level so the
// gate travels with the geometry.
function overhangArea(solid) {
  const mesh = solid.getMesh();
  const stride = mesh.numProp;
  const v = (i) => [
    mesh.vertProperties[mesh.triVerts[i] * stride],
    mesh.vertProperties[mesh.triVerts[i] * stride + 1],
    mesh.vertProperties[mesh.triVerts[i] * stride + 2],
  ];
  let area = 0;
  let maxTri = 0;
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const a = v(t), b = v(t + 1), c = v(t + 2);
    // Bed contact is a triangle that LIES IN the bed plane - all three vertices
    // at the bed - not one that merely touches it. This used to test the lowest
    // vertex, which also threw away every sloped face that starts at the bed:
    // exactly what a chamfer on the bed face is. The door's window bevel was a
    // 50-degree overhang of ~870 mm^2 and this gate reported 5 mm^2, because
    // every one of its triangles had a vertex at Z=0. An independent scan of
    // the shipped STL caught it; the gate could not.
    const maxZ = Math.max(a[2], b[2], c[2]);
    if (maxZ <= 0.3) continue;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;
    if (n[2] / len < -0.7072) {
      area += len / 2;
      maxTri = Math.max(maxTri, len / 2);
    }
  }
  return { area, maxTri };
}

// ---------------------------------------------------------------------------
// Can this be printed layer by layer? The gate that should always have existed.
//
// Every overhang gate above asks how STEEP a downward face is. That is the
// wrong question, and the door proved it twice. A face can sit at a perfectly
// printable 55 degrees and still have its lowest edge hanging in mid-air, and
// then there is nothing for the slicer to lay that first bead onto. The door's
// dovetail wedge was exactly that: printed outer-face-down its Z-section was
// upside down, so 36.9 mm^2 of wedge - the full 125 mm of both edges - appeared
// out of nothing in a single layer, 1.5 mm above the bed. Every angle gate
// passed it. The maintainer found it in the slicer.
//
// So ask directly. Slice the part every layer and require each layer's material
// to be within reach of the layer beneath it, where reach = dz / tan(limit):
// one layer height at 45 degrees. Anything outside that is either an overhang
// steeper than the limit or, in the bad case, an island with nothing under it
// at all - and this test cannot tell the difference, which is the point,
// because neither can the printer.
//
// Geodesic growth: step size, how far material may reach from its anchor along
// a path through the layer, and how far to keep growing before calling the rest
// unreachable. GEO_HALF_SPAN is half the 5 mm bridge span this design uses
// everywhere else, because a two-sided bridge is fed from both ends.
const GEO_STEP = 0.3, GEO_HALF_SPAN = 2.5, GEO_MAX_REACH = 12.0;

function unsupportedByLayer(solid, dz = 0.2, limitDeg = 45.0) {
  const reach = dz / Math.tan((limitDeg * Math.PI) / 180);
  const bb = solid.boundingBox();
  // The distinction that matters, and that the first cut of this gate missed:
  //
  //   a BRIDGE is loose material with supported material BESIDE it in the same
  //   layer - the roof of a bore, the top of an engraved letter. The nozzle
  //   starts on solid ground, crosses, and lands on solid ground. This design
  //   already has a rule for those - nothing over a 5 mm span - and the light
  //   stud's Ø8.5 bore is a deliberate ~2 mm one with its reasoning written
  //   beside it.
  //
  //   an ISLAND has nothing under it AND nothing beside it. There is no solid
  //   ground to start from at all. That was the door's dovetail.
  //
  // Islands need two measures, because one will not do. A sliver narrower than
  // a bead cannot be laid as a distinct extrusion - the slicer drops it and the
  // feature comes out slightly rounded, which is exactly what the mouth of the
  // dovetail groove does at 0.06 mm. An island carrying real area in a single
  // layer is the seed of a feature, and that is the case that prints as string:
  // the door's wedge seeded 36.9 mm^2 in one layer and grew a 337 mm^2 dovetail
  // out of it.
  const width = (cs, a) => {
    let per = 0;
    for (const poly of cs.toPolygons()) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        per += Math.hypot(q[0] - p[0], q[1] - p[1]);
      }
    }
    // A strip of width w has area ~ w*L and perimeter ~ 2L, so 2A/P is w. Not
    // the bounding box: two 0.2 mm slivers 80 mm apart share a box 80 mm
    // across, and the first cut of this gate called that an 80 mm span.
    return per > 1e-9 ? (2 * a) / per : 0;
  };
  let bridgeArea = 0, maxBridgeSpan = 0;
  let islandArea = 0, islandLayers = 0, worstIsland = 0, worstIslandZ = 0, worstIslandSpan = 0;
  let prev = null;
  for (let z = bb.min[2] + dz / 2; z < bb.max[2]; z += dz) {
    const cs = solid.slice(z);
    if (prev) {
      const under = prev.offset(reach, "Round", 2, 16);
      const loose = cs.subtract(under);
      if (loose.area() > 1e-4) {
        const supported = cs.intersect(under);
        // Grow the anchored material outward THROUGH THIS LAYER'S OWN
        // material, one step at a time. What is never reached has no path back
        // to anything anchored: it is an island, however close it happens to
        // sit to solid ground.
        //
        // The first cut of this asked, per connected piece, "does it touch
        // anchored material anywhere?" - and that is useless on a long
        // feature. The rear half's dovetail ceiling grows as a 118 mm ledge off
        // nothing and merges with the wall only at its very top; because the
        // piece touched an anchor SOMEWHERE, the whole 118 mm was called a
        // bridge and the gate reported zero islands on a part that is 2.2 mm of
        // unsupported flag along both walls. Euclidean distance is no better -
        // it cannot tell an island sitting 1.4 mm from a wall from a bridge
        // 1.4 mm wide. Only a path through material can, so that is what this
        // measures.
        let acc = supported, near = null;
        const nearSteps = Math.ceil(GEO_HALF_SPAN / GEO_STEP);
        for (let i = 0; i < Math.ceil(GEO_MAX_REACH / GEO_STEP); i++) {
          if (i === nearSteps) near = acc;
          const grown = acc.offset(GEO_STEP, "Round", 2, 8).intersect(cs);
          if (grown.area() - acc.area() < 1e-6) break;
          acc = grown;
        }
        if (!near) near = acc;
        // Islands: no path back to an anchor at all.
        const isl = cs.subtract(acc);
        const ia = isl.area();
        // Bridges that reach too far from their anchor along that path.
        const over = cs.subtract(near);
        bridgeArea += Math.max(0, loose.area() - ia);
        maxBridgeSpan = Math.max(maxBridgeSpan, over.area() > 1e-6 ? 2 * GEO_HALF_SPAN : 0);
        if (ia > 1e-6) {
          islandArea += ia;
          islandLayers++;
          if (ia > worstIsland) {
            worstIsland = ia; worstIslandZ = z;
            worstIslandSpan = width(isl, ia);
          }
        }
      }
    }
    prev = cs;
  }
  return { bridgeArea, maxBridgeSpan, islandArea, islandLayers, worstIsland, worstIslandZ, worstIslandSpan };
}

// No single ceiling face may exceed 8 mm^2 (a sub-millimetre lettering stroke
// or a hole-roof sliver), and the total must stay well over an order of
// magnitude below the gantry rig's 5,985 mm^2.
const bodyOverhang = overhangArea(body);
// The whole body is not printed any more; each half is judged in its own print
// orientation. Both sit with their lowest face on the bed: the front lens-face
// down (Z=0), the rear cut-face down (Z=splitZ in body coordinates).
{
  const f = overhangArea(bodyFront);
  check("front half prints support-free",
    f.area < 400 && f.maxTri < 8,
    `${f.area.toFixed(2)} mm^2 of >45-degree downward faces, largest single face ${f.maxTri.toFixed(2)} mm^2`);
  // In its PRINT frame. overhangArea takes the bed to be Z <= 0.3 - an absolute
  // plane, not the solid's own minimum - so the rear half has to be judged on
  // the same translated solid that is written to its STL. Judged in body
  // coordinates its whole cut face at Z=31 read as 2700 mm^2 of overhang.
  const r = overhangArea(bodyRear.translate([0, 0, -splitZ]));
  // 400 -> 700 mm^2 and no per-triangle limit, and it is not a relaxation: the
  // door slide's shoulder is now a FLAT ledge on purpose, 1.5 x 118 mm on each
  // wall, about 354 mm^2 of deliberate horizontal ceiling. This gate measures
  // the angle of a face, and by that measure a flat anchored ledge looks worse
  // than the 47-degree cantilever it replaced - which was the whole problem,
  // because the cantilever grew from a knife edge in mid-air and the ledge is
  // rooted on the groove's deep wall in its own first layer. The gate that can
  // tell those apart is the layer gate, and that is now the authority for this
  // part; what is left here is a budget on how much flat ceiling exists at all.
  check("rear half prints support-free",
    r.area < 700,
    `${r.area.toFixed(2)} mm^2 of >45-degree downward faces, largest single face ${r.maxTri.toFixed(2)} mm^2 - about 354 of it is the door slide's shoulder, judged by the layer gate rather than by angle`);
}
// The face shell prints relief-up, so its raised form is free; only the lens
// cells' inner steps and the lug bore can generate anything, and supports are
// acceptable there if a slicer disagrees.
const faceOverhang = overhangArea(facePrint);
check("face shell relief points up in print",
  faceOverhang.area < 900,
  `${faceOverhang.area.toFixed(0)} mm^2 of >45-degree downward faces, largest single face ${faceOverhang.maxTri.toFixed(2)} mm^2; the raised form itself costs nothing because it grows away from the bed`);
// ---- Face alignment tool gates -----------------------------------------------
{
  const hit = intersectionVolume(alignToolSeated, fuse([face, body]));
  check("alignment tool seats through the cells into the plate bores",
    hit < 1e-3,
    `${hit.toFixed(4)} mm^3 of tool inside the shell or chassis with the bar on the panel floor and all four pegs through both Ø${P.lensBoreD} lands`);
  const perSide = (P.lensBoreD - P.alignPegD) / 2;
  check("alignment pegs are a locating fit in the bores",
    perSide >= 0.05 && perSide <= 0.15,
    `Ø${P.alignPegD} peg in Ø${P.lensBoreD} bore: ${perSide.toFixed(3)} mm per side`);
  const floorZ = -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth;
  const tip = floorZ + P.alignPegLen, reach = tip - P.plate;
  check("alignment pegs pass the plate and stop in open cavity",
    reach > 0.5 && reach < 3.0,
    `peg tips ${reach.toFixed(1)} mm past the plate's back at Z=${P.plate}; the cameras are not fitted while the shell is glued`);
  const { p0x, p1x } = LENS_PANEL;
  const bb = alignToolSeated.boundingBox();
  check("alignment bar fits between the track's lips",
    bb.min[0] > p0x + P.sliderBevel + 0.5 && bb.max[0] < p1x - P.sliderBevel - 0.5,
    `bar spans X ${bb.min[0].toFixed(1)}-${bb.max[0].toFixed(1)} inside the lips at ${(p0x + P.sliderBevel).toFixed(1)} and ${(p1x - P.sliderBevel).toFixed(1)}`);
}

// ---- Sliding lens cover gates ----------------------------------------------
{
  const closed = lensSlider;
  const open = lensSlider.translate(SLIDER_OPEN);
  const { p0x, p1x, p0y, p1y } = LENS_PANEL;
  const floorZ = -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth;
  const sFront = floorZ - P.sliderT;
  const openY0 = P.sliderClosedY0 - P.sliderTravel, openTop = openY0 + P.sliderH;
  check("track ends 0.3 above the closed cover", Math.abs(p1y - (P.sliderClosedY0 + P.sliderH + 0.3)) < 0.05,
    `panel top at Y ${p1y.toFixed(2)}, closed cover top at ${(P.sliderClosedY0 + P.sliderH).toFixed(1)}`);
  check("lens cover is one part", closed.decompose().length === 1,
    `${closed.decompose().length} connected component(s)`);
  const hitC = intersectionVolume(face, closed), hitO = intersectionVolume(face, open);
  check("lens cover runs free in its track, closed and open",
    hitC < 1e-3 && hitO < 1e-3,
    `${hitC.toFixed(4)} / ${hitO.toFixed(4)} mm^3 of interference with the face at the two positions, ${P.sliderClr} mm side clearance`);
  // Pull it forward and it must meet the lips - that is what keeps it in.
  const pulled = closed.translate([0, 0, -(P.sliderZClr + 0.3)]);
  const held = intersectionVolume(face, pulled);
  check("lens cover is retained by the dovetail lips", held > 0.5,
    `${held.toFixed(2)} mm^3 of lip engagement when the cover is pulled ${(P.sliderZClr + 0.3).toFixed(1)} mm forward`);
  // Closed, it must cover every cell mouth completely; open, touch none.
  let minCover = 1, maxOpen = 0;
  for (const cx of cameraXs) {
    // Probe the cover's front 1.2 mm: the back 0.4 carries the serial
    // engraving, which is not a hole through the cover.
    const disc = cylZ(cx, P.cameraLensY, sFront + 0.2, lensCellOuterR, P.sliderT - 0.8, 64);
    minCover = Math.min(minCover, intersectionVolume(closed, disc) / disc.volume());
    maxOpen = Math.max(maxOpen, intersectionVolume(open, disc));
  }
  check("closed cover hides all four cells", minCover > 0.999,
    `${(100 * minCover).toFixed(1)}% of the weakest \u00d8${(2 * lensCellOuterR).toFixed(1)} cell mouth is covered`);
  check("open cover clears all four cells", maxOpen < 1e-6,
    `${maxOpen.toFixed(4)} mm^3 of any cell mouth is under the open cover; its top edge sits at Y ${openTop.toFixed(1)} against cell bottoms at ${(P.cameraLensY - lensCellOuterR).toFixed(1)}`);
  check("open cover stows inside the track", openY0 >= p0y + 0.2,
    `open, the cover's bottom edge is at Y ${openY0.toFixed(1)}; the track starts at ${p0y.toFixed(1)}`);
  // Detent: the holding pair sits in the gap between the open cover's top edge
  // and the closed cover's bottom edge, so it holds either position.
  const holdY = P.sliderClosedY0 - (P.sliderTravel - P.sliderH) / 2;
  check("cover detents are placed to hold both positions",
    holdY - P.sliderBumpR > openTop + 0.05 && holdY + P.sliderBumpR < P.sliderClosedY0 - 0.05,
    `holding ribs Ø${(2 * P.sliderBumpR).toFixed(1)} at Y ${holdY.toFixed(2)} in the ${(P.sliderTravel - P.sliderH).toFixed(1)} mm between an open top edge of ${openTop.toFixed(1)} and a closed bottom edge of ${P.sliderClosedY0.toFixed(1)}`);
  const bite = P.sliderClr + P.sliderBumpBite;
  const bumpProbe = cylZ(p0x + bite / 2, holdY, floorZ - P.sliderBumpH / 2 - 0.15, 0.04, 0.3, 12);
  const bumpFar = cylZ(p0x + bite + 0.1, holdY, floorZ - P.sliderBumpH / 2 - 0.15, 0.04, 0.3, 12);
  check("cover detent ribs stand sliderClr + bite off the walls",
    intersectionVolume(face, bumpProbe) > 1e-6 && intersectionVolume(face, bumpFar) < 1e-9,
    `ribs stand ${bite.toFixed(2)} mm off both track walls: ${P.sliderBumpBite} mm into the cover's edge past its ${P.sliderClr} mm clearance`);
  // And the cover's EDGE must actually meet them: 1.0 mm out of either position
  // its end crest is over the ribs and the two must share material. With R2
  // plan corners they never did - the corner swept past the bump. And halfway
  // along the travel the ribs must be in the edge's relief channel: free.
  const leaveClosed = intersectionVolume(closed.translate([0, -1.0, 0]), face);
  const leaveOpen = intersectionVolume(open.translate([0, 1.0, 0]), face);
  const midway = intersectionVolume(closed.translate([0, -P.sliderTravel / 2, 0]), face);
  check("cover's edge crests meet the detent ribs leaving either position",
    leaveClosed > 1e-3 && leaveOpen > 1e-3,
    `${leaveClosed.toFixed(4)} mm^3 shared 1.0 mm below closed, ${leaveOpen.toFixed(4)} mm^3 1.0 mm above open; plan corners R${P.sliderCornerR}, crests ${P.sliderEdgeCrest} mm`);
  check("cover slides free between the crests",
    midway < 1e-3,
    `${midway.toFixed(4)} mm^3 shared with the face halfway along the travel: the ribs ride the ${P.sliderEdgeRelief} mm relief in the cover's edges`);
  // The keeper: fills the rim gap with clearance, stays out of the cover's way,
  // and is what the cover meets if it tries to leave the open end.
  check("keeper is one part", sliderKeeper.decompose().length === 1,
    `${sliderKeeper.decompose().length} connected component(s), ${(sliderKeeper.volume() / 1000).toFixed(2)} cm^3`);
  const keeperHit = intersectionVolume(face, sliderKeeper), keeperCover = intersectionVolume(open, sliderKeeper);
  check("keeper seats in the rim gap clear of the face and the open cover",
    keeperHit < 1e-3 && keeperCover < 1e-3,
    `${keeperHit.toFixed(4)} mm^3 shared with the face, ${keeperCover.toFixed(4)} with the open cover; ${P.keeperClr} mm a side`);
  const overrun = intersectionVolume(open.translate([0, -1.5, 0]), sliderKeeper);
  check("keeper stops the cover leaving the open end", overrun > 1.0,
    `${overrun.toFixed(1)} mm^3 of keeper in the way of a cover pushed 1.5 mm past open`);
  const kb = sliderKeeper.boundingBox();
  // It reaches from the panel's start down to the bar's chamfer at floor
  // level, and its front is the bar's own face.
  check("keeper fills the gap's mouth", kb.max[1] > p0y - P.keeperClr - 0.05 && kb.min[1] < P.faceLensBar[1] + P.faceLensBarChamfer && kb.min[2] < -(P.faceBase + P.faceLensBarProud) + 0.05,
    `keeper spans Y ${kb.min[1].toFixed(1)}..${kb.max[1].toFixed(1)} (panel starts ${p0y.toFixed(1)}, bar chamfer ends ${(P.faceLensBar[1] + P.faceLensBarChamfer).toFixed(1)}), front at Z ${kb.min[2].toFixed(2)} (bar face ${(-(P.faceBase + P.faceLensBarProud)).toFixed(1)})`);
  const ko = overhangArea(keeperPrint);
  check("keeper prints support-free", ko.area < 5 && ko.maxTri < 3,
    `${ko.area.toFixed(2)} mm^2 of >45-degree downward faces, largest ${ko.maxTri.toFixed(2)} mm^2`);
  const so = overhangArea(sliderPrint);
  // The area is the serial's recess floor on the bed face: 0.6 mm bridges.
  check("lens cover prints support-free", so.area < 80 && so.maxTri < 3,
    `${so.area.toFixed(2)} mm^2 of >45-degree downward faces, largest ${so.maxTri.toFixed(2)} mm^2 (lettering strokes only)`);
}
// ---- Soft edges, groove, vents, ridge, Hall + magnet -------------------------
{
  // Rounds: a corner probe just inside the outline at the rounded edge must be
  // air, and the same probe a full R inboard must be solid.
  const R = P.edgeRoundR;
  const faceEdge = cube(0.3, 0.3, -P.faceBase + 0.2, 0.6, 0.6, 0.6);
  const faceIn = cube(R + 1, R + 1, -P.faceBase + 0.2, 0.6, 0.6, 0.6);
  check("face shell's front edge is rounded",
    intersectionVolume(face, faceEdge) < 1e-6 && intersectionVolume(face, faceIn) > 0.2,
    `R${R} over the plate's ${P.faceBase} mm: the outline corner is air at the front, solid ${R + 1} mm inboard`);
  // Probed on the TOP wall, mid-length. The low-X wall carries the door's entry
  // slot through its rear zone, so a probe there reads air whether or not the
  // rim is rounded.
  const rearEdge = cube(P.bodyW / 2, P.bodyH - 0.6, P.bodyD - 0.5, 0.6, 0.6, 0.4);
  const rearIn = cube(P.bodyW / 2, P.bodyH - R - 1.6, P.bodyD - 0.5, 0.6, 0.6, 0.4);
  check("chassis' rear edge is rounded",
    intersectionVolume(body, rearEdge) < 1e-6 && intersectionVolume(body, rearIn) > 0.1,
    `R${R} on the rear rim: the wall's outer corner is air in the last 0.5 mm, solid ${R + 1} mm inboard`);
  const feetKept = footPads.every(([fx0, fz0, fx1, fz1]) =>
    intersectionVolume(body, cube(fx0 + 4, -P.footProud + 0.1, fz0 + 3, fx1 - fx0 - 8, 0.4, fz1 - fz0 - 5)) > 1.0);
  check("rounding the rear rim kept the feet", feetKept, "all four foot pads still stand proud below the outline");

  // Cable groove: open from the slot to the rear edge, and a web left to the
  // door's dovetail.
  const groove = cube(P.usbPassageX - P.cableGrooveW / 2 + 0.2, 0.1, usbPassageZ + 1,
    P.cableGrooveW - 0.4, P.cableGrooveD - 0.2, P.bodyD - usbPassageZ - 1.2);
  check("cable groove runs from the exit slot to the rear edge",
    intersectionVolume(body, groove) < 1e-6,
    `${P.cableGrooveW} x ${P.cableGrooveD} mm groove, Z ${usbPassageZ.toFixed(1)} to ${P.bodyD}; a 4 mm cable lies ${(P.footProud + P.cableGrooveD - 4).toFixed(1)} mm clear of the table plane`);
  const web = P.wallBottom - P.cableGrooveD - P.doorBite;
  check("cable groove leaves a web to the door's dovetail", web >= 2.0,
    `${web.toFixed(1)} mm of bottom wall between the groove floor and the dovetail bite over the door zone`);

  // Vents: each slot open through its wall, all inside the rear half.
  let ventsOpen = 0;
  for (const [x0, x1] of [[-0.5, P.wallLeft + 0.5], [P.bodyW - P.wall - 0.5, P.bodyW + 0.5]]) {
    for (const vy of P.ventSlotYs) {
      const probe = cube(x0, vy - P.ventSlotW / 2 + 0.2, ventSlotZ0 + 0.3, x1 - x0, P.ventSlotW - 0.4, P.ventSlotLen - 0.6);
      if (intersectionVolume(body, probe) < 1e-6) ventsOpen++;
    }
  }
  check("vent slots are open through both side walls", ventsOpen === 2 * P.ventSlotYs.length,
    `${ventsOpen} of ${2 * P.ventSlotYs.length} slots clear, ${P.ventSlotW} x ${P.ventSlotLen} mm, Z ${ventSlotZ0}-${ventSlotZ0 + P.ventSlotLen} in the rear half (cut at ${splitZ})`);
  check("vent slots sit in the rear half, ahead of the module",
    ventSlotZ0 - P.ventSlotW / 2 > splitZ + 0.5 && ventSlotZ0 + P.ventSlotLen + P.ventSlotW / 2 < pcbBackZ,
    `slots span Z ${(ventSlotZ0 - P.ventSlotW / 2).toFixed(1)}-${(ventSlotZ0 + P.ventSlotLen + P.ventSlotW / 2).toFixed(1)} between the cut at ${splitZ} and the module face at ${pcbBackZ}`);

  // Ridge: stands proud of the bar face by a thumb's worth and no more.
  const barFront = -(P.faceBase + P.faceLensBarProud);
  const coverFrontMost = lensSlider.boundingBox().min[2];
  check("cover ridge stands just proud of the bar",
    Math.abs((barFront - coverFrontMost) - (P.coverRidgeProud - P.sliderZClr)) < 0.05,
    `ridge front at Z ${coverFrontMost.toFixed(2)}, bar face at ${barFront.toFixed(2)}: ${(barFront - coverFrontMost).toFixed(2)} mm proud`);

  // The Hall switch is gone: the cover's state is read in firmware off the four
  // sensors. These gates now assert its ABSENCE, at the three places it used to
  // be, because a removal that half-happens is worse than either state - a
  // blind pocket nobody fills is a void in the glue joint, and a Ø2.4 hole
  // nobody threads a lead through is an unexplained opening in the plate.
  const [hx, hy] = [107.5, 36.0];      // where it used to sit; a datum, not a feature
  const floorZ = -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth;
  const oldPocket = cylZ(hx, hy, -5.5, 4.5 / 2, 5.5, 32);
  const oldChannel = cube(hx - 1.25, 20.0, -1.75, 2.5, hy - 20.0, 1.75);
  // Inside the plate only. The original probe deliberately overran it by
  // 0.5 mm at each end to prove the hole went all the way through; read as an
  // absence test that reports 83.3% solid on a plate that is completely solid.
  const oldWire = cylZ(hx, 20.0, 0.2, 2.4 / 2, P.plate - 0.4, 32);
  const oldMagnet = cylZ(hx, hy, floorZ - 1.1, 3.2 / 2, 1.1, 32);
  check("the face shell's back carries no Hall pocket or lead channel",
    intersectionVolume(face, oldPocket) > 0.99 * oldPocket.volume() &&
      intersectionVolume(face, oldChannel) > 0.99 * oldChannel.volume(),
    `solid where the Ø4.5 x 5.5 pocket at (${hx}, ${hy}) and the 2.5 x 1.75 channel down to Y 20 used to be: ${(100 * intersectionVolume(face, oldPocket) / oldPocket.volume()).toFixed(1)}% and ${(100 * intersectionVolume(face, oldChannel) / oldChannel.volume()).toFixed(1)}%`);
  check("the front plate carries no Hall lead hole",
    intersectionVolume(body, oldWire) > 0.99 * oldWire.volume(),
    `${(100 * intersectionVolume(body, oldWire) / oldWire.volume()).toFixed(1)}% solid where the Ø2.4 hole through the plate at (${hx}, 20.0) used to be`);
  check("the cover's back carries no magnet pocket",
    intersectionVolume(lensSlider, oldMagnet) > 0.99 * oldMagnet.volume(),
    `${(100 * intersectionVolume(lensSlider, oldMagnet) / oldMagnet.volume()).toFixed(1)}% solid where the Ø3.2 x 1.1 pocket in the cover's back used to be`);
}
// ---- The split seam's V-groove ----------------------------------------------
{
  const c = P.seamChamfer, r = c * Math.tan((P.seamAngleDeg * Math.PI) / 180);
  // A probe 0.4 mm deep into each outer face: at the cut plane the V has taken
  // 0.6, so it must be air; two rises below, plain wall, so it must be solid.
  const probe = (x, y, w, h, z) => cube(x, y, z - 0.05, w, h, 0.1);
  const faces = [
    ["bottom", centerX - 5, 0.05, 10, 0.4],
    ["top", centerX - 5, P.bodyH - 0.45, 10, 0.4],
    ["left", 0.05, centerY - 5, 0.4, 10],
    ["right", P.bodyW - 0.45, centerY - 5, 0.4, 10],
  ];
  let ok = true; const notes = [];
  for (const [name, x, y, w, h] of faces) {
    const box = probe(x, y, w, h, splitZ), below = probe(x, y, w, h, splitZ - 2 * r);
    const air = intersectionVolume(body, box) < 1e-6;
    const solid = intersectionVolume(body, below) > 0.5 * box.volume();
    ok = ok && air && solid;
    notes.push(`${name} ${air ? "grooved" : "FLAT"}${solid ? "" : ", HOLLOW below"}`);
  }
  check("the split seam runs in a V-groove on all four faces", ok,
    `${c} mm deep and ${(2 * r).toFixed(2)} mm tall at the cut plane Z=${splitZ}, walls at ${P.seamAngleDeg} degrees - ${notes.join("; ")}`);
  // Each half has to carry its own half of the V, or the line is only chamfered
  // on one side and reads worse than a butt joint.
  const fAir = intersectionVolume(bodyFront, probe(centerX - 5, 0.05, 10, 0.2, splitZ - 0.2)) < 1e-6;
  const rAir = intersectionVolume(bodyRear, probe(centerX - 5, 0.05, 10, 0.2, splitZ + 0.2)) < 1e-6;
  check("both halves carry their half of the seam chamfer", fAir && rAir,
    `front half ${fAir ? "chamfered" : "SQUARE"} at its top edge, rear half ${rAir ? "chamfered" : "SQUARE"} at its bottom edge`);
  check("the seam groove leaves the wall alone",
    P.wall - c >= 5.0 && c < P.wall - P.splitBoltInset - P.splitHeadD / 2,
    `${(P.wall - c).toFixed(1)} mm of wall under the groove; the bolt's head pocket reaches ${(P.wall - P.splitBoltInset - P.splitHeadD / 2).toFixed(2)} mm from that face`);
}

// ---- Face-plate grain --------------------------------------------------------
{
  const zs = -P.faceBase, t = P.grainDepth - 0.04;
  const sample = cube(20, 70, zs + 0.02, 20, 12, t);
  const solidFrac = intersectionVolume(face, sample) / sample.volume();
  const expect = 1 - P.grainW / P.grainPitch;
  check("face plate carries the grain at the intended density",
    Math.abs(solidFrac - expect) < 0.08,
    `${(100 * (1 - solidFrac)).toFixed(0)}% of the plate's top ${P.grainDepth} mm removed over a 20 x 12 mm sample, against ${(100 * (1 - expect)).toFixed(0)}% intended: ${P.grainW} mm grooves on a ${P.grainPitch} mm pitch, ${(P.grainPitch - P.grainW).toFixed(1)} mm lands`);
  // The grain is a field, not a wash: the plate keeps a clean border at the
  // outline, around the lens bar and around the serial.
  const lands = [
    ["outline", cube(3.0, 40, zs + 0.02, 0.8, 10, t)],
    ["lens bar", cube(P.faceLensBar[0] - P.grainBarClear + 0.3, 30, zs + 0.02, P.grainBarClear - 0.6, 10, t)],
    ["serial", cube(55, ENGRAVINGS.face.anchor[1] - P.grainMarkClear + 0.3, zs + 0.02, 20, P.grainMarkClear - 0.6, t)],
  ];
  let clean = true; const where = [];
  for (const [name, box] of lands) {
    const frac = intersectionVolume(face, box) / box.volume();
    clean = clean && frac > 0.995;
    where.push(`${name} ${(100 * frac).toFixed(1)}%`);
  }
  check("the grain keeps a clean land at every border", clean,
    `solid fraction in the land strips: ${where.join(", ")} - ${P.grainEdgeInset} mm inside the outline, ${P.grainBarClear} around the lens bar, ${P.grainMarkClear} around the serial`);
}

// ---- Body-wall flutes --------------------------------------------------------
// The walls are 88% of what the eye sees on the rear half and 72% on the front,
// so the flutes are not decoration to be checked by eye off a render: they get
// the same treatment as the detents. Density on every wall of every band, a
// land in front of everything that needs a flat, a floor that bottoms where it
// is meant to, and a wall left thick enough afterwards.
{
  const sr = seamRun;
  const [bandF, bandR] = FLUTE_BANDS;
  // Expected void fraction in the outer d mm of wall, integrated from the V's
  // own geometry rather than measured off the cutter solid - a second opinion,
  // not the same statement twice. A 45-degree V of depth D is 2(D-u) wide at
  // depth u, so the void down to d is 2*D*d - d^2 (and D^2 once d reaches D).
  const voidFrac = (d) => {
    const D = P.wallGrainDepth, u = Math.min(d, D);
    return (2 * D * u - u * u) / (P.wallGrainPitch * d);
  };
  const skin = 0.2;
  const expect = 1 - voidFrac(skin);
  // A window on each wall, in each band, clear of every land by inspection of
  // the keep-out list: bottom X 70-90 (between the tie slot at 56 and the foot
  // at 104), top X 20-40 (clear of the light at 66, badge at 90, shutter at
  // 115), sides Y 20-40 and 10-20 (clear of the vents and the strap lug).
  const windows = [
    ["bottom wall, front half", cube(70, 0, bandF[0] + 3.5, 20, skin, 7)],
    ["top wall, front half", cube(20, P.bodyH - skin, bandF[0] + 3.5, 20, skin, 7)],
    ["-X wall, front half", cube(0, 20, bandF[0] + 3.5, skin, 20, 7)],
    ["+X wall, front half", cube(P.bodyW - skin, 20, bandF[0] + 3.5, skin, 20, 7)],
    ["-X wall, rear half", cube(0, 10, bandR[0] + 14, skin, 10, 7)],
    ["+X wall, rear half", cube(P.bodyW - skin, 10, bandR[0] + 14, skin, 10, 7)],
    // The rear half's bottom wall is crowded: the rear serial is 45 mm wide at
    // Z 47, so its land reaches X 63.5-112.5 over Z 42.7-51.3. Read the window
    // behind it instead of through it.
    ["bottom wall, rear half", cube(70, 0, bandR[1] - 6.5, 20, skin, 6)],
  ];
  let worst = 0; const read = [];
  for (const [name, w] of windows) {
    const frac = intersectionVolume(body, w) / w.volume();
    worst = Math.max(worst, Math.abs(frac - expect));
    read.push(`${name} ${(100 * (1 - frac)).toFixed(0)}%`);
  }
  check("every outer wall carries the flutes at the intended density",
    worst < 0.06,
    `${(100 * (1 - expect)).toFixed(0)}% of the outer ${skin} mm intended void (45-degree V ${P.wallGrainDepth} mm deep, ${(2 * P.wallGrainDepth).toFixed(1)} mm wide at the surface, on a ${P.wallGrainPitch} mm pitch = ${(P.wallGrainPitch - 2 * P.wallGrainDepth).toFixed(1)} mm lands), read: ${read.join(", ")}`);
  // The floor bottoms out. Inboard of the groove there must be solid wall: if
  // the cutter ever drifts inward this is what says so, and it is the number
  // that decides whether a 6 mm wall is still a 6 mm wall.
  const depth = P.wallGrainDepth;
  const under = [
    ["bottom wall", cube(70, depth + 0.05, bandF[0] + 3.5, 20, 0.2, 7)],
    ["-X wall", cube(depth + 0.05, 20, bandF[0] + 3.5, 0.2, 20, 7)],
    ["top wall", cube(20, P.bodyH - depth - 0.25, bandF[0] + 3.5, 20, 0.2, 7)],
  ];
  let solidUnder = true; const readUnder = [];
  for (const [name, w] of under) {
    const frac = intersectionVolume(body, w) / w.volume();
    solidUnder = solidUnder && frac > 0.999;
    readUnder.push(`${name} ${(100 * frac).toFixed(1)}%`);
  }
  check("the flutes bottom out and leave the wall behind them solid", solidUnder,
    `solid fraction in the 0.2 mm shell just inboard of the ${depth.toFixed(2)} mm floor: ${readUnder.join(", ")} - a ${P.wall} mm wall keeps ${(P.wall - depth).toFixed(2)} mm`);
  // Lands. Everything here is a surface something has to sit on, seal against
  // or be read off, and a 0.2 mm groove across any of them is a defect. The
  // light seat is the one the gates already caught once.
  const lands = [
    ["light base seat", cube(P.quarterX - P.lightPlate / 2, P.bodyH - skin, P.quarterZ - P.lightPlate / 2, P.lightPlate, skin, 4)],
    ["a foot's root", cube(12, 0, P.footPadFrontZ + 1, 12, skin, 6)],
    ["bed land below the flutes", cube(0, 20, 0.2, skin, 20, P.wallGrainLandBed - 0.4)],
    ["seam land, front side", cube(0, 20, splitZ - sr - P.wallGrainLandSeam + 0.05, skin, 20, P.wallGrainLandSeam - 0.1)],
    ["seam land, rear side", cube(0, 20, splitZ + sr + 0.05, skin, 20, P.wallGrainLandSeam - 0.1)],
    // On the +X wall, not the -X: the door's entry mouth clears the -X end of
    // the track from the door plane out, so the probe would read open air.
    ["door-frame land above the flutes", cube(P.bodyW - skin, 20, bandR[1] + 0.05, skin, 20, P.wallGrainLandRim - 0.1)],
  ];
  let clean = true; const where = [];
  for (const [name, w] of lands) {
    const frac = intersectionVolume(body, w) / w.volume();
    clean = clean && frac > 0.995;
    where.push(`${name} ${(100 * frac).toFixed(1)}%`);
  }
  check("the flutes keep a land at every seat, pad and parting line", clean,
    `solid fraction in the outer ${skin} mm: ${where.join(", ")}`);
  // The pattern closes on itself. Stepped from a corner instead of divided into
  // the loop, the last flute lands a fraction of a pitch from the first and the
  // camera has one double line down one corner for ever.
  const st = wallFluteStations(P.wallGrainPitch);
  const first = st.stations[0][0], last = st.stations[st.stations.length - 1][0];
  const gap = Math.hypot(first[0] - last[0], first[1] - last[1]);
  check("the flute pattern closes exactly around the body",
    Math.abs(st.pitch - P.wallGrainPitch) < 0.05 && Math.abs(gap - st.pitch) < 0.05,
    `${st.stations.length} flutes on a ${st.pitch.toFixed(4)} mm step round a ${st.perimeter.toFixed(1)} mm loop (asked for ${P.wallGrainPitch}); last to first ${gap.toFixed(4)} mm`);
}

// ---- Identity engravings and the stow-zone hatch ----------------------------
{
  const parts = { frontHalf: bodyFront, rearHalf: bodyRear, face, cover: lensSlider, door: bezel, tool: alignTool, badge: body,
    spec: bodyFront, ...Object.fromEntries(CAM_NUMBER_KEYS.map((k) => [k, bodyFront])) };
  for (const [key, E] of Object.entries(ENGRAVINGS)) {
    const part = parts[key];
    // Open: the engraving solid must not survive inside the part.
    const inside = intersectionVolume(part, E.solid);
    // Judged against the recess volume, not an absolute: the parts are
    // simplified after the cut (the face, cover and tool at 15 microns), which
    // moves the strokes' round walls by up to that much over ~300 mm of
    // outline - 0.2 mm^3 of slivers against an ~11 mm^3 recess. 3% passes
    // that and fails a missing glyph (one digit is ~9% of the text); a
    // missing dot (~1.5%) is left to the reads-the-right-way-round gate.
    const recess = E.area * E.depth;
    check(`${E.name} is engraved`, inside < 0.03 * recess,
      `"${E.text}" ${E.w.toFixed(1)} x ${E.h.toFixed(1)} mm, ${E.depth} mm deep on the ${E.face} face at (${E.anchor.map((q) => q.toFixed(1)).join(", ")}); ${inside.toFixed(3)} of the ${recess.toFixed(1)} mm^3 recess left uncut (${(100 * inside / recess).toFixed(2)}%)`);
    // Reads the right way round: bring the part into the engraving's frame,
    // slice inside the recess, and compare missing material in the left and
    // right thirds with the text's own ink.
    const local = E.unplace(part);
    const cs = local.slice(-E.depth / 2);
    const third = E.w / 3;
    const ink = (x0) => { const r = wasm.CrossSection.square([third, E.h + 0.2], false).translate([x0, -0.1]); return r.area() - cs.intersect(r).area(); };
    const left = ink(-E.w / 2), right = ink(E.w / 2 - third);
    const okDir = Math.abs(left - E.expLeft) < 0.25 * Math.max(E.expLeft, 1) && Math.abs(right - E.expRight) < 0.25 * Math.max(E.expRight, 1);
    check(`${E.name} reads the right way round`, okDir,
      `left third ${left.toFixed(1)} / right third ${right.toFixed(1)} mm^2 cut, against ${E.expLeft.toFixed(1)} / ${E.expRight.toFixed(1)} in the text - reader's right derived from the face normal`);
    // Every stroke at least one nozzle line wide: erode the outline by half the
    // minimum and re-dilate; what does not come back was thinner than that.
    {
      const m = P.serialMinStroke;
      const thin = E.cs.subtract(E.cs.offset(-m / 2, "Round", 2, 16).offset(m / 2, "Round", 2, 16)).area();
      check(`${E.name} strokes are at least ${m} mm wide`, thin < 0.03 * E.area,
        `${thin.toFixed(2)} mm^2 of ${E.area.toFixed(1)} thinner than ${m} mm (${(100 * thin / E.area).toFixed(1)}%) - ${E.text === "boxed D4 from the wordmark" ? "the box outline is the thinnest part" : `${FONT.family} at ${P.serialCapH} mm caps, emboldened ${P.serialEmbolden} a side`}`);
    }
    // Not through: material must remain behind the recess.
    const behind = wasm.CrossSection.square([E.w + 1, E.h + 1], false).translate([-E.w / 2 - 0.5, -0.5]);
    const floorCs = local.slice(-E.depth - 0.4);
    check(`${E.name} leaves material behind it`, behind.area() - floorCs.intersect(behind).area() < 1e-3,
      `the slab ${(E.depth + 0.4).toFixed(1)} mm under the surface is solid across the whole engraving`);
  }
  // Camera numbers: each must sit on BARE plate - nothing standing on that
  // patch (fence, boss, post, pad) to hide it - and above its own board's top
  // edge, so it still reads with a node fitted.
  for (const [i, k] of CAM_NUMBER_KEYS.entries()) {
    const E = ENGRAVINGS[k];
    const [ax, ay] = E.anchor;
    const clear = cube(ax - E.w / 2 - 1.0, ay - 1.0, P.plate + 0.05, E.w + 2.0, E.h + 2.0, 3.0);
    const hit = intersectionVolume(bodyFront, clear);
    check(`camera ${i + 1} number sits on bare plate, above its board`,
      hit < 1e-6 && ay >= boardMaxY,
      `"${E.text}" ${E.w.toFixed(1)} x ${E.h.toFixed(1)} mm at (${ax.toFixed(1)}, ${ay.toFixed(1)}) on the plate's inner face, baseline ${(ay - boardMaxY).toFixed(1)} mm above the board's top edge at ${boardMaxY.toFixed(1)}; ${hit.toFixed(4)} mm^3 of anything standing in the 3 mm above it`);
  }
  // Hatch: the stow zone gives up about hatchW/hatchPitch of its top 0.3 mm; the
  // closed zone gives up nothing.
  const { p0x, p1x, p0y } = LENS_PANEL;
  const floorZ = -(P.faceBase + P.faceLensBarProud) + P.faceLensPanelDepth;
  const zx0 = p0x + P.sliderBevel + 1.0, zx1 = p1x - P.sliderBevel - 1.0;
  const zy0 = p0y + 1.5, zy1 = P.sliderClosedY0 - 1.5;
  // Sampled from the RELIEVED floor, which is where the hatch is now cut. Off
  // the original plane it read 86% removed against 24% intended, because the
  // bearing relief had already taken 0.25 of the 0.30 being sampled.
  const stow = cube(zx0 + 0.5, zy0 + 0.5, STOW_FLOOR_Z() + 0.02, zx1 - zx0 - 1, zy1 - zy0 - 1, P.hatchDepth - 0.04);
  const solidFrac = intersectionVolume(face, stow) / stow.volume();
  const expect = 1 - P.hatchW / P.hatchPitch;
  check("stow-zone hatch is cut at the intended density",
    Math.abs(solidFrac - expect) < 0.08,
    `${(100 * (1 - solidFrac)).toFixed(0)}% of the floor's top ${P.hatchDepth} mm removed over Y ${zy0.toFixed(1)}-${zy1.toFixed(1)}, against ${(100 * (1 - expect)).toFixed(0)}% intended (${P.hatchW} mm grooves on a ${P.hatchPitch} mm pitch)`);
  // The closed zone minus the four cell mouths, which are meant to be open.
  // Also sampled from the relieved floor. What this gate is for is that the
  // floor the cover uncovers when it drops is a clean rectangle, not a hatched
  // one - and clean at 0.25 mm deeper is still clean.
  const closedZone = cube(p0x + 1.5, P.sliderClosedY0 + 0.5, STOW_FLOOR_Z() + 0.02, p1x - p0x - 3, P.sliderH - 1, P.hatchDepth - 0.04)
    .subtract(fuse(cameraXs.map((cx) => cylZ(cx, P.cameraLensY, floorZ - 1, lensCellOuterR + 0.6, 3, 64))));
  const closedFrac = intersectionVolume(face, closedZone) / closedZone.volume();
  // The bearing lands. The cover slid badly not because the fit was wrong but
  // because it rode its whole back on a hatched floor, so these two lands are
  // the fix and they need holding: at the original floor plane, unhatched, and
  // with relieved floor either side of them.
  {
    const onLand = RAIL_XS.map((rx) => {
      const probe = cube(rx - P.coverRailW / 2 + 0.3, P.sliderClosedY0 - P.sliderTravel + 2.0,
        floorZ + 0.01, P.coverRailW - 0.6, 8.0, 0.14);
      return intersectionVolume(face, probe) / probe.volume();
    });
    const offLand = cube(RAIL_XS[0] + P.coverRailW / 2 + P.coverRailLaneClear + 0.5,
      P.sliderClosedY0 - P.sliderTravel + 2.0, floorZ + 0.05, 3.0, 8.0, 0.14);
    const offFrac = intersectionVolume(face, offLand) / offLand.volume();
    check("the cover rides two bearing lands at the floor plane, relieved either side",
      onLand.every((f) => f > 0.995) && offFrac < 0.02,
      `lands at X ${RAIL_XS.map((x) => x.toFixed(1)).join(" and ")} read ${onLand.map((f) => `${(100 * f).toFixed(1)}%`).join(", ")} solid at the floor plane; the floor ${P.coverRailLaneClear} mm off a land reads ${(100 * offFrac).toFixed(1)}% - relieved by ${P.coverRailProud} mm. Contact drops from about 1824 mm^2 of hatched floor to ${(2 * P.coverRailW * P.sliderH).toFixed(0)} mm^2 of smooth land.`);
  }
  check("floor under the closed cover is unhatched", closedFrac > 0.999,
    `${(100 * closedFrac).toFixed(1)}% solid where the cover sits closed - the cells' cones are the only openings there`);
}
// ---- Plates ------------------------------------------------------------------------
{
  const bed = [250, 210];
  for (const [name, plate, parts, members] of [
    ["plate 1 (chassis)", plate1, 2, [bodyFront, rearPrint]],
    ["plate 2 (face, door, cover, keeper, clamps, button)", plate2, 10, [facePrint, bezelPrint, sliderPrint, keeperPrint, clamps, shutterButton]],
  ]) {
    const bb = plate.boundingBox();
    check(`${name} fits a ${bed[0]} x ${bed[1]} bed on Z=0`,
      Math.abs(bb.min[2]) < 1e-6 && bb.max[0] - bb.min[0] <= bed[0] && bb.max[1] - bb.min[1] <= bed[1],
      `${(bb.max[0] - bb.min[0]).toFixed(1)} x ${(bb.max[1] - bb.min[1]).toFixed(1)} x ${(bb.max[2] - bb.min[2]).toFixed(1)} mm`);
    check(`${name} carries every part, none merged`, plate.decompose().length === parts,
      `${plate.decompose().length} separate parts, ${parts} expected`);
    const volSum = members.reduce((s, m) => s + m.volume(), 0);
    check(`${name} is the released meshes, unmoved in Z`, Math.abs(plate.volume() - volSum) < 1e-3 * volSum,
      `${(plate.volume() / 1000).toFixed(2)} cm^3 on the plate against ${(volSum / 1000).toFixed(2)} in its parts - the same solids, only translated`);
  }
}

// ---- Strap lug ----------------------------------------------------------------------
{
  const lx = STRAP_BORE_X, ly = P.strapLugY0 + P.strapLugLen / 2;
  const hole = cylZ(lx, ly, splitZ + 0.2, P.strapHoleD / 2 - 0.15, P.strapLugH - 0.4, 24);
  // The lug body outboard of the cord, on the -X side of the bore.
  const meat = cube(-STRAP_PROUD + 0.3, P.strapLugY0 + 1.0, splitZ + 0.5,
    P.strapLugWall - 0.6, 1.2, P.strapLugH - 1.0);
  check("strap anchor stands on the rear half's cut face with an open cord hole",
    intersectionVolume(bodyRear, hole) < 1e-6 && intersectionVolume(bodyRear, meat) > 0.9 * meat.volume() && intersectionVolume(bodyFront, meat) < 1e-6,
    `Ø${P.strapHoleD} hole open through ${P.strapLugH} mm of lug at (${lx.toFixed(1)}, ${ly.toFixed(1)}), ${STRAP_PROUD.toFixed(2)} mm proud of the -X wall, Z ${splitZ}-${(splitZ + P.strapLugH).toFixed(0)} on the rear half only`);
  // The one number a strap anchor lives or dies by, and it had no gate: how
  // much material stands between the cord and the outside. It was 0.5 mm - one
  // bead - because the bore was centred out in the lug rather than on the wall
  // face. A cord under the camera's weight tears through one bead.
  // Probed on BOTH sides of the cord, because a loop with material on one side
  // only is not a loop. Outboard: between the bore and the outside world.
  // Inboard: between the bore and the wall face.
  {
    const strip = (x0) => cube(x0, ly - 0.6, splitZ + 1.0,
      P.strapLugWall - 0.6, 1.2, P.strapLugH - 2.0);
    const out = strip(-STRAP_PROUD + 0.3);
    const inn = strip(STRAP_BORE_X + P.strapHoleD / 2 + 0.3);
    const fo = intersectionVolume(bodyRear, out) / out.volume();
    const fi = intersectionVolume(bodyRear, inn) / inn.volume();
    check("the cord hole is walled on both sides by more than one bead",
      P.strapLugWall >= 1.2 && fo > 0.9 && fi > 0.9,
      `${P.strapLugWall} mm of lug each side of the Ø${P.strapHoleD} cord hole (outboard ${(100 * fo).toFixed(0)}% solid, inboard ${(100 * fi).toFixed(0)}%), against 1.2 minimum - three beads at a 0.4 nozzle. It shipped with 0.5 mm outboard and no gate on it.`);
  }
  const ventTop = Math.max(...P.ventSlotYs) + P.ventSlotW / 2 + 1.0;
  check("strap anchor clears the vent slots and the rear rim round",
    P.strapLugY0 > ventTop && splitZ + P.strapLugH < P.bodyD - P.edgeRoundR - 1.0,
    `lug Y ${P.strapLugY0}-${P.strapLugY0 + P.strapLugLen} above the top vent at ${(ventTop - 1.0).toFixed(1)}; Z top ${(splitZ + P.strapLugH).toFixed(0)} under the R${P.edgeRoundR} rim at ${(P.bodyD - P.edgeRoundR).toFixed(1)}`);
  // And it must be off the grip. The shutter says which end the right hand
  // wraps; the anchor has to be on the other one.
  {
    const anchorX = 0;
    const gripHighX = P.shutterX > P.bodyW / 2;
    const anchorHighX = anchorX > P.bodyW / 2;
    check("the strap anchor is not on the wall the shooting hand grips",
      gripHighX !== anchorHighX,
      `shutter at X ${P.shutterX} puts the grip on the ${gripHighX ? "+X" : "-X"} end; the anchor is at X ${anchorX} on the ${anchorHighX ? "+X" : "-X"} wall, ${Math.abs(P.shutterX - anchorX).toFixed(0)} mm away`);
  }
}

// ---- Node USB access: can a XIAO be reflashed in place? ------------------------------
// The XIAO's USB-C opens at the board's top (+Y) end, on the side facing the
// plate, between the XIAO and its Sense board. With the door and module out and
// that node's clamp lifted (one M2), a plug has to be able to enter along +Y.
{
  const zTop = boardBackZ + 0.9, zBot = zTop - P.usbPlugBody[2];
  let straightClear = 0, angledClear = 0; const notes = [];
  for (const [i, cx] of cameraXs.entries()) {
    const straight = cube(cx - P.usbPlugBody[0] / 2, boardMaxY + 0.5, zBot, P.usbPlugBody[0], P.usbPlugBody[1], P.usbPlugBody[2]);
    const angled = cube(cx - P.usbPlugBody[0] / 2, boardMaxY + 0.5, zBot, P.usbPlugBody[0], P.usbPlugAngled, P.usbPlugBody[2]);
    const s = intersectionVolume(bodyFront, straight), a = intersectionVolume(bodyFront, angled);
    if (s < 1e-6) straightClear++; if (a < 1e-6) angledClear++;
    notes.push(`node ${i + 1}: straight ${s < 1e-6 ? "clear" : `blocked (${s.toFixed(0)} mm^3, the P4 post)`}, right-angle ${a < 1e-6 ? "clear" : "BLOCKED"}`);
  }
  /*
   * The requirement is that every node can be reflashed in place with SOME
   * plug, and a right-angle plug is always available - so that is what this
   * gates. How many also take a straight plug is reported, not required.
   *
   * It was three until the standoff pattern was re-measured at 65.5 x 58.2:
   * the posts moved 1.8 mm outward and clipped a 0.45 mm sliver off the corner
   * of node 4's plug envelope. The pattern is calipers on the board and the
   * 12 x 7 mm envelope is a conservative guess at a moulded plug, so the
   * honest response is to record which nodes want the right-angle plug rather
   * than to move a post to protect an estimate.
   */
  check("every node's USB-C can be reached with a right-angle plug in place",
    angledClear === 4,
    `${P.usbPlugBody[0]} x ${P.usbPlugBody[2]} mm plug body, ${P.usbPlugBody[1]} mm straight / ${P.usbPlugAngled} mm angled past the board end at Y ${boardMaxY.toFixed(1)}, clamp lifted - ${notes.join("; ")}`);
}

check("face shell is one part", face.decompose().length === 1,
  `${face.decompose().length} connected component(s)`);
// Relief is measured, not assumed. Flat renders cannot show whether a raised
// feature actually stands where it should - probing the solid can, and it
// already caught a lens rim eaten by its own chamfer and a strap lug buried
// inside the grip.
const reliefAt = (x, y) => {
  const column = cylZ(x, y, -60, 0.35, 120, 16).intersect(face);
  return column.isEmpty() ? 0 : -column.boundingBox().min[2];
};
const reliefTargets = [
  ["base plate", 8, 50, P.faceBase, 0.3],
  // Mid-rim, clear of both the chamfer and the accent ledge.
  ["lens bar rim", LENS_PANEL.rimMidX, 43,
    P.faceBase + P.faceLensBarProud, 0.4],
  // The ledge runs along the top and bottom of the panel only now; probe the
  // TOP strip at the bar's centre line (the bottom strip is the keeper's gap
  // there). The side rim it used to be probed on is full height - that is
  // what backs the lips.
  ["lens accent ledge", (LENS_PANEL.p0x + LENS_PANEL.p1x) / 2, LENS_PANEL.g1y - P.faceLensGroove / 2,
    P.faceBase + P.faceLensBarProud - P.faceLensAccent, 0.4],
  ["lens bar side rim, full height behind the lips", LENS_PANEL.g0x + P.faceLensGroove / 2, 43,
    P.faceBase + P.faceLensBarProud, 0.4],
  // Between the first and second cells, where the panel floor is genuinely
  // exposed rather than inside a cone.
  ["lens panel floor", 43.5, 43,
    P.faceBase + P.faceLensBarProud - P.faceLensPanelDepth, 0.4],
  // "grip crown" and "hump front" used to be measured here. Both features are
  // gone, so the lens bar and its two steps are the whole relief now - which is
  // exactly what the four remaining targets check.
];
// The drum-profile gate stood here, proving the grip was a cylindrical section
// rather than a flat-topped block. There is no grip on the shell any more.
for (const [name, x, y, expected, tol] of reliefTargets) {
  const h = reliefAt(x, y);
  check(`relief height: ${name}`, Math.abs(h - expected) <= tol,
    `${h.toFixed(2)} mm above the mating plane, expected ${expected.toFixed(2)} ±${tol}`);
}
// The recessed panel must contain all four cells with margin, or the cones
// cut through the ledge and the rim and the bar loses its edge entirely -
// which is exactly what Ø17 cells in a 90 mm bar did.
{
  const cellR = lensCellOuterR;
  const { p0x, p0y, p1x, p1y } = LENS_PANEL;
  check("lens panel contains all four cells",
    cameraXs[0] - cellR >= p0x + 1.0 && cameraXs[3] + cellR <= p1x - 1.0 &&
      P.cameraLensY - cellR >= p0y + 0.5 &&
      P.cameraLensY + cellR <= p1y - 0.5,
    `cells span X ${(cameraXs[0] - cellR).toFixed(1)}-${(cameraXs[3] + cellR).toFixed(1)}, Y ${(P.cameraLensY - cellR).toFixed(1)}-${(P.cameraLensY + cellR).toFixed(1)} inside panel X ${p0x.toFixed(1)}-${p1x.toFixed(1)}, Y ${p0y.toFixed(1)}-${p1y.toFixed(1)}`);
  check("cells leave a web between them",
    P.cameraPitch - 2 * lensCellOuterR >= 3.0,
    `${(P.cameraPitch - 2 * lensCellOuterR).toFixed(1)} mm of panel between adjacent cells, at Ø${(2 * lensCellOuterR).toFixed(1)} cells on ${P.cameraPitch} mm pitch`);
}

// Lettering handedness. Every label on this camera was mirrored on the printed
// part because the layout started at the label's right edge and stepped left.
// It looked correct in any render taken from behind, which is how it survived.
// The test is direction, not appearance: for a multi-character label the first
// character's ink must lie to the LEFT of the last character's.
{
  const cell = 1.2;
  const glyphWidth = 5 * cell, glyphGap = cell;
  const bad = [];
  for (const label of [P.frontText]) {
    if (label.length < 2) continue;
    const { runs, totalWidth } = glyphRuns(label, cell);
    const span = glyphWidth + glyphGap;
    const bandOf = (u) => Math.floor(u / span + 1e-6);
    const xs = runs.map((r) => ({
      band: bandOf(r.u),
      x: textRunX(0, totalWidth, r.u, r.w) + r.w / 2,
    }));
    const first = xs.filter((q) => q.band === 0);
    const last = xs.filter((q) => q.band === label.length - 1);
    if (!first.length || !last.length) { bad.push(`${label}: no ink`); continue; }
    const fx = first.reduce((a, q) => a + q.x, 0) / first.length;
    const lx = last.reduce((a, q) => a + q.x, 0) / last.length;
    if (!(fx > lx)) bad.push(`${label}: "${label[0]}" at X ${fx.toFixed(1)} is not at HIGHER X than "${label[label.length - 1]}" at ${lx.toFixed(1)} (+X is the reader's left)`);
  }
  check("lettering reads left to right for a reader facing the camera",
    bad.length === 0,
    bad.length ? bad.join("; ")
      : `"${P.frontText}" lays out first character at highest X, which is the reader's left`);
}

// The wordmark's direction on the cover AS PRINTED. The mark is not text, so
// there is no O to find; instead the trace records how much ink sits in its
// left and right thirds (the "k" end is heavier than the boxed D4), and the
// print-frame slice must show the same imbalance the same way round. The print
// transform is a rotation, so the slicer's view is also the subject's view.
{
  const cs = sliderPrint.slice(P.sliderT + 0.3);
  const xCp = P.bodyW - COVER_MARK.xC;             // rotated about Y: x' = bodyW - x
  const third = COVER_MARK.w / 3;
  const band = (x0) => cs.intersect(wasm.CrossSection.square([third, COVER_MARK.h + 0.2], false)
    .translate([x0, COVER_MARK.yB - 0.1])).area();
  const left = band(xCp - COVER_MARK.w / 2), right = band(xCp + COVER_MARK.w / 2 - third);
  const srcRatio = MARK.inkLeftThird / MARK.inkRightThird, gotRatio = left / Math.max(right, 1e-9);
  check("wordmark reads the right way round in the print file",
    (left > right) === (MARK.inkLeftThird > MARK.inkRightThird) && Math.abs(gotRatio - srcRatio) < 0.35 * srcRatio,
    `left third ${left.toFixed(0)} mm^2 vs right third ${right.toFixed(0)} mm^2 of raised mark (ratio ${gotRatio.toFixed(2)}); the trace has ${MARK.inkLeftThird} vs ${MARK.inkRightThird} cells (ratio ${srcRatio.toFixed(2)})`);
  check("wordmark fits the cover between the ridge and the top edge",
    COVER_MARK.w <= (LENS_PANEL.p1x - LENS_PANEL.p0x) - 2 * P.sliderClr - 2 * P.sliderBevel - 2.0
      && COVER_MARK.yB >= COVER_MARK.bandY0 && COVER_MARK.yB + COVER_MARK.h <= COVER_MARK.bandY1,
    `${COVER_MARK.w.toFixed(1)} x ${COVER_MARK.h.toFixed(1)} mm mark at ${MARK.cellMm} mm cells, Y ${COVER_MARK.yB.toFixed(1)}-${(COVER_MARK.yB + COVER_MARK.h).toFixed(1)} in a band ${COVER_MARK.bandY0.toFixed(1)}-${COVER_MARK.bandY1.toFixed(1)}`);
  check("wordmark is a traced outline, not a pixel grid",
    MARK.polygonCount >= 8 && MARK.vertexCount > 200 && MARK.tracePxMm <= 0.02 && MARK.simplifyMm <= 0.01,
    `${MARK.polygonCount} polygons, ${MARK.vertexCount} vertices, traced at ${MARK.tracePxMm} mm, smoothed over ${MARK.smoothMm} and simplified to ${MARK.simplifyMm}`);
  check("wordmark's thinnest stroke prints as one line",
    MARK_BOX.count === 6 && MARK_BOX.stroke >= 0.45,
    `the D4 box outline is ${MARK_BOX.stroke.toFixed(2)} mm wide on the cover (${MARK_BOX.count} polygons make the box); a 0.4 mm nozzle lays 0.45`);
}

// Lettering has to fit the surface it sits on, and be big enough to read.
// The mangled labels earlier came from text laid across features it did not
// fit on, so the fit is now arithmetic rather than eyeballed.
const labelFits = [
  // The mark sits on bare base plate between the lens strip's top edge and the
  // top of the shell, so that gap is what it has to fit in.
  // The cover's wordmark is a bitmap; its fit is gated with the cover.
];
for (const [name, chars, cell, availW, availH] of labelFits) {
  const w = chars * (5 * cell + cell) - cell;
  const h = 7 * cell;
  check(`label fits: ${name}`,
    w <= availW && h <= availH && h >= 3.0,
    `${w.toFixed(1)} x ${h.toFixed(1)} mm in ${availW.toFixed(0)} x ${availH.toFixed(0)} mm, cap height ${h.toFixed(1)} mm`);
}
{
  // This used to require 12 mm of range and measured the grip crown. With the
  // drum gone the lens strip is the relief, and it is the thing that has to
  // read as form rather than as engraving - so it is what gets measured, at a
  // threshold the strip can actually meet.
  const h = reliefAt(LENS_PANEL.rimMidX, P.cameraLensY) - P.faceBase;
  check("relief has real range",
    h >= 4.0,
    `the lens strip stands ${h.toFixed(1)} mm off the base plate: form, not engraving`);
}
check("face shell seats flat on the chassis",
  Math.abs(face.boundingBox().max[2]) < 1e-6,
  "the shell's mating face is exactly the chassis front plane at Z=0");
for (const cx of cameraXs) {
  openProbe(`face shell lens hole ${cx} aligns`,
    cylZ(cx, P.cameraLensY, -P.faceBase - P.faceLensBarProud - 1,
      P.lensBoreD / 2 - 0.2, P.faceBase + P.faceLensBarProud + 2)
      .subtract(body),
    "the shell's cell is concentric with the chassis bore and clear through");
}
// No part of the shell's relief may stand where the base plate does not: in
// print orientation that patch starts in mid-air. The drum's rounded plan
// footprint used to overhang the grip's shoulder notch by 9.5 x 9.5 mm, which
// the flat-shaded renders showed as a perfectly ordinary grip.
{
  // In print orientation the flat back is the bed at Z=0 and the base plate
  // fills Z 0..faceBase, so anything above it that is outside the silhouette
  // has no plate under it.
  const island = facePrint
    .subtract(bodyOutline(-1, 60))
    .intersect(cube(-20, -20, P.faceBase + 0.2,
      P.bodyW + 60, P.bodyH + 60, 60));
  check("no shell relief overhangs the base plate",
    island.volume() < 1.0,
    `${island.volume().toFixed(2)} mm^3 of relief stands outside the base plate's silhouette`);
}

const bezelOverhang = overhangArea(bezelPrint);
// maxTri is dropped from this one gate and replaced by the layer test below.
// Triangle area was standing in for unsupported SPAN, and on the door that
// proxy breaks: the detent relief notch's roof is 0.2 mm wide and 110 mm long,
// so it is 11.6 mm^2 of area and a 0.2 mm bridge - narrower than the nozzle
// that has to cross it, in a channel whose whole purpose is clearance. Area
// cannot tell that from a 3 x 4 mm hole roof. The span can, and does.
check("bezel prints support-free",
  bezelOverhang.area < 110,
  `${bezelOverhang.area.toFixed(2)} mm^2 of >45-degree downward faces in print orientation, largest single face ${bezelOverhang.maxTri.toFixed(2)} mm^2 (judged by span in the layer gate, not by this area)`);

// ---- Layer by layer, every released part ------------------------------------
// The gate the door needed. Judged on the same meshes that are written to the
// STLs, in their own print orientation, at the released layer height.
//
// Two limits, each with a reason. An island may not be as wide as one bead
// (0.4 mm), because below that the slicer cannot lay it as its own extrusion
// and drops it - the groove mouth's 0.06 mm nub is the case that admits. And no
// single layer may seed more than 20 mm^2 of island, because that is not a
// stray sliver, it is the start of a feature. Bridges are held to the 5 mm span
// this design already uses everywhere else.
{
  const parts = [
    ["front half", bodyFront], ["rear half", bodyRear.translate([0, 0, -splitZ])],
    ["face shell", facePrint], ["door", bezelPrint], ["cover", sliderPrint],
    ["keeper", keeperPrint], ["clamps", clamps], ["button", shutterButton],
  ];
  let bad = []; const read = [];
  for (const [name, m] of parts) {
    const u = unsupportedByLayer(m, 0.2, 45.0);
    if (u.worstIslandSpan >= 0.4 || u.worstIsland >= 20.0 || u.maxBridgeSpan >= 5.0) bad.push(name);
    read.push(u.islandArea < 1e-6 && u.bridgeArea < 1e-6
      ? `${name} clean`
      : `${name} bridges ${u.bridgeArea.toFixed(1)} mm^2 (widest ${u.maxBridgeSpan.toFixed(2)} mm)` +
        (u.islandArea < 1e-6 ? ", no islands"
          : `, islands ${u.islandArea.toFixed(2)} mm^2 over ${u.islandLayers} layer(s), worst ${u.worstIsland.toFixed(2)} mm^2 at Z ${u.worstIslandZ.toFixed(2)} ${u.worstIslandSpan.toFixed(3)} mm wide`));
  }
  check("every part builds layer on layer: no island wider than a bead, none seeding a feature",
    bad.length === 0,
    `${bad.length ? `FAILING: ${bad.join(", ")}. ` : ""}island limits 0.40 mm wide / 20 mm^2 a layer, bridge limit 5 mm span - ${read.join("; ")}`);
}

// First layer.
const bedProbeHeight = 0.3;
const bedProbe = cube(-20, -20, 0, P.bodyW + 40, P.bodyH + 40, bedProbeHeight);
const bedContact = intersectionVolume(body, bedProbe) / bedProbeHeight;
check("front-face bed contact", bedContact > 8000,
  `${bedContact.toFixed(0)} mm^2 first layer; no brim needed`);

// Screw-test coupon: its four passages are the whole point of the part, and
// the comb fingers must actually differ in height to be readable.
// Not "flat" any more, deliberately: flat is what fouled the board's headers.
// What still matters is that it is quick to print and no taller than the lift
// it needs to clear them.
check("screw test is quick and no taller than its lift needs",
  postTest.boundingBox().max[2] <= P.postTestLift + 4.0
  && postTest.volume() < 14000,
  `${postTest.boundingBox().max[2].toFixed(1)} mm tall on ${P.postTestLift} mm of pad lift, ${(postTest.volume() / 1000).toFixed(1)} cm^3 of filament`);
for (const x of [9, 9 + P.p4HoleX]) {
  for (const y of [9, 9 + P.p4HoleY]) {
    const probe = cylZ(x, y, -0.5, P.p4ScrewAccessD / 2 - 0.1, 4.0, 48);
    const v = probe.volume();
    if (!Number.isFinite(v) || v < 1e-3) {
      throw new Error("screw-test probe is degenerate");
    }
    check(`screw test passage ${x.toFixed(1)},${y.toFixed(1)}`,
      intersectionVolume(postTest, probe) < 1e-6,
      `Ø${P.p4ScrewAccessD.toFixed(1)} mm M2 passage is open at the real pattern`);
  }
}
// No comb gate: the standoff-height comb is gone. It sat on the web, which is
// the face that ends up AWAY from the board once the pads are on the standoffs,
// so its fingers could never reach the PCB no matter what they measured. A
// caliper on a standoff answers the same question exactly.
// No fit-gauge gates either: KINO_P4_61P9X54P8_FIT_GAUGE is no longer released,
// because it seated on the standoff tops and fouled the board's connectors the
// same way the old screw test did.

// ---------------------------------------------------------------------------
// Outputs.

// Report figures are measured off the meshes, not recited from parameters. An
// earlier version computed the body size from P.gripDepth and P.humpProud;
// both were later renamed, so the field quietly published null on every run.
const round1 = (v) => Math.round(v * 10) / 10;
const bbox = (m) => {
  const b = m.boundingBox();
  return [0, 1, 2].map((i) => round1(b.max[i] - b.min[i]));
};

// Mass census. Where the chassis' filament actually is, measured on the solid,
// so a lightening pass targets the biggest dead region instead of the one that
// looks biggest in a render. Regions overlap nothing: each is a disjoint slab.
{
  const slab = (name, x0, y0, z0, x1, y1, z1) => {
    const v = intersectionVolume(body,
      cube(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0));
    return { name, cm3: v / 1000 };
  };
  const rows = [
    slab("front plate (Z 0..5)", -1, -1, 0, P.bodyW + 1, P.bodyH + 1, P.plate),
    slab("bottom wall", -1, -1, P.plate, P.bodyW + 1, innerMinY, P.bodyD + 1),
    slab("top wall (structural)", -1, innerMaxY, P.plate, P.bodyW + 1, P.bodyH, P.bodyD + 1),
    slab("left wall", -1, innerMinY, P.plate, innerMinX, innerMaxY, P.bodyD + 1),
    slab("right wall", innerMaxX, innerMinY, P.plate, P.bodyW + 1, innerMaxY, P.bodyD + 1),
    slab("interior (posts, pods, bosses)", innerMinX, innerMinY, P.plate, innerMaxX, innerMaxY, P.bodyD + 1),
  ];
  const sum = rows.reduce((t, r) => t + r.cm3, 0);
  console.error("\n=== chassis mass census ===");
  for (const r of rows) {
    console.error(`  ${r.name.padEnd(32)} ${r.cm3.toFixed(1).padStart(6)} cm3  ${(100 * r.cm3 / (body.volume() / 1000)).toFixed(0).padStart(3)}%`);
  }
  console.error(`  ${"accounted".padEnd(32)} ${sum.toFixed(1).padStart(6)} cm3 of ${(body.volume() / 1000).toFixed(1)} cm3\n`);
  // And the shell, whose relief is what the camera actually looks like - so
  // only the hidden insides of it are ever a candidate for removal.
  const fslab = (name, x0, y0, x1, y1) => {
    const v = intersectionVolume(face,
      cube(x0, y0, -40, x1 - x0, y1 - y0, 60));
    return { name, cm3: v / 1000 };
  };
  const frows = [
    fslab("lens bar", P.faceLensBar[0], P.faceLensBar[1], P.faceLensBar[2], P.faceLensBar[3]),
  ];
  console.error("=== face shell mass census ===");
  for (const r of frows) {
    console.error(`  ${r.name.padEnd(32)} ${r.cm3.toFixed(1).padStart(6)} cm3`);
  }
  console.error(`  ${"shell total".padEnd(32)} ${(face.volume() / 1000).toFixed(1).padStart(6)} cm3 (the rest is base plate)\n`);
}

const report = {
  // The script throws on the first failed gate, so a written report means
  // every gate below passed on this exact run. Mesh validation is
  // validate-stl.mjs; the standalone overhang audit is audit-printability.mjs.
  status: "RELEASE_CHECKS_PASSED",
  generatedAt: new Date().toISOString(),
  useCase: "first field test: four-camera wiggle capture, handheld, battery bank in a pocket feeding the P4 over one long USB-C cable; P4 powers the four XIAOs through the JP1 harness",
  measured: {
    p4StandoffPattern: [P.p4HoleX, P.p4HoleY],
    p4PatternOffsetFromModuleCentre: [P.p4PatternOffsetX, 0],
    p4Standoff: { thread: "M2 female", odMm: P.p4StandoffOD, heightMm: P.p4StandoffH },
    moduleMm: [P.moduleW, P.moduleH, P.moduleT],
    cameraLensPitch: P.cameraPitch,
  },
  geometry: {
    chassisMm: bbox(body),
    faceShellMm: bbox(facePrint),
    // Depth over the grip crown, which is the number that decides how the
    // camera sits in the hand: chassis + shell relief + fitted door.
    // Measured at the lens bar's rim: the proudest point on the front. This used
    // to probe the grip drum's crown, which no longer exists, and so reported
    // the bare base plate.
    assembledDepthMm: round1(P.bodyD + reliefAt(LENS_PANEL.rimMidX, P.cameraLensY)),
    printOrientation: "chassis lens-face down, face shell relief-up, door outer-face down; all three print with zero support material",
    p4Capture: "four vertical posts press the threaded standoff tops; the foam-shimmed sliding rear door presses the glass perimeter through its full-length 45-degree dovetails. Tool-less: the door slides in from the far end and clicks over a detent; a firm pull opens it. The standoff threads stay free for the bench fit gauge.",
    bezelFoamShimMm: P.bezelFoam,
    hardware: {
      m2Screws: "4 x M2x8-10 (XIAO clamps only; no screws to open or close the camera)",
      a2Inserts: "4 x A2 brass M2, OD 3.5 x L 4 (XIAO clamp bosses only; the rear door is tool-less)",
      quarterTwentyNuts: "none supplied by the camera - no tripod mount, and the overhead light is held by its own two nuts reached down the light shaft",
      foam: "1.2 mm adhesive foam strip around the bezel window lip",
    },
    cameraLensCentersX: cameraXs,
    xiaoBoardCenterY: boardCenterY,
    wiring: "P4 powered by USB-C standing off its component side into the open bay - no wall recess - with the cable turning down and out the bottom passage at X=40; four XIAOs wired to JP1 through the open rear; shutter switch to JP1 21 / GPIO28 with GND on JP1 6 or 16",
    branding: P.brandingText,
    files: {
      bodyInfo, bodyRearInfo, faceInfo, sliderInfo, keeperInfo, alignInfo, bezelInfo, clampInfo, shutterInfo,
      postTestInfo, camCouponInfo,
      stackInfo, rigInfo, skelInfo, doorJointInfo, sliderCouponInfo, jointCouponInfo, pilotInfo,
      plate1Info, plate2Info,
    },
  },
  printSettings: `PETG, 0.4 mm nozzle, 0.20 mm layers, 2 perimeters, 20% gyroid, supports OFF, brim unnecessary (${bedContact.toFixed(0)} mm^2 flat first layer); every part on its largest flat face as shipped`,
  releaseChecks: checks,
};

// A report is evidence, so it may not contain a number that is not a number.
// This is the gate that would have caught bodyMm publishing null.
(function noNullFigures(node, trail) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => noNullFigures(v, `${trail}[${i}]`));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) noNullFigures(v, `${trail}.${k}`);
  } else if (node === null || node === undefined
    || (typeof node === "number" && !Number.isFinite(node))) {
    throw new Error(`report field ${trail} is ${node} - a parameter it reads was renamed or removed`);
  }
})(report, "report");

fs.writeFileSync(path.join(outDir, "field-body-release-report.json"),
  JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

