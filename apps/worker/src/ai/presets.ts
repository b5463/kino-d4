// SUBTLE and CUSTOM operation plans (audit #62, AI_PROCESSING.md order of
// work: preset built from the permitted list, then CUSTOM). A plan is a set
// of wiggle-safe operations plus one strength, applied identically to every
// frame of a capture — never per frame, or the four viewpoints stop being
// one instant.
import { FORBIDDEN_OPERATIONS, WIGGLE_SAFE_OPERATIONS } from './operations';
import type { AiConfig } from './provider';

export type WiggleSafeOperation = (typeof WIGGLE_SAFE_OPERATIONS)[number];

export interface EnhancePlan {
  operations: readonly WiggleSafeOperation[];
  /** 0..1. */
  strength: number;
}

/**
 * The SUBTLE preset: restrained by construction. No upscale (it changes the
 * frame's dimensions, which is not what "subtle" means) and grain is put
 * back after denoising, because grain removed and not restored is the exact
 * smartphone-computational look the product exists to avoid.
 */
export const SUBTLE_PRESET: EnhancePlan = Object.freeze({
  operations: Object.freeze(['mild-denoise', 'restrained-deblur', 'preserve-grain']) as readonly WiggleSafeOperation[],
  strength: 0.25,
});

export class AiPlanError extends Error {}

function parseOperations(raw: string): readonly WiggleSafeOperation[] {
  const requested = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (requested.length === 0) throw new AiPlanError('AI_OPERATIONS is empty; CUSTOM needs at least one operation');

  for (const operation of requested) {
    // Rejected, never silently filtered: a deployment that asked for face
    // reconstruction must find out it was refused, not discover later that
    // its config was quietly trimmed.
    if ((FORBIDDEN_OPERATIONS as readonly string[]).includes(operation)) {
      throw new AiPlanError(`operation "${operation}" is forbidden and can never be enabled`);
    }
    if (!(WIGGLE_SAFE_OPERATIONS as readonly string[]).includes(operation)) {
      throw new AiPlanError(
        `operation "${operation}" is not on the wiggle-safe list (${WIGGLE_SAFE_OPERATIONS.join(', ')})`,
      );
    }
  }
  return requested as readonly WiggleSafeOperation[];
}

function parseStrength(raw: string | null): number {
  if (raw === null || raw.trim() === '') return SUBTLE_PRESET.strength;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AiPlanError(`AI_STRENGTH must be a number between 0 and 1, got "${raw}"`);
  }
  return value;
}

/** The plan a mode resolves to. OFF never reaches here — the gate stops it. */
export function resolvePlan(config: AiConfig): EnhancePlan {
  if (config.mode === 'custom') {
    if (!config.operations) throw new AiPlanError('CUSTOM mode needs AI_OPERATIONS');
    return { operations: parseOperations(config.operations), strength: parseStrength(config.strength) };
  }
  return SUBTLE_PRESET;
}
