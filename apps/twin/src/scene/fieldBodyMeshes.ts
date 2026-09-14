// The field body's shells, as the CAD released them.
//
// hardware/cad/KINO_FIELD_BODY/twin/ holds the six shells in their assembled
// positions, in body coordinates, written by the same generator and gated by
// the same validation as the print files. They are registered here as Tier A
// meshes for the profile's `field-*` components; the profile itself is baked
// from the datums beside them (scripts/bake-twin-body.mjs), so the box each
// mesh is fitted into IS the mesh's own bounding box and the fit is a no-op.
//
// STL rather than a converted GLB: the STL is the released artefact, and a
// conversion step would be a second place for a shell to be stale. Static
// `?url` imports, not `new URL(..., import.meta.url)`: the files live outside
// the app root, and only an asset import reaches them in both the dev server
// (via /@fs/) and the built bundle.
import * as THREE from 'three';
import { registerComponentMesh, stlProvider } from '@kino/three-assets';
import chassisFrontUrl from '../../../../hardware/cad/KINO_FIELD_BODY/twin/KINO_TWIN_CHASSIS_FRONT.stl?url';
import chassisRearUrl from '../../../../hardware/cad/KINO_FIELD_BODY/twin/KINO_TWIN_CHASSIS_REAR.stl?url';
import faceUrl from '../../../../hardware/cad/KINO_FIELD_BODY/twin/KINO_TWIN_FACE.stl?url';
import lensCoverUrl from '../../../../hardware/cad/KINO_FIELD_BODY/twin/KINO_TWIN_LENS_COVER.stl?url';
import sliderKeeperUrl from '../../../../hardware/cad/KINO_FIELD_BODY/twin/KINO_TWIN_SLIDER_KEEPER.stl?url';
import doorUrl from '../../../../hardware/cad/KINO_FIELD_BODY/twin/KINO_TWIN_DOOR.stl?url';

/** Black PETG, matte: what the body is printed in. */
function petg(): THREE.Material {
  // Double-sided and flat-shaded: a printed shell is seen from inside as
  // well as out (X-RAY, INTERNALS, the door off), and facets read as facets.
  return new THREE.MeshStandardMaterial({
    color: '#4a4e55',
    roughness: 0.7,
    metalness: 0.03,
    side: THREE.DoubleSide,
    flatShading: true,
  });
}

const PARTS: Record<string, string> = {
  'field-chassis-front': chassisFrontUrl,
  'field-chassis-rear': chassisRearUrl,
  'field-face-shell': faceUrl,
  'field-lens-cover': lensCoverUrl,
  'field-slider-keeper': sliderKeeperUrl,
  'field-rear-door': doorUrl,
};

let registered = false;

/** Registers the shells once. Safe to call from any scene module's top level. */
export function registerFieldBodyMeshes(): void {
  if (registered) return;
  registered = true;
  for (const [componentId, url] of Object.entries(PARTS)) {
    registerComponentMesh(componentId, stlProvider(url, petg));
  }
}
