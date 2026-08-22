// Tier A mesh swap (issue #30). No converted CAD asset exists in the repo
// yet, so what these prove is the mechanism a dropped-in GLB relies on: the
// proxy is what renders until a mesh is registered, a registered mesh
// replaces only the body, and the profile's dimensions — not the mesh's —
// decide the size.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildComponentObject } from '../src/builders';
import {
  attachComponentMesh,
  clearComponentMeshes,
  fitMeshToBox,
  hasComponentMesh,
  registerComponentMesh,
} from '../src/tierA';
import type { ComponentDef } from '@kino/hardware-profiles';

afterEach(() => clearComponentMeshes());

const component: ComponentDef = {
  id: 'camera-node',
  name: 'XIAO ESP32-S3 Sense',
  qty: 4,
  meshTier: 'A',
  sources: [{ kind: 'OFFICIAL_SPEC', sizeMm: [21, 17.8, 15] }],
  keepouts: [],
};

const build = () =>
  buildComponentObject(component, {
    instanceId: 'cam1',
    resolved: { sizeMm: [21, 17.8, 15], confidence: 'OFFICIAL_SPEC', measureToLock: false, conflict: null },
  });

/** A stand-in for a converted CAD mesh, deliberately the wrong size. */
function fakeCadMesh(): THREE.Object3D {
  return new THREE.Mesh(new THREE.BoxGeometry(100, 40, 10), new THREE.MeshStandardMaterial());
}

describe('tier A mesh registry', () => {
  it('renders the parametric proxy when nothing is registered', async () => {
    const group = build();
    expect(hasComponentMesh('camera-node')).toBe(false);
    expect(await attachComponentMesh(group, 'camera-node', [21, 17.8, 15])).toBe(false);
    expect(group.getObjectByName('body')?.userData.tierA).toBeUndefined();
  });

  it('swaps the body for a registered mesh and keeps the group identity', async () => {
    registerComponentMesh('camera-node', async () => fakeCadMesh());
    const group = build();
    const before = group.children.length;

    expect(await attachComponentMesh(group, 'camera-node', [21, 17.8, 15])).toBe(true);

    const body = group.getObjectByName('body');
    expect(body?.userData.tierA).toBe(true);
    // Only the body was exchanged — nothing added, nothing else removed.
    expect(group.children.length).toBe(before);
    expect(group.name).toBe('cam1');
    expect(group.userData.componentId).toBe('camera-node');
  });

  it('fits the mesh into the profile dimensions, not the other way round', async () => {
    registerComponentMesh('camera-node', async () => fakeCadMesh());
    const group = build();
    await attachComponentMesh(group, 'camera-node', [21, 17.8, 15]);

    const size = new THREE.Box3().setFromObject(group.getObjectByName('body')!).getSize(new THREE.Vector3());
    // Uniform scale to the tightest axis: the 100×40×10 stand-in is bound by
    // its 100 mm length against the 21 mm envelope.
    expect(size.x).toBeCloseTo(21, 3);
    expect(size.y).toBeCloseTo(8.4, 3);
    expect(size.z).toBeCloseTo(2.1, 3);
    // Centred on the component origin, like the proxy it replaced.
    const centre = new THREE.Box3().setFromObject(group.getObjectByName('body')!).getCenter(new THREE.Vector3());
    expect(centre.length()).toBeCloseTo(0, 3);
  });

  it('a failing provider leaves the proxy in place', async () => {
    registerComponentMesh('camera-node', async () => {
      throw new Error('404');
    });
    const group = build();
    expect(await attachComponentMesh(group, 'camera-node', [21, 17.8, 15])).toBe(false);
    expect(group.getObjectByName('body')).toBeDefined();
    expect(group.getObjectByName('body')?.userData.tierA).toBeUndefined();
  });

  it('a zero-extent mesh is returned untouched rather than scaled to infinity', () => {
    const empty = new THREE.Object3D();
    expect(fitMeshToBox(empty, [10, 10, 10]).scale.x).toBe(1);
  });
});
