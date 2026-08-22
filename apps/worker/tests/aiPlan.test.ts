// SUBTLE/CUSTOM plans and the local provider (audit #62). The dangerous
// properties are structural, so they are what this asserts: forbidden
// operations are refused rather than filtered, and every frame of a capture
// gets identical treatment — including one shared grain field, which is what
// keeps four viewpoints reading as one instant.
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { AiPlanError, resolvePlan, SUBTLE_PRESET } from '../src/ai/presets';
import { localSharpProvider, LOCAL_PROVIDER_NAME } from '../src/ai/localSharp';
import { loadAiConfig } from '../src/ai/provider';
import { FORBIDDEN_OPERATIONS, WIGGLE_SAFE_OPERATIONS } from '../src/ai/operations';

const config = (env: NodeJS.ProcessEnv) => loadAiConfig(env);

async function frame(seed: number): Promise<Buffer> {
  // A noisy gradient: something a denoise/sharpen pair actually changes.
  const width = 64;
  const height = 48;
  const pixels = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const value = (i * 7 + seed * 31) % 256;
    pixels[i * 3] = value;
    pixels[i * 3 + 1] = 255 - value;
    pixels[i * 3 + 2] = (value * 3) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

describe('enhancement plans', () => {
  it('SUBTLE is restrained: no upscale, grain put back, low strength', () => {
    const plan = resolvePlan(config({ AI_MODE: 'subtle', AI_PROVIDER: 'local' }));
    expect(plan).toEqual(SUBTLE_PRESET);
    expect(plan.operations).not.toContain('upscale-1.5x-to-2x');
    expect(plan.operations).toContain('preserve-grain');
    expect(plan.strength).toBeLessThanOrEqual(0.3);
    for (const operation of plan.operations) expect(WIGGLE_SAFE_OPERATIONS).toContain(operation);
  });

  it('CUSTOM takes the configured operations and strength', () => {
    const plan = resolvePlan(
      config({ AI_MODE: 'custom', AI_PROVIDER: 'local', AI_OPERATIONS: 'jpeg-cleanup,mild-denoise', AI_STRENGTH: '0.6' }),
    );
    expect(plan.operations).toEqual(['jpeg-cleanup', 'mild-denoise']);
    expect(plan.strength).toBe(0.6);
  });

  it('refuses a forbidden operation outright — never silently filtered', () => {
    for (const forbidden of FORBIDDEN_OPERATIONS) {
      expect(() =>
        resolvePlan(config({ AI_MODE: 'custom', AI_PROVIDER: 'local', AI_OPERATIONS: `mild-denoise,${forbidden}` })),
      ).toThrow(AiPlanError);
    }
  });

  it('refuses an unknown operation and an out-of-range strength', () => {
    expect(() => resolvePlan(config({ AI_MODE: 'custom', AI_PROVIDER: 'local', AI_OPERATIONS: 'make-it-pop' }))).toThrow(
      /wiggle-safe list/,
    );
    expect(() =>
      resolvePlan(config({ AI_MODE: 'custom', AI_PROVIDER: 'local', AI_OPERATIONS: 'mild-denoise', AI_STRENGTH: '3' })),
    ).toThrow(/between 0 and 1/);
    expect(() => resolvePlan(config({ AI_MODE: 'custom', AI_PROVIDER: 'local' }))).toThrow(/AI_OPERATIONS/);
  });
});

describe('local sharp provider', () => {
  it('changes the pixels and reports exactly what it applied', async () => {
    const provider = localSharpProvider(SUBTLE_PRESET);
    const source = await frame(1);
    const result = await provider.enhance({
      captureId: 'cap_ai_1',
      frames: [source],
      operations: SUBTLE_PRESET.operations,
      strength: SUBTLE_PRESET.strength,
    });

    expect(provider.name).toBe(LOCAL_PROVIDER_NAME);
    expect(provider.kind).toBe('local');
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]!.equals(source)).toBe(false);
    expect(result.applied.map((entry) => entry.operation)).toEqual([...SUBTLE_PRESET.operations]);
    for (const entry of result.applied) expect(entry.strength).toBe(SUBTLE_PRESET.strength);
  });

  it('is deterministic: same capture and plan, same bytes', async () => {
    const source = await frame(2);
    const request = {
      captureId: 'cap_ai_2',
      frames: [source],
      operations: SUBTLE_PRESET.operations,
      strength: SUBTLE_PRESET.strength,
    };
    const first = await localSharpProvider(SUBTLE_PRESET).enhance(request);
    const second = await localSharpProvider(SUBTLE_PRESET).enhance(request);
    expect(first.frames[0]!.equals(second.frames[0]!)).toBe(true);
  });

  it('applies one shared grain field, so identical frames stay identical', async () => {
    // Two copies of the same frame must come out byte-identical: grain
    // regenerated per frame is the frame-to-frame hallucination 03 §20 bans.
    const source = await frame(3);
    const result = await localSharpProvider(SUBTLE_PRESET).enhance({
      captureId: 'cap_ai_3',
      frames: [source, source, source, source],
      operations: SUBTLE_PRESET.operations,
      strength: SUBTLE_PRESET.strength,
    });
    expect(result.frames).toHaveLength(4);
    for (const enhanced of result.frames.slice(1)) expect(enhanced.equals(result.frames[0]!)).toBe(true);
  });

  it('a different capture gets a different grain field', async () => {
    const source = await frame(4);
    const plan = SUBTLE_PRESET;
    const a = await localSharpProvider(plan).enhance({ captureId: 'cap_a', frames: [source], operations: plan.operations, strength: plan.strength });
    const b = await localSharpProvider(plan).enhance({ captureId: 'cap_b', frames: [source], operations: plan.operations, strength: plan.strength });
    expect(a.frames[0]!.equals(b.frames[0]!)).toBe(false);
  });
});
