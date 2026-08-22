// What an enhancement may and may not do (audit #62, 03 §20). These lists
// are the contract every provider is held to, kept in their own module so
// both the job and the plan resolver can read them without a cycle.

/**
 * The two roles an enhancement may write, and the only two. An enhancement
 * is an optional derivative next to the original and the KINO render — all
 * three still exist after the job runs.
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
