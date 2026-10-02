# P4 mounting and envelope

User constraint, 2026-09-29: the carrier must fit the P4 dimensions and mount to its onboard inserts. This supersedes the earlier unconstrained 125 mm placement studies and permission to enlarge the carrier outline. Battery and body changes may accommodate the stack depth.

The exact host is **Guition JC4880P443C-I-W**, not JC-ESP32P4-M3-DEV.

## Evidence

Guition's current [specification](https://www.guition.com/icms/upload/fb081940d6fc11f09850077a33e1404f/file/productmanager-productfile/5dfbe9a7c0fc44869270528bd2411b1e/Directory/JC4880P443C_I_W%20Specifications-EN-V1.0_1776241869964.pdf), pages 4 and 7, gives a **117.01 × 69.41 mm overall module envelope**. The separate vector structure drawing in the [vendor-package mirror](https://github.com/wegi1/ESP32P4-JC4880P443C-I-W/blob/main/3-Structure_Diagram/JC4880P443C_I_W_Y-%E6%A8%A1%E5%9E%8B.pdf) shows the same assembly in front, side and rear views. The drawing includes a case variant (`_Y`). It must not be treated as proof of every purchased bare-PCB edge or component height.

The **108 × 60 mm outer screw pattern is not the inner brass-insert pattern**. The four internal circles correspond to the 61.9 × 54.8 mm centre pitch recorded in the existing [bench evidence](../../cad/KINO_FIELD_BODY/README.md). That record distinguishes centre pitch from the previously mistaken outside-edge span. It records M2 inserts, approximately 3.5 mm outside diameter and 3.3 mm projection.

The inner pattern is offset toward one end of the module. Its `-9.3 mm` landscape X offset is drawing-derived and remains physically unverified. The vector drawing corroborates the offset and inner pitch to drawing precision; it does not explicitly dimension these inner centres. Do not turn this into a claimed metrology result.

Page 6 also labels a smaller 114.40 × 66.80 front outline. The existing project records the discrepancy. The A0 uses the explicitly dimensioned 117.01 × 69.41 overall envelope as a provisional rectangular carrier boundary; it does not trace the host PCB's detailed edge profile or claim a fit-tested stack.

## A0 coordinates

View the carrier from its component side with the P4 behind it. The origin is the carrier's upper-left corner, X right, Y down. Match the asymmetric insert pattern orientation; do not mirror the print. The PCB file uses an additional `(50, 50)` mm drawing offset.

| Feature | X (mm) | Y (mm) |
|---|---:|---:|
| H1 | 18.255 | 7.305 |
| H2 | 80.155 | 7.305 |
| H3 | 18.255 | 62.105 |
| H4 | 80.155 | 62.105 |

Each hole is **2.2 mm NPTH for an M2 screw**, with a 7 mm diameter fastener allowance. Placement also excludes the enclosing 7 mm square. The four sockets have centres at X 24.5, 46.5, 68.5, 90.5 mm, Y 34.705 mm; these are board centres, not verified optical centres. Each socket's two rows are 15.24 mm apart, with 2.54 mm pin pitch.

The [1:1 template](outputs/P4-MOUNTING-TEMPLATE-1TO1.pdf) includes the outline, insert holes and a 100 mm scale bar. Its role is to check the drawing-derived offset and orientation against the purchased P4 before committing the board.

## Mounting stack and access

The 3.3 mm insert projection alone is not enough clearance for the P4 components, installed IDC connection and carrier through-hole tails. Use M2 extension spacers on the existing inserts. Spacer length, male-thread engagement and screw lengths remain unselected until the actual component heights and cable bend space are checked. Do not bottom a screw against the display or force the carrier onto an obstructing connector.

The captured carrier uses a keyed 26-pin IDC cable. It is not a verified female connector aligned over the P4 header. Direct electrical mating would require a dimensioned header datum and mating-height selection. P4 USB, SD-card, boot/reset and C6 service access remain mechanical acceptance checks.

Battery retention must be an insulated supported tray within the allowed assembly envelope. The packed footprint study reserves no qualified battery contact area. Do not lay a pouch on the PCB, screw heads, power inductors or header tails. Tray placement and stack depth are part of the unfinished design, tracked in issue #232.

## Pack connector and tall parts (design package 0.1.8)

J1100 (JST B3P-VH, vertical, through-hole) moved to the bottom edge, front face, pins at X 86.19 / 90.15 / 94.15 mm, Y 63.0 mm in the coordinates above; pin 1 (PACK+) is the rightmost. Its courtyard runs X 83.74-96.65 mm, 0.08 mm outside the H4 7 mm fastener exclusion. The battery cable exits the front face upward from the connector; the cell location and harness route are still to be set in the enclosure.

Tallest carrier parts for the stack-height map (manufacturer maximums): L1200 Coilcraft XAL7070 7.0 mm on the back face (facing the P4), L1100 TDK SPM6530 3.0 mm on the back, J1100 JST VH on the front, XIAO sockets Wurth 61300711821 8.5 mm insulator on the front plus the XIAO header body.

