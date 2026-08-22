// Subject builders for the virtual bench (issue #72, brief §7). Everything
// is generated geometry and canvas textures — no external assets, nothing
// with a license. Dimensions are millimetres; a subject's origin is where it
// meets its mounting height (feet for people, tabletop legs for the table,
// center for charts). All meshes land on both the viewport layer (0) and the
// sensor layer so the virtual cameras photograph exactly what the user sees.
import * as THREE from 'three';
import type { SubjectKind } from '../state/stageStore';
import { SENSOR_LAYER } from './sensor';

function material(color: string, roughness = 0.85): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
}

function mesh(geometry: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(x, y, z);
  return m;
}

/** A simple articulated human figure, ~1700 mm tall, origin at the feet. */
function buildPerson(shirt: string, skin = '#c99a76'): THREE.Group {
  const g = new THREE.Group();
  const shirtMat = material(shirt);
  const skinMat = material(skin);
  const trouserMat = material('#3a3f4a');
  // legs
  g.add(mesh(new THREE.CapsuleGeometry(70, 620, 6, 12), trouserMat, -100, 380, 0));
  g.add(mesh(new THREE.CapsuleGeometry(70, 620, 6, 12), trouserMat, 100, 380, 0));
  // torso
  g.add(mesh(new THREE.CapsuleGeometry(170, 420, 8, 16), shirtMat, 0, 1010, 0));
  // arms
  g.add(mesh(new THREE.CapsuleGeometry(50, 520, 6, 12), shirtMat, -240, 990, 0));
  g.add(mesh(new THREE.CapsuleGeometry(50, 520, 6, 12), shirtMat, 240, 990, 0));
  // head
  g.add(mesh(new THREE.SphereGeometry(110, 20, 16), skinMat, 0, 1440, 0));
  return g;
}

/** Checkerboard / patch textures need a DOM canvas; in a non-DOM
 * environment the plane falls back to a flat material. */
function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function texturedPlane(wMm: number, hMm: number, texture: THREE.Texture | null, fallback: string): THREE.Group {
  const g = new THREE.Group();
  const mat = texture
    ? new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: fallback, roughness: 0.9, side: THREE.DoubleSide });
  const plane = mesh(new THREE.PlaneGeometry(wMm, hMm), mat);
  // Charts face -Z (toward the lenses) — PlaneGeometry faces +Z, so turn it.
  plane.rotation.y = Math.PI;
  g.add(plane);
  // A thin stand so it reads as a physical target, not a floating decal.
  g.add(mesh(new THREE.BoxGeometry(20, hMm + 300, 20), material('#4a4f57'), 0, -(hMm / 2 + 150) + hMm / 2, 10));
  return g;
}

const MACBETH_ROWS = [
  ['#735244', '#c29682', '#627a9d', '#576c43', '#8580b1', '#67bdaa'],
  ['#d67e2c', '#505ba6', '#c15a63', '#5e3c6c', '#9dbc40', '#e0a32e'],
  ['#383d96', '#469449', '#af363c', '#e7c71f', '#bb5695', '#0885a1'],
  ['#f3f3f2', '#c8c8c8', '#a0a0a0', '#7a7a79', '#555555', '#343434'],
];

