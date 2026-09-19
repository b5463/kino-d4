import * as THREE from 'three';
import type { ComponentDef, ResolvedDims } from '@kino/hardware-profiles';
import { twinMaterials, XRAY_OPACITY } from './materials';
import type { TwinMaterials } from './materials';

export interface BuildOpts {
  resolved: ResolvedDims;
  instanceId: string;
  /** Where the lens sits relative to the body centre (the instance's
   * opticalCenterOffsetMm). The XIAO Sense carries its camera at one end of
   * the board, not in the middle; drawn at the centre the barrel missed the
   * body's lens cell by 7 mm. Absent: the centre, as before. */
  lensOffsetMm?: [number, number, number];
}

export type VisualMode = 'normal' | 'xray' | 'highlight' | 'selected' | 'hidden';

/** Cached per-mesh material variants, set at build time and swapped by `applyVisualMode`. */
interface MaterialVariants {
  normal: THREE.Material;
  xray: THREE.Material;
}

// One shared palette per process: the twin renders many instances of the
// same component (four camera nodes), and they should read as one
// consistent physical world rather than four independently-tinted proxies.
// `twinMaterials()` itself stays a plain factory (exported, callable fresh)
// — this module just picks one instance to reuse internally.
let sharedPalette: TwinMaterials | null = null;
function palette(): TwinMaterials {
  if (!sharedPalette) sharedPalette = twinMaterials();
  return sharedPalette;
}

/**
 * Null axes → 5mm placeholder. Used whenever a component's resolved
 * dimensions carry an unmeasured axis (PROVISIONAL / MEASURE_REQUIRED, §6) so
 * the proxy still has *some* silhouette instead of a zero-size mesh.
 */
export function fallbackBoxMm(sizeMm: [number | null, number | null, number | null]): [number, number, number] {
  return [sizeMm[0] ?? 5, sizeMm[1] ?? 5, sizeMm[2] ?? 5];
}


function makeXrayVariant(normal: THREE.Material): THREE.Material {
  const clone = normal.clone();
  clone.transparent = true;
  clone.opacity = XRAY_OPACITY;
  clone.depthWrite = false;
  return clone;
}

/** Builds a box mesh, names it, positions it, and caches its normal/xray material variants. */
function addBox(
  parent: THREE.Object3D,
  name: string,
  sizeMm: [number, number, number],
  offsetMm: [number, number, number],
  material: THREE.Material,
  xrayMaterial?: THREE.Material,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(sizeMm[0], sizeMm[1], sizeMm[2]);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(offsetMm[0], offsetMm[1], offsetMm[2]);
  const variants: MaterialVariants = { normal: material, xray: xrayMaterial ?? makeXrayVariant(material) };
  mesh.userData.materialVariants = variants;
  parent.add(mesh);
  return mesh;
}

function addKeepouts(parent: THREE.Object3D, c: ComponentDef, mats: TwinMaterials): void {
  for (const k of c.keepouts) {
    // Keepouts are already translucent red in normal mode (their whole point
    // is to be seen through), and xray leaves them alone — next to a
    // 0.18-opacity xrayed body they still read as "the solid clearance box".
    addBox(parent, `keepout:${k.id}`, k.sizeMm, k.offsetMm, mats.keepout, mats.keepout);
  }
}

/**
 * Style heuristic only — this never substitutes for a profile dimension.
 * Recognisable circuit boards render as "pcb", recognisable metal hardware
 * as "metal"; everything else, including any component id a future profile
 * introduces, falls through to plain dark plastic rather than throwing
 * (§25 — a new hardware profile needs new data, not a three-assets rewrite).
 */
function pickBodyMaterial(c: ComponentDef, mats: TwinMaterials): THREE.Material {
  const pcbIds = ['main-display', 'camera-node', 'power-module', 'bms', 'camera-switch', 'perfboard'];
  const metalIds = ['fuse', 'tact-switch', 'slide-switch', 'micro-sd'];
  if (pcbIds.includes(c.id)) return mats.pcb;
  if (metalIds.includes(c.id)) return mats.metal;
  return mats.plastic;
}

