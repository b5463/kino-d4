import * as THREE from 'three';

/**
 * §8 wire colours (mirrors `NetDef['color']` in `@kino/hardware-profiles`,
 * duplicated here rather than imported so this package never needs the
 * profile's zod schema just to type a palette key).
 */
export type WireColor = 'red' | 'black' | 'yellow' | 'blue' | 'green' | 'grey';

export interface TwinMaterials {
  pcb: THREE.MeshStandardMaterial;
  plastic: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  glassClear: THREE.MeshStandardMaterial;
  acrylicOpal: THREE.MeshStandardMaterial;
  copper: THREE.MeshStandardMaterial;
  keepout: THREE.MeshStandardMaterial;
  wireByColor: Record<WireColor, THREE.Material>;
  highlight: THREE.MeshStandardMaterial;
  selected: THREE.MeshStandardMaterial;
}

/** xray body opacity (§ builders spec) — deliberately far below KEEPOUT_OPACITY
 * so a keepout box still reads as "the solid thing" next to a ghosted body. */
export const XRAY_OPACITY = 0.18;
export const KEEPOUT_OPACITY = 0.32;

const WIRE_HEX: Record<WireColor, number> = {
  red: 0xd9463b,
  black: 0x1c1c1c,
  yellow: 0xe8c93f,
  blue: 0x3f7fe0,
  green: 0x3fae55,
  grey: 0x8a8f96,
};

/**
 * Dark blunt engineering palette for the twin viewport. Every material is a
 * flat `MeshStandardMaterial` with no texture maps — GLB Tier A assets land
 * later; these builders only ever produce Tier B/C proxies (§22).
 *
 * Returns a fresh set of instances on every call so independent scenes (or
 * tests) never share — and accidentally mutate — one another's materials.
 */
export function twinMaterials(): TwinMaterials {
  const pcb = new THREE.MeshStandardMaterial({ color: 0x1b3a2b, roughness: 0.55, metalness: 0.15 });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x202225, roughness: 0.8, metalness: 0.05 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.85 });

  // "Transmission-look" without real transmission: a proxy tier has no
  // environment map to transmit, so this fakes clarity with low opacity and
  // low roughness instead of THREE.MeshPhysicalMaterial's transmission pass.
  const glassClear = new THREE.MeshStandardMaterial({
    color: 0xdfe8ee,
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const acrylicOpal = new THREE.MeshStandardMaterial({
    color: 0xf2f2f0,
    roughness: 0.9,
    metalness: 0,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });

  const copper = new THREE.MeshStandardMaterial({ color: 0xb5722c, roughness: 0.3, metalness: 0.85 });

  const keepout = new THREE.MeshStandardMaterial({
    color: 0xff3b30,
    roughness: 0.6,
    metalness: 0,
    transparent: true,
    opacity: KEEPOUT_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const highlight = new THREE.MeshStandardMaterial({
    color: 0x3fd0ff,
    emissive: 0x0c3f4d,
    roughness: 0.4,
    metalness: 0.1,
  });
  const selected = new THREE.MeshStandardMaterial({
    color: 0xffcf3f,
    emissive: 0x4d3a0c,
    roughness: 0.4,
    metalness: 0.1,
  });

  const wireByColor = (Object.keys(WIRE_HEX) as WireColor[]).reduce<Record<WireColor, THREE.Material>>(
    (acc, name) => {
      acc[name] = new THREE.MeshStandardMaterial({ color: WIRE_HEX[name], roughness: 0.5, metalness: 0.2 });
      return acc;
    },
    {} as Record<WireColor, THREE.Material>,
  );

  return { pcb, plastic, metal, glassClear, acrylicOpal, copper, keepout, wireByColor, highlight, selected };
}
