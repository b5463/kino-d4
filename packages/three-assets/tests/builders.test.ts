import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { D4_V1, resolveDimensions } from '@kino/hardware-profiles';
import type { ComponentDef } from '@kino/hardware-profiles';
import { buildComponentObject, buildAcrylicPanel, applyVisualMode, fallbackBoxMm } from '../src/builders';

function findComponent(id: string): ComponentDef {
  const c = D4_V1.components.find((x) => x.id === id);
  if (!c) throw new Error(`fixture missing component "${id}" — is d4-v1.json still shaped as expected?`);
  return c;
}

describe('fallbackBoxMm', () => {
  it('replaces a null axis with the 5mm MEASURE_REQUIRED placeholder', () => {
    expect(fallbackBoxMm([null, 55, 73])).toEqual([5, 55, 73]);
  });

  it('replaces every axis when all three are unknown', () => {
    expect(fallbackBoxMm([null, null, null])).toEqual([5, 5, 5]);
  });

  it('passes known dims through unchanged', () => {
    expect(fallbackBoxMm([21, 17.8, 15])).toEqual([21, 17.8, 15]);
  });
});

describe('buildComponentObject — camera-node (XIAO ESP32-S3 Sense)', () => {
  const component = findComponent('camera-node');
  const resolved = resolveDimensions(component);

  it('resolves the official 21x17.8x15mm spec with no conflict', () => {
    expect(resolved.sizeMm).toEqual([21.0, 17.8, 15.0]);
    expect(resolved.confidence).toBe('OFFICIAL_SPEC');
  });

  it('names the group after the instance and tags userData', () => {
    const group = buildComponentObject(component, { resolved, instanceId: 'cam2' });
    expect(group.name).toBe('cam2');
    expect(group.userData).toEqual({ componentId: 'camera-node', instanceId: 'cam2', selectable: true });
  });

  it('bounds the physical proxy (body + lens + usb) to the official envelope, plus the lens protruding on +Z', () => {
    const group = buildComponentObject(component, { resolved, instanceId: 'cam2' });

    // The service-usb keepout is a clearance zone, not part of the physical
    // part — it's expected to reach outside the board (§8 "service" kind),
    // so it's deliberately excluded from this envelope check.
    const box = new THREE.Box3();
    for (const child of group.children) {
      if (child.name.startsWith('keepout:')) continue;
      box.expandByObject(child);
    }
    const size = box.getSize(new THREE.Vector3());

    // X/Y come straight from the resolved dims — the usb detail mesh is
    // inset flush with the body, so nothing extends past them.
    expect(size.x).toBeCloseTo(21, 1);
    expect(size.y).toBeCloseTo(17.8, 1);
    // Z includes the Ø8x4.5mm lens barrel protruding fully beyond the +Z
    // face, so it sits above the bare 15mm envelope by about the lens height.
    expect(size.z).toBeGreaterThan(15);
    expect(size.z).toBeLessThanOrEqual(15 + 4.5 + 0.01);
  });

  it('emits the lens and usb detail meshes', () => {
    const group = buildComponentObject(component, { resolved, instanceId: 'cam2' });
    expect(group.getObjectByName('lens')).toBeInstanceOf(THREE.Mesh);
    expect(group.getObjectByName('usb')).toBeInstanceOf(THREE.Mesh);
  });

  it('emits exactly one keepout child, for the service-usb clearance box', () => {
    const group = buildComponentObject(component, { resolved, instanceId: 'cam2' });
    const keepouts = group.children.filter((child) => child.name.startsWith('keepout:'));
    expect(keepouts.map((k) => k.name)).toEqual(['keepout:service-usb']);
  });
});

describe('buildComponentObject — main-display (conflicting OFFICIAL_SPEC sources)', () => {
  const component = findComponent('main-display');
  const resolved = resolveDimensions(component);

  it('flags CONFLICT confidence — the two public specs disagree by more than 0.5mm', () => {
    expect(resolved.confidence).toBe('CONFLICT');
    expect(resolved.conflict).not.toBeNull();
  });

  it('emits at least 6 keepout children', () => {
    const group = buildComponentObject(component, { resolved, instanceId: 'display' });
    const keepouts = group.children.filter((child) => child.name.startsWith('keepout:'));
    expect(keepouts.length).toBeGreaterThanOrEqual(6);
  });

  it('emits a glass active-area mesh smaller than the module footprint', () => {
    const group = buildComponentObject(component, { resolved, instanceId: 'display' });
    const glass = group.getObjectByName('glass');
    expect(glass).toBeInstanceOf(THREE.Mesh);

    const glassBox = new THREE.Box3().setFromObject(glass as THREE.Mesh).getSize(new THREE.Vector3());
    expect(glassBox.x).toBeCloseTo(93.6, 1);
    expect(glassBox.y).toBeCloseTo(56.16, 1);
  });
});

