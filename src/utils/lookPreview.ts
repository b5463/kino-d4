// Client-side look preview: paints a fixed sample party scene, then
// approximates a recipe's character on top. Clearly an approximation — the
// real render happens on the camera — but close enough to compare looks.
//
// The backing store is sized from the canvas element's own CSS box times the
// device pixel ratio, so nothing is upscaled. The scene is authored in a fixed
// 340x255 design space and drawn through one scale factor, so the composition
// is identical at every size. Grain is the exception: its dots stay one device
// pixel and get more numerous instead of bigger.

import type { Recipe } from '../recipes/recipeTypes';

/** Coordinate space the scene is authored in. 4:3. */
const DESIGN_W = 340;
const DESIGN_H = 255;

/** Backing-store width cap in device pixels — bounds cost per repaint. */
const MAX_BACKING_W = 1200;

/** Grain dots per design pixel at grain = 1, kept as a density. */
const GRAIN_DENSITY = 900 / (DESIGN_W * DESIGN_H);

/** Hard ceiling on grain dots so a big canvas cannot stall a slider drag. */
const MAX_GRAIN_DOTS = 24000;

let baseCanvas: HTMLCanvasElement | null = null;
let baseWidth = 0;

/**
 * Backing-store size for a preview canvas: its own CSS width in device
 * pixels, capped, at the scene aspect. CSS paints the element at
 * `width:100%; height:auto`, so this intrinsic ratio also fixes its height —
 * which is why callers can compare against `canvas.width/height` to decide
 * whether a resize actually needs a repaint.
 */
export function previewBackingSize(target: HTMLCanvasElement): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const cssW = target.clientWidth || target.parentElement?.clientWidth || DESIGN_W;
  const w = Math.max(80, Math.min(MAX_BACKING_W, Math.round(cssW * dpr)));
  return { w, h: Math.round((w * DESIGN_H) / DESIGN_W) };
}

function paintSampleScene(w: number, h: number): HTMLCanvasElement {
  if (baseCanvas && baseWidth === w) return baseCanvas;
  const canvas = baseCanvas ?? document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  baseCanvas = canvas;
  baseWidth = w;

  const s = w / DESIGN_W;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // One scale factor for the whole scene: every coordinate below stays in
  // design units and lands in the same relative spot at any backing size.
  ctx.scale(s, s);

  const bg = ctx.createLinearGradient(0, 0, 0, DESIGN_H);
  bg.addColorStop(0, '#2a1745');
  bg.addColorStop(1, '#7c2f52');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);

  // party lights
  const lights = [
    ['#ff5f8a', 60, 40], ['#4fc3f7', 150, 28], ['#ffd54f', 230, 52], ['#9575ff', 300, 34],
  ] as const;
  for (const [color, x, y] of lights) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, 42);
    g.addColorStop(0, color);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(x - 42, y - 42, 84, 84);
  }

  // skin-tone reference: two faces catching the flash
  for (const [fx, fy, r] of [[125, 118, 26], [215, 130, 22]] as const) {
    const face = ctx.createRadialGradient(fx - r * 0.3, fy - r * 0.3, 2, fx, fy, r);
    face.addColorStop(0, '#f7cfae');
    face.addColorStop(0.8, '#d99e78');
    face.addColorStop(1, '#9c6a4c');
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(fx, fy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // bodies
  ctx.fillStyle = '#171526';
  ctx.fillRect(96, 142, 58, 113);
  ctx.fillRect(192, 150, 48, 105);

  // neutral gray card + white shirt for white-balance reading
  ctx.fillStyle = '#8f8f8f';
  ctx.fillRect(18, 190, 44, 30);
  ctx.fillStyle = '#ececec';
  ctx.fillRect(276, 176, 42, 52);

  // flash falloff
  const flash = ctx.createRadialGradient(
    DESIGN_W / 2, DESIGN_H * 0.45, 10,
    DESIGN_W / 2, DESIGN_H * 0.45, DESIGN_W * 0.7,
  );
  flash.addColorStop(0, 'rgba(255,250,235,0.28)');
  flash.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = flash;
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

/** Render the sample scene with an approximation of the recipe applied. */
export function renderLookPreview(target: HTMLCanvasElement, recipe: Recipe | null) {
  const { w, h } = previewBackingSize(target);
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;

  const base = paintSampleScene(w, h);
  const ctx = target.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  if (!recipe) {
    ctx.drawImage(base, 0, 0);
    return;
  }

  const look = recipe.look;
  const brightness = 1 + recipe.capture.exposureBias * 0.16 - look.blackPoint * 0.004;
  ctx.filter = `contrast(${look.contrast}) saturate(${look.saturation}) brightness(${Math.max(0.5, brightness)})`;
  ctx.drawImage(base, 0, 0);
  ctx.filter = 'none';

  // temperature / tint casts
  if (look.temperature !== 0) {
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = Math.min(0.4, Math.abs(look.temperature) / 400 * 0.45);
    ctx.fillStyle = look.temperature > 0 ? '#ff9a3c' : '#3c8cff';
    ctx.fillRect(0, 0, w, h);
  }
  if (look.tint !== 0) {
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = Math.min(0.25, Math.abs(look.tint) / 20 * 0.25);
    ctx.fillStyle = look.tint > 0 ? '#e879c9' : '#6ecb6e';
    ctx.fillRect(0, 0, w, h);
  }

  // highlight compression: gently pull the brightest zone down
  if (look.highlightCompression > 0) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = look.highlightCompression * 0.9;
    ctx.fillStyle = '#d9d9d9';
    ctx.fillRect(0, 0, w, h);
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // grain — one device pixel per dot, count follows the area so it reads as
  // fine noise at any size instead of scaling up into blobs
  if (look.grain > 0) {
    ctx.globalAlpha = Math.min(0.35, look.grain * 0.7);
    const dots = Math.min(MAX_GRAIN_DOTS, Math.round(w * h * GRAIN_DENSITY * look.grain));
    for (let i = 0; i < dots; i++) {
      ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000';
      ctx.fillRect(Math.floor(Math.random() * w), Math.floor(Math.random() * h), 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  // vignette
  if (look.vignette > 0) {
    const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
    v.addColorStop(0, 'transparent');
    v.addColorStop(1, `rgba(0,0,0,${Math.min(0.55, look.vignette * 1.8)})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  }
}
