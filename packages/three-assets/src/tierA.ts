// Tier A mesh registry (issue #30): a component can be backed by a real
// converted CAD mesh instead of its parametric proxy, without any
// application code changing.
//
// The registry holds a *provider* rather than a URL so the GLB path is one
// implementation and not the only one — a test can register a synthetic
// object, and a future source (a packed asset, an inlined buffer) needs no
// new plumbing.
//
// Two rules the swap must never break:
//
//  1. **The profile's dimensions stay authoritative.** A converted mesh is
//     fitted into the resolved bounding box, never the other way round.
//     Clearance, keepouts and the BOM all read the profile numbers; a
//     prettier mesh must not quietly move a wall.
//  2. **The proxy is the fallback, always.** Loading is asynchronous and may
//     fail; the scene shows the parametric box until (and unless) a mesh
//     arrives.
import * as THREE from 'three';

export type MeshProvider = () => Promise<THREE.Object3D>;

const providers = new Map<string, MeshProvider>();

/** Registers the Tier A mesh for a component id. Last registration wins. */
export function registerComponentMesh(componentId: string, provider: MeshProvider): void {
  providers.set(componentId, provider);
}

export function hasComponentMesh(componentId: string): boolean {
  return providers.has(componentId);
}

/** Test/teardown helper — the registry is process-global by design. */
export function clearComponentMeshes(): void {
  providers.clear();
}

/**
 * A provider that loads a GLB with three's GLTFLoader. Kept as a lazy import
 * so the loader is only pulled into a bundle that actually registers one.
 */
export function glbProvider(url: string): MeshProvider {
  return async () => {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    return gltf.scene;
  };
}

/**
 * Scales and centres `mesh` so its bounding box fits `sizeMm` exactly, then
 * returns it. Uniform scale: a per-axis stretch would misrepresent the part.
 * A mesh with no measurable extent is returned untouched — there is nothing
 * to fit, and dividing by zero would send it to infinity.
 */
export function fitMeshToBox(mesh: THREE.Object3D, sizeMm: [number, number, number]): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(mesh);
  const extent = box.getSize(new THREE.Vector3());
  if (extent.x <= 0 || extent.y <= 0 || extent.z <= 0) return mesh;

  const scale = Math.min(sizeMm[0] / extent.x, sizeMm[1] / extent.y, sizeMm[2] / extent.z);
  mesh.scale.multiplyScalar(scale);

  // Re-measure after scaling: centring on the pre-scale box would leave the
  // mesh off-centre by the scale factor.
  const scaled = new THREE.Box3().setFromObject(mesh);
  const centre = scaled.getCenter(new THREE.Vector3());
  mesh.position.sub(centre);
  return mesh;
}

/**
 * Swaps a component group's parametric body for its Tier A mesh, if one is
 * registered. Resolves to true when the swap happened.
 *
 * Everything that is not the body — keepouts, detail geometry, userData,
 * the group's name and transform — is left exactly as the builder made it,
 * which is what keeps selection, clearance and the inspector working
 * unchanged across the swap.
 */
export async function attachComponentMesh(
  group: THREE.Group,
  componentId: string,
  sizeMm: [number, number, number],
): Promise<boolean> {
  const provider = providers.get(componentId);
  if (!provider) return false;

  let mesh: THREE.Object3D;
  try {
    mesh = await provider();
  } catch {
    // A missing or broken asset must never take the scene with it: the
    // parametric proxy is already on screen and stays.
    return false;
  }

  const body = group.getObjectByName('body');
  if (!body) return false;

  fitMeshToBox(mesh, sizeMm);
  mesh.name = 'body';
  mesh.userData = { ...body.userData, tierA: true };
  group.remove(body);
  disposeProxy(body);
  group.add(mesh);
  return true;
}

/**
 * Frees the parametric body this swap just replaced. `remove()` only detaches
 * it — the box geometry and its xray clone were built for this one mesh and
 * nothing else can reach them once the group has let go, so without this a
 * Tier A swap orphaned one geometry and one material per instance.
 *
 * The shared palette is never touched: `materialVariants.normal` (and a
 * keepout's `xray`, which is the same object) belong to every other instance
 * in the scene too, so only an xray variant that is genuinely a clone is
 * disposed.
 */
function disposeProxy(body: THREE.Object3D): void {
  body.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.dispose();
    const variants = obj.userData.materialVariants as { normal: THREE.Material; xray: THREE.Material } | undefined;
    if (variants && variants.xray !== variants.normal) variants.xray.dispose();
  });
}
