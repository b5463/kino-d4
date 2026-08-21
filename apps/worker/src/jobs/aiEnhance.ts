import { requireCaptureId } from './capture';
import type { JobCtx, JobHandler, JobPayload } from './types';

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

/** The marker a skipped enhancement reports. */
export const AI_ENHANCE_SKIP = 'AI_ENHANCE_NOT_CONFIGURED';

/**
 * The two roles an enhancement may write, and the only two.
 *
 * Not from `@kino/schemas`' `ASSET_ROLES` yet — the platform has no enhanced
 * roles registered there, and adding them would put two roles into the document
 * the PWA fetches by while nothing can ever produce them. They arrive in the
 * schema package with the implementation, and this constant is what the
 * implementation has to match.
 */
export const ENHANCED_ROLES = ['enhanced-still', 'enhanced-wiggle'] as const;

/**
 * The operations an implementation may use, from 03 §20's "safer operations"
 * list. Anything not on this list needs the spec changed first.
 *
 * `preserve-grain` is on it for a reason that looks cosmetic and is not: grain is
 * high-frequency detail that a denoiser removes and an upscaler then re-invents
 * differently in every frame. Reapplying a *single* grain field across the whole
 * capture is what keeps the four viewpoints reading as one instant.
 */
export const WIGGLE_SAFE_OPERATIONS = [
  'mild-denoise',
  'jpeg-cleanup',
  'restrained-deblur',
  'upscale-1.5x-to-2x',
  'preserve-grain',
] as const;

/** Operations an enhancement must never perform, whatever a backend offers. */
export const FORBIDDEN_OPERATIONS = [
  'face-reconstruction',
  'beauty-processing',
  'generative-inpainting',
  'frame-interpolation',
] as const;

export interface AiEnhanceSkipped {
  skipped: typeof AI_ENHANCE_SKIP;
}

/**
 * Runs the enhancement, which today means declining to.
 *
 * The capture id is still required, and the payload still validated: a job that
 * would be malformed once a backend exists is malformed now, and finding that out
 * on the day the backend lands is finding it out from production.
 */
export async function aiEnhance(payload: JobPayload, _ctx: JobCtx): Promise<AiEnhanceSkipped> {
  requireCaptureId(payload);
  // Nothing is written, nothing is published, and no `assets` row is touched.
  return await Promise.resolve({ skipped: AI_ENHANCE_SKIP });
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