/** Component-specific detail meshes beyond the generic body box + keepouts. */
function addComponentDetails(
  group: THREE.Group,
  c: ComponentDef,
  sizeMm: [number, number, number],
  mats: TwinMaterials,
  lensOffsetMm?: [number, number, number],
): void {
  const [sx, sy, sz] = sizeMm;

  switch (c.id) {
    case 'camera-node': {
      // Lens barrel Ø8×4.5mm, fully protruding beyond the +Z (subject-facing)
      // face. A silhouette only — never a hard-coded FOV (§7.3/§9, FOV stays
      // null + MEASURE_REQUIRED until real optics work happens in Task 16).
      const lensRadius = 4;
      const lensHeight = 4.5;
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(lensRadius, lensRadius, lensHeight, 24), mats.metal);
      lens.name = 'lens';
      lens.rotation.x = Math.PI / 2; // CylinderGeometry's axis is Y by default; the lens points along Z
      lens.position.set(lensOffsetMm?.[0] ?? 0, lensOffsetMm?.[1] ?? 0, sz / 2 + lensHeight / 2);
      // Only wires/keepouts are exempt from xray — the lens ghosts like any
      // other detail mesh.
      lens.userData.materialVariants = { normal: mats.metal, xray: makeXrayVariant(mats.metal) } satisfies MaterialVariants;
      group.add(lens);

      // Service USB-C face: reflash access from the rear, inset flush with
      // the body so it never grows the group's bounding box.
      const usbSize: [number, number, number] = [8, 3, 3];
      addBox(group, 'usb', usbSize, [0, 0, -sz / 2 + usbSize[2] / 2], mats.metal);
      break;
    }

    case 'light-stud': {
      // A 1/4-20 stud is round: the box body stays for clearance, the
      // visible part is the thread along Y.
      const stud = new THREE.Mesh(new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 20), mats.metal);
      stud.name = 'thread';
      stud.userData.materialVariants = { normal: mats.metal, xray: makeXrayVariant(mats.metal) } satisfies MaterialVariants;
      group.add(stud);
      break;
    }

    case 'top-light': {
      // The emitter face toward the subject (+Z), and the 18 mm base plate
      // the CAD measured, under the body. The body box itself is a
      // PROVISIONAL envelope until the light is measured.
      const emitter: [number, number, number] = [Math.max(sx - 6, 4), Math.max(sy - 6, 4), 0.8];
      addBox(group, 'emitter', emitter, [0, 0, sz / 2 + emitter[2] / 2], mats.acrylicOpal);
      const plate: [number, number, number] = [18, 3, 18];
      addBox(group, 'base-plate', plate, [0, -sy / 2 - plate[1] / 2, 0], mats.metal);
      break;
    }

    case 'main-display': {
      // Active area inset, rear-facing per §7.1 — the glass never claims to
      // fill the whole module footprint (117.01×69.41mm module vs
      // 93.60×56.16mm active area).
      const glassSize: [number, number, number] = [93.6, 56.16, 0.6];
      addBox(group, 'glass', glassSize, [0, 0, -sz / 2 - glassSize[2] / 2], mats.glassClear);
      break;
    }

    // No 'flash-led' arm: ECN-0003 took the flash assembly off D4 V1 (the
    // flash is an external module now), so the star/fin/diffuser proxy had no
    // component left to build. It goes back in with the component, if a
    // profile ever carries one again.

    case 'battery': {
      // "Rounded box" proxy: the body box above already stands in for the
      // pouch (Tier B, §22 — the corner radius isn't worth a bespoke
      // geometry). This adds only the lead exit stub the brief calls out.
      const leadsSize: [number, number, number] = [6, 3, 2];
      addBox(group, 'leads', leadsSize, [0, sy / 2 + leadsSize[1] / 2, 0], mats.metal);
      break;
    }

    default:
      // Generic components (fuse, bms, speaker, perfboard, …) get only the
      // body box + keepouts above. Nothing here to hard-code for them yet.
      break;
  }
}

/**
 * Builds one component instance's proxy geometry. Purely local-space: the
 * caller (scene assembly, a later Phase C task) is responsible for placing
 * the returned group at the instance's `positionMm`/`rotationDeg`.
 */
export function buildComponentObject(c: ComponentDef, o: BuildOpts): THREE.Group {
  const group = new THREE.Group();
  group.name = o.instanceId;
  group.userData = { componentId: c.id, instanceId: o.instanceId, selectable: true };

  const mats = palette();
  const sizeMm = fallbackBoxMm(o.resolved.sizeMm);

  addBox(group, 'body', sizeMm, [0, 0, 0], pickBodyMaterial(c, mats));

  addKeepouts(group, c, mats);
  addComponentDetails(group, c, sizeMm, mats, o.lensOffsetMm);

  return group;
}


/**
 * Swaps every mesh in `root` to the material variant matching `mode`.
 * `hidden` toggles the root's own `visible` flag instead of touching
 * materials — cheaper, and it hides any un-cached children too.
 *
 * It also disables raycasting on every descendant while hidden. three.js's
 * `Raycaster` does not consult `Object3D.visible` at all, so a hidden
 * instance's meshes would otherwise still register hits — swallowing clicks
 * that should fall through to whatever (or nothing) is actually behind
 * them, and starving R3F's `onPointerMissed` of the empty hit list it needs
 * to fire. Toggling view modes (INTERNALS/SHELL/wireframe visibility, this
 * task) makes that reachable, so it is fixed here rather than deferred.
 */
export function applyVisualMode(root: THREE.Object3D, mode: VisualMode): void {
  const mats = palette();

  root.traverse((obj) => {
    if (mode === 'hidden') {
      obj.raycast = () => {}; // no-op override: this object registers no raycast hits while hidden
    } else {
      delete (obj as { raycast?: unknown }).raycast; // restore the prototype's normal raycast
    }

    if (!(obj instanceof THREE.Mesh)) return;
    const variants = obj.userData.materialVariants as MaterialVariants | undefined;
    if (!variants) return;

    switch (mode) {
      case 'normal':
        obj.material = variants.normal;
        break;
      case 'xray':
        obj.material = variants.xray;
        break;
      case 'highlight':
        obj.material = mats.highlight;
        break;
      case 'selected':
        obj.material = mats.selected;
        break;
      case 'hidden':
        break; // handled above
    }
  });

  root.visible = mode !== 'hidden';
}
