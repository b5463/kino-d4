import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { wiggleSequence } from '@kino/media';
import { loadAssets, loadCapture, originalFrames, readObject, requireCaptureId, stillSource } from './capture';
import { publishDerived } from './derive';
import { WIGGLE_WEBP_QUALITY, WIGGLE_WIDTH, evenPixels, wiggleFpsFor } from './wiggle';
import { SHARP_INPUT } from '../images/decode';
import { localSharpProvider } from '../ai/localSharp';
import { AiPlanError, resolvePlan } from '../ai/presets';
import { loadAiConfig, resolveAiDecision } from '../ai/provider';
import type { AiConfig } from '../ai/provider';
import type { JobCtx, JobHandler, JobPayload } from './types';

import { ENHANCED_ROLES } from '../ai/operations';
import { WIGGLE_DIRECTION_DEFAULT, WIGGLE_LOOP_DEFAULT } from './wiggle';

export { ENHANCED_ROLES, FORBIDDEN_OPERATIONS, WIGGLE_SAFE_OPERATIONS } from '../ai/operations';

/**
 * `ai-enhance` — the interface, and nothing behind it yet (03 §20).
 *
 * This handler deliberately does no work. It exists so that the *contract* is
 * committed to in code before anything implements it, because every dangerous
 * decision about AI enhancement is a decision about the interface, not about the
 * model: what it is allowed to touch, what it is allowed to replace, and what it
 * is allowed to invent. Writing those down after a model is wired in means
 * writing them around whatever the model already does.
 *
 * ## The contract
 *
 * **Input is the capture's original frames.** Not a thumbnail, not a
 * gallery still, not another enhancement. Enhancing a derivative would put a
 * generation of JPEG/WebP loss *inside* the input to a denoiser, and a second
 * pass over an already-enhanced frame compounds whatever the first pass
 * hallucinated.
 *
 * **Output is a new derivative, under a role of its own.**
 * `enhanced-still` and `enhanced-wiggle` — see `ENHANCED_ROLES`. 03 §20 is
 * explicit: an optional derivative only. The three things a guest can be offered
 * are *Original*, *KINO* and *KINO Enhanced*, which means all three still exist
 * after this job runs.
 *
 * **It never replaces an original, and it never replaces the KINO render.**
 * `original/` is immutable (01 §7) and the client guard enforces it; the KINO
 * still and wiggle keep their own roles and their own keys. An enhancement that
 * overwrote either would make the pipeline lossy in the one direction that cannot
 * be undone — there is no un-enhance.
 *
 * **Only wiggle-safe operations.** `WIGGLE_SAFE_OPERATIONS` is the list, and the
 * reason it is a list rather than a paragraph is that a wigglegram is not one
 * image: it is four viewpoints of one instant, played in sequence. Any operation
 * that invents detail invents it *independently per frame*, and detail that
 * differs between frames is exactly what the eye reads as motion. A denoiser that
 * gently smooths grain is invisible; a model that reconstructs an eyelid draws a
 * slightly different eyelid four times and the subject's face crawls. 03 §20's
 * words for this are "must avoid frame-to-frame hallucination".
 *
 * That is also why **face reconstruction and beauty processing are excluded** and
 * not merely "not default": a face is the part of the frame a viewer looks at
 * hardest, and the part a generative model is most eager to redraw.
 *
 * **A wiggle is enhanced as a set or not at all.** Whatever is applied must be
 * applied with identical parameters to every frame of the capture — one decision
 * per capture, never per frame — or the frames stop being one instant.
 *
 * ## Why a skip rather than a `501`, and why not just leaving the name unhandled
 *
 * A name with no handler fails loudly (Task 22), which is right for a job that
 * *should* work. This one is not broken: no enhancement backend is configured,
 * and the honest report of that is "skipped", once, with a reason. Leaving it
 * unhandled would burn five attempts over ten minutes and end with an `abandoned`
 * row that reads like a fault, on a capture that is perfectly fine.
 *
 * The handler writes nothing and publishes nothing. That is load-bearing: a
 * `processing.completed` for a role with no object behind it would send every
 * subscriber to fetch an asset that does not exist, and an `assets` row would
 * make the capture claim an enhancement it never got.
 */

/** The marker a skipped enhancement reports when no backend is configured. */
export const AI_ENHANCE_SKIP = 'AI_ENHANCE_NOT_CONFIGURED';

export interface AiEnhanceSkipped {
  skipped: string;
  /** Roles written when the enhancement ran; absent on a skip. */
  roles?: readonly string[];
}

/**
 * The provider behind a resolved config. `local` is implemented in-process
 * (sharp, deterministic, no network); remote kinds still have no client —
 * the gate lets them through, and this is where that client will attach.
 */
function providerFor(config: AiConfig, plan: ReturnType<typeof resolvePlan>) {
  if (config.provider === 'local') return localSharpProvider(plan);
  return null;
}

/**
 * Runs the enhancement (audit #62).
 *
 * The gate decides first, and its reason is the answer: DISABLED when
 * AI_MODE is off (the default — nothing generative applies silently),
 * NOT_CONFIGURED when no provider is set, EXTERNAL_NOT_CONSENTED when an
 * external provider lacks AI_ALLOW_EXTERNAL=true. Only past that does any
 * pixel move, and with the local provider none of them leave this process.
 *
 * Set or nothing: both roles are published, or neither is. A capture that
 * offered an enhanced still and no enhanced wiggle would be a wigglegram
 * whose frames disagree about which pipeline made them.
 */