export function buildSubject(kind: SubjectKind): THREE.Group {
  let group: THREE.Group;
  switch (kind) {
    case 'person':
      group = buildPerson('#7a4d8f');
      break;
    case 'two-people': {
      group = new THREE.Group();
      const a = buildPerson('#7a4d8f');
      a.position.x = -280;
      const b = buildPerson('#2e6f6a', '#8a6248');
      b.position.x = 280;
      b.rotation.y = -0.25;
      group.add(a, b);
      break;
    }
    case 'group': {
      group = new THREE.Group();
      const shirts = ['#7a4d8f', '#2e6f6a', '#a3572e'];
      shirts.forEach((shirt, i) => {
        const p = buildPerson(shirt, i === 1 ? '#8a6248' : '#c99a76');
        p.position.set((i - 1) * 550, 0, i === 1 ? 350 : 0);
        p.rotation.y = (i - 1) * 0.3;
        group.add(p);
      });
      break;
    }
    case 'calibration-grid':
      group = texturedPlane(
        600,
        450,
        canvasTexture(640, 480, (ctx) => {
          const cell = 80;
          for (let y = 0; y < 6; y++)
            for (let x = 0; x < 8; x++) {
              ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f4f4' : '#101010';
              ctx.fillRect(x * cell, y * cell, cell, cell);
            }
        }),
        '#e8e8e8',
      );
      break;
    case 'color-chart':
      group = texturedPlane(
        600,
        400,
        canvasTexture(600, 400, (ctx) => {
          ctx.fillStyle = '#0c0c0c';
          ctx.fillRect(0, 0, 600, 400);
          MACBETH_ROWS.forEach((row, y) =>
            row.forEach((color, x) => {
              ctx.fillStyle = color;
              ctx.fillRect(10 + x * 98, 10 + y * 98, 88, 88);
            }),
          );
        }),
        '#9a9a9a',
      );
      break;
    case 'texture-target':
      group = texturedPlane(
        500,
        500,
        canvasTexture(512, 512, (ctx) => {
          ctx.fillStyle = '#8f8f8f';
          ctx.fillRect(0, 0, 512, 512);
          // deterministic detail: fine noise + concentric rings + line pairs
          let seed = 7;
          const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
          for (let i = 0; i < 6000; i++) {
            ctx.fillStyle = rand() > 0.5 ? '#6a6a6a' : '#b4b4b4';
            ctx.fillRect(Math.floor(rand() * 512), Math.floor(rand() * 512), 2, 2);
          }
          ctx.strokeStyle = '#111';
          for (let r = 20; r < 240; r += 20) {
            ctx.lineWidth = Math.max(1, 8 - r / 40);
            ctx.beginPath();
            ctx.arc(256, 256, r, 0, Math.PI * 2);
            ctx.stroke();
          }
          for (let i = 0; i < 12; i++) {
            ctx.fillStyle = '#111';
            ctx.fillRect(20 + i * 8, 460, 4 - Math.floor(i / 4), 40);
          }
        }),
        '#8f8f8f',
      );
      break;
    case 'near-object': {
      group = new THREE.Group();
      group.add(mesh(new THREE.BoxGeometry(90, 90, 90), material('#c1443c'), 0, 45, 0));
      group.add(mesh(new THREE.SphereGeometry(45, 18, 14), material('#3c7cc1', 0.4), 90, 45, 20));
      group.add(mesh(new THREE.CylinderGeometry(24, 24, 130, 16), material('#d8b13a'), -80, 65, -10));
      break;
    }
    case 'party-table': {
      group = new THREE.Group();
      const wood = material('#6b4a2f', 0.7);
      group.add(mesh(new THREE.BoxGeometry(800, 30, 500), wood, 0, 735, 0));
      for (const [x, z] of [[-370, -220], [370, -220], [-370, 220], [370, 220]] as const) {
        group.add(mesh(new THREE.BoxGeometry(40, 720, 40), wood, x, 360, z));
      }
      group.add(mesh(new THREE.CylinderGeometry(35, 35, 260, 14), material('#2c5d3f', 0.3), -180, 880, 60));
      group.add(mesh(new THREE.CylinderGeometry(35, 35, 260, 14), material('#54331f', 0.3), -80, 880, -90));
      group.add(mesh(new THREE.CylinderGeometry(30, 24, 110, 12), material('#d8433b'), 140, 805, 40));
      group.add(mesh(new THREE.CylinderGeometry(30, 24, 110, 12), material('#3b6bd8'), 230, 805, -70));
      break;
    }
  }
  // Photographable by the virtual sensors AND visible in the main viewport.
  group.traverse((obj) => obj.layers.enable(SENSOR_LAYER));
  return group;
}

/** Rough bounding height (mm) per kind — used by tests and framing hints. */
export function subjectHeightMm(kind: SubjectKind): number {
  switch (kind) {
    case 'person':
    case 'two-people':
    case 'group':
      return 1700;
    case 'calibration-grid':
      return 450;
    case 'color-chart':
      return 400;
    case 'texture-target':
      return 500;
    case 'near-object':
      return 130;
    case 'party-table':
      return 1010;
  }
}