describe('buildComponentObject — flash-led (MEASURE_REQUIRED proxy)', () => {
  const component = findComponent('flash-led');
  const resolved = resolveDimensions(component);

  it('has no measured dims yet, so the body falls back to the 5mm placeholder', () => {
    expect(resolved.sizeMm).toEqual([null, null, null]);
    expect(resolved.measureToLock).toBe(true);
    expect(fallbackBoxMm(resolved.sizeMm)).toEqual([5, 5, 5]);
  });

  it('still emits star, five heatsink fins, and a diffuser', () => {
    const group = buildComponentObject(component, { resolved, instanceId: 'flash' });
    expect(group.getObjectByName('star')).toBeInstanceOf(THREE.Mesh);
    expect(group.getObjectByName('diffuser')).toBeInstanceOf(THREE.Mesh);

    const fins = group.children.filter((child) => child.name.startsWith('fin-'));
    expect(fins).toHaveLength(5);
  });
});

describe('buildComponentObject — battery', () => {
  it('adds a leads exit stub alongside the body', () => {
    const component = findComponent('battery');
    const resolved = resolveDimensions(component);
    const group = buildComponentObject(component, { resolved, instanceId: 'battery' });

    expect(group.getObjectByName('body')).toBeInstanceOf(THREE.Mesh);
    expect(group.getObjectByName('leads')).toBeInstanceOf(THREE.Mesh);
  });
});

describe('buildComponentObject — enclosure chassis', () => {
  it('names its main mesh "skeleton" instead of "body" (panels are built by buildAcrylicPanel)', () => {
    const component = findComponent('enclosure-chassis');
    const resolved = resolveDimensions(component);
    // The real profile's frame instance is itself called "skeleton" (§8), so
    // the group and its main mesh legitimately share that name here — look
    // among the immediate children rather than via getObjectByName, which
    // would just match the group itself first.
    const group = buildComponentObject(component, { resolved, instanceId: 'skeleton' });

    const skeletonMesh = group.children.find((child) => child.name === 'skeleton');
    expect(skeletonMesh).toBeInstanceOf(THREE.Mesh);
    expect(group.children.some((child) => child.name === 'body')).toBe(false);
  });
});

describe('applyVisualMode', () => {
  function buildCam() {
    const component = findComponent('camera-node');
    const resolved = resolveDimensions(component);
    return buildComponentObject(component, { resolved, instanceId: 'cam1' });
  }

  it('xrays the body translucent while the keepout stays comparatively opaque', () => {
    const group = buildCam();

    applyVisualMode(group, 'xray');

    const body = group.getObjectByName('body') as THREE.Mesh;
    const keepout = group.getObjectByName('keepout:service-usb') as THREE.Mesh;
    const bodyMat = body.material as THREE.MeshStandardMaterial;
    const keepoutMat = keepout.material as THREE.MeshStandardMaterial;

    expect(bodyMat.transparent).toBe(true);
    expect(bodyMat.opacity).toBeCloseTo(0.18, 2);
    expect(keepoutMat.opacity).toBeGreaterThan(bodyMat.opacity);
  });

  it('restores the original (opaque) body material on normal', () => {
    const group = buildCam();
    const body = group.getObjectByName('body') as THREE.Mesh;
    const originalMaterial = body.material;

    applyVisualMode(group, 'xray');
    expect(body.material).not.toBe(originalMaterial);

    applyVisualMode(group, 'normal');
    expect(body.material).toBe(originalMaterial);
  });

  it('hides the whole group when mode is "hidden", and un-hides on any other mode', () => {
    const group = buildCam();

    applyVisualMode(group, 'hidden');
    expect(group.visible).toBe(false);

    applyVisualMode(group, 'normal');
    expect(group.visible).toBe(true);
  });

  it('disables raycasting on every descendant while hidden, so a hidden mesh cannot swallow a click', () => {
    // Regression: THREE.Raycaster does not consult Object3D.visible, so
    // `group.visible = false` alone still leaves a hidden instance's meshes
    // registering hits (and starving R3F's onPointerMissed of the empty hit
    // list it needs to fire a deselect/fall-through click).
    const group = buildCam();
    const body = group.getObjectByName('body') as THREE.Mesh;

    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(0, 0, -100), new THREE.Vector3(0, 0, 1));
    expect(raycaster.intersectObject(body, false).length).toBeGreaterThan(0); // sanity: hits when normal/visible

    applyVisualMode(group, 'hidden');
    expect(raycaster.intersectObject(body, false)).toHaveLength(0);
  });

  it('restores normal raycasting once un-hidden', () => {
    const group = buildCam();
    const body = group.getObjectByName('body') as THREE.Mesh;

    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(0, 0, -100), new THREE.Vector3(0, 0, 1));

    applyVisualMode(group, 'hidden');
    applyVisualMode(group, 'normal');
    expect(raycaster.intersectObject(body, false).length).toBeGreaterThan(0);
  });
});

describe('buildAcrylicPanel', () => {
  it('builds a named group sized exactly to the given panel envelope', () => {
    const group = buildAcrylicPanel([126, 80, 3], 'front-acrylic');
    expect(group.name).toBe('front-acrylic');

    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(126, 5);
    expect(size.y).toBeCloseTo(80, 5);
    expect(size.z).toBeCloseTo(3, 5);
  });
});