export async function aiEnhance(payload: JobPayload, ctx: JobCtx): Promise<AiEnhanceSkipped> {
  const captureId = requireCaptureId(payload);
  const config = loadAiConfig();
  const decision = resolveAiDecision(config);
  if (!decision.run) return { skipped: decision.reason };

  let plan;
  try {
    plan = resolvePlan(decision.config);
  } catch (error) {
    // A refused operation list is a deployment mistake, not a transient
    // fault: retrying it five times changes nothing.
    if (error instanceof AiPlanError) throw new UnrecoverableError(error.message);
    throw error;
  }

  const provider = providerFor(decision.config, plan);
  if (!provider) return { skipped: AI_ENHANCE_SKIP };

  const capture = await loadCapture(ctx.db, captureId);
  const assets = await loadAssets(ctx.db, capture.id);
  const stored = originalFrames(assets);
  if (stored.length === 0) throw new Error(`capture ${capture.id} has no stored original frames yet`);

  // Originals in, always — never a thumbnail, a still, or another
  // enhancement (03 §20).
  const sources: Buffer[] = [];
  for (const frame of stored) sources.push(await readObject(ctx, frame.objectKey));

  const result = await provider.enhance({
    captureId: capture.id,
    frames: sources,
    operations: plan.operations,
    strength: plan.strength,
  });
  if (result.frames.length !== sources.length) {
    throw new Error(`provider ${provider.name} returned ${result.frames.length} of ${sources.length} frames`);
  }

  const producer = {
    job: 'ai-enhance',
    mode: decision.config.mode,
    provider: { kind: provider.kind, name: provider.name, version: provider.version },
    model: decision.config.model ?? provider.name,
    operations: result.applied,
    strength: plan.strength,
    sourceRole: 'original-frame',
    sourceFrames: stored.length,
  };

  // The still: the same reference frame the KINO still uses, so the two are
  // the same photograph through two pipelines.
  const still = stillSource(capture, assets);
  const referenceIndex = Math.max(0, stored.findIndex((frame) => frame.objectKey === still.key));
  const enhancedStill = await sharp(result.frames[referenceIndex] ?? result.frames[0], SHARP_INPUT)
    .webp({ quality: WIGGLE_WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  await publishDerived(ctx, capture, {
    name: 'enhanced-still.webp',
    role: 'enhanced-still',
    mime: 'image/webp',
    body: enhancedStill.data,
    width: enhancedStill.info.width,
    height: enhancedStill.info.height,
    producer,
  });

  // The wiggle: the enhanced frames through the same geometry and encoder
  // the KINO wiggle uses, so the only difference between the two files is
  // the enhancement itself.
  if (result.frames.length >= 2) {
    const first = await sharp(result.frames[0], SHARP_INPUT).metadata();
    const height = evenPixels(
      Math.round((WIGGLE_WIDTH * (first.height ?? WIGGLE_WIDTH)) / (first.width ?? WIGGLE_WIDTH)),
    );
    const pages: Buffer[] = [];
    for (const frame of result.frames) {
      pages.push(
        await sharp(frame, SHARP_INPUT)
          .resize({ width: WIGGLE_WIDTH, height, fit: 'cover' })
          .removeAlpha()
          .raw()
          .toBuffer(),
      );
    }
    const order = wiggleSequence(pages.length, WIGGLE_LOOP_DEFAULT, WIGGLE_DIRECTION_DEFAULT);
    const fps = wiggleFpsFor(capture);
    const delayMs = Math.round(1000 / fps);
    const stacked = Buffer.concat(order.map((index) => pages[index]!));

    const animated = await sharp(stacked, {
      ...SHARP_INPUT,
      raw: { width: WIGGLE_WIDTH, height: height * order.length, channels: 3, pageHeight: height },
    })
      .webp({ quality: WIGGLE_WEBP_QUALITY, loop: 0, delay: order.map(() => delayMs) })
      .toBuffer();

    await publishDerived(ctx, capture, {
      name: 'enhanced-wiggle.webp',
      role: 'enhanced-wiggle',
      mime: 'image/webp',
      body: animated,
      width: WIGGLE_WIDTH,
      height,
      producer: { ...producer, encoder: 'sharp/webp-anim', quality: WIGGLE_WEBP_QUALITY, fps, frames: order.length },
    });
  }

  return { skipped: '', roles: ENHANCED_ROLES };
}

/**
 * The queue's view of it.
 *
 * A separate wrapper because `JobHandler` returns `Promise<void>` and `aiEnhance`
 * returns its reason — and the reason is the deliverable. Widening `JobHandler`
 * to carry a result would change every handler's signature to accommodate the one
 * that does nothing.
 */
export const aiEnhanceHandler: JobHandler = async (payload, ctx) => {
  const result = await aiEnhance(payload, ctx);
  console.log(`[worker] ai-enhance ${payload.jobKey}: ${result.skipped}`);
};
