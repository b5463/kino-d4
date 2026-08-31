// The local enhancement provider (audit #62): sharp, in-process, no model
// and no network. It exists because the first backend behind the contract
// should be the one that cannot hallucinate — every operation here is a
// fixed image-processing step from the wiggle-safe list, applied with
// identical parameters to every frame of a capture.
//
// Deterministic on purpose (AI_PROCESSING.md rule 5, "reproducible where
// possible"): the grain field is seeded from the capture id, so the same
// capture and the same plan produce the same bytes.
import sharp from 'sharp';
import { SHARP_INPUT } from '../images/decode';
import type { EnhanceProvider, EnhanceRequest, EnhanceResult } from './provider';
import type { EnhancePlan, WiggleSafeOperation } from './presets';

export const LOCAL_PROVIDER_NAME = 'kino-local-sharp';
export const LOCAL_PROVIDER_VERSION = '1';

/** Deterministic 32-bit PRNG — same seed, same grain, every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(captureId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < captureId.length; i++) {
    hash ^= captureId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * One grain field for the whole capture. Reusing a single field across every
 * frame is the wiggle-safety property: grain regenerated per frame is
 * high-frequency detail that differs between viewpoints, which the eye reads
 * as crawling motion.
 */
async function grainField(width: number, height: number, seed: number, opacity: number): Promise<Buffer> {
  const random = mulberry32(seed);
  const pixels = Buffer.allocUnsafe(width * height * 4);
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  for (let i = 0; i < width * height; i++) {
    const value = 96 + Math.round(random() * 64);
    pixels[i * 4] = value;
    pixels[i * 4 + 1] = value;
    pixels[i * 4 + 2] = value;
    pixels[i * 4 + 3] = alpha;
  }
  return sharp(pixels, { ...SHARP_INPUT, raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * Applies one plan to one frame. Order is fixed and not configurable:
 * denoise before sharpening (sharpening noise is how a restrained deblur
 * becomes a crunchy one), and grain last so it is not smoothed away by the
 * operation that removed the original grain.
 */
async function applyPlan(
  source: Buffer,
  plan: EnhancePlan,
  grain: { field: Buffer; width: number; height: number } | null,
): Promise<Buffer> {
  const ops = new Set<WiggleSafeOperation>(plan.operations);
  let pipeline = sharp(source, SHARP_INPUT).rotate();

  if (ops.has('jpeg-cleanup')) pipeline = pipeline.median(1);
  if (ops.has('mild-denoise')) pipeline = pipeline.blur(0.3 + plan.strength * 0.5);
  if (ops.has('restrained-deblur')) {
    pipeline = pipeline.sharpen({ sigma: 0.5 + plan.strength, m1: 0, m2: 1 + plan.strength });
  }
  if (ops.has('upscale-1.5x-to-2x')) {
    const meta = await sharp(source, SHARP_INPUT).metadata();
    const factor = 1.5 + plan.strength * 0.5;
    if (meta.width && meta.height) {
      pipeline = pipeline.resize({
        width: Math.round(meta.width * factor),
        height: Math.round(meta.height * factor),
        fit: 'fill',
      });
    }
  }
  if (ops.has('preserve-grain') && grain) {
    pipeline = pipeline.composite([{ input: grain.field, blend: 'overlay' }]);
  }

  // PNG out: the caller encodes the delivered file, so an enhancement never
  // adds a generation of lossy compression of its own.
  return pipeline.png().toBuffer();
}

/**
 * The provider. `enhance` is set-or-nothing by construction: it builds one
 * grain field and one parameter set, then walks the frames — there is no
 * path where frame 2 gets different treatment from frame 1.
 */
export function localSharpProvider(plan: EnhancePlan): EnhanceProvider {
  return {
    name: LOCAL_PROVIDER_NAME,
    version: LOCAL_PROVIDER_VERSION,
    kind: 'local',
    async enhance(request: EnhanceRequest): Promise<EnhanceResult> {
      if (request.frames.length === 0) return { frames: [], applied: [] };

      let grain: { field: Buffer; width: number; height: number } | null = null;
      if (plan.operations.includes('preserve-grain')) {
        const meta = await sharp(request.frames[0], SHARP_INPUT).metadata();
        if (meta.width && meta.height) {
          grain = {
            field: await grainField(meta.width, meta.height, seedOf(request.captureId), 0.06 + plan.strength * 0.06),
            width: meta.width,
            height: meta.height,
          };
        }
      }

      const frames: Buffer[] = [];
      for (const frame of request.frames) frames.push(await applyPlan(frame, plan, grain));

      return {
        frames,
        applied: plan.operations.map((operation) => ({ operation, strength: plan.strength })),
      };
    },
  };
}
