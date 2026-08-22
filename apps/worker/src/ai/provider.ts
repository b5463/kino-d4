// AI enhancement provider contract (audit #62).
//
// The processing pipeline must never couple to one AI vendor, and party
// photographs must never leave for an external service without explicit
// configuration AND consent. This module is the gate and the interface —
// deliberately shipped before any backend, because the decision of where
// pixels may go precedes the code that sends them.

/** OFF is the default. Nothing generative ever applies silently. */
export type AiMode = 'off' | 'subtle' | 'custom';

export type AiProviderKind = 'local' | 'self-hosted' | 'external';

export interface AiConfig {
  mode: AiMode;
  /** Unset = no backend configured; enhancement skips with NOT_CONFIGURED. */
  provider: AiProviderKind | null;
  endpoint: string | null;
  model: string | null;
  /**
   * Explicit consent for frames leaving the platform. Only meaningful for
   * `external`; without it an external provider is refused, never called.
   */
  allowExternal: boolean;
  /** CUSTOM only: comma-separated wiggle-safe operations. */
  operations: string | null;
  /** CUSTOM only: 0..1. Unset falls back to the SUBTLE strength. */
  strength: string | null;
}

/**
 * Provider-independent enhancement interface. Implementations (local model,
 * self-hosted service, external API) all answer this shape; the pipeline
 * records `name`+`version` in the asset's producer so provenance survives a
 * provider swap. No implementation exists yet — see AI_PROCESSING.md.
 */
export interface EnhanceProvider {
  readonly name: string;
  readonly version: string;
  readonly kind: AiProviderKind;
  enhance(request: EnhanceRequest): Promise<EnhanceResult>;
}

export interface EnhanceRequest {
  captureId: string;
  /** Original frames — inputs are always the untouched originals. */
  frames: Buffer[];
  /** Only operations from the wiggle-safe list may appear here. */
  operations: readonly string[];
  /** 0..1; SUBTLE presets sit low. */
  strength: number;
}

export interface EnhanceResult {
  frames: Buffer[];
  /** Recorded verbatim into producer provenance. */
  applied: { operation: string; strength: number }[];
}

export type AiDecision =
  | { run: false; reason: 'AI_ENHANCE_DISABLED' | 'AI_ENHANCE_NOT_CONFIGURED' | 'AI_ENHANCE_EXTERNAL_NOT_CONSENTED' }
  | { run: true; config: AiConfig };

/**
 * The one place that decides whether enhancement may run at all. Order
 * matters: OFF wins over everything (a configured provider with mode off
 * runs nothing), an unconfigured provider cannot run, and an external
 * provider without explicit consent is refused before any code could reach
 * for the network.
 */
export function resolveAiDecision(config: AiConfig): AiDecision {
  if (config.mode === 'off') return { run: false, reason: 'AI_ENHANCE_DISABLED' };
  if (!config.provider) return { run: false, reason: 'AI_ENHANCE_NOT_CONFIGURED' };
  // A local provider runs in this process: it has no endpoint to reach and
  // its identity is the model. Remote kinds still need both, because a
  // half-configured remote is how frames go somewhere nobody chose.
  if (config.provider !== 'local' && (!config.endpoint || !config.model)) {
    return { run: false, reason: 'AI_ENHANCE_NOT_CONFIGURED' };
  }
  if (config.provider === 'external' && !config.allowExternal) {
    return { run: false, reason: 'AI_ENHANCE_EXTERNAL_NOT_CONSENTED' };
  }
  return { run: true, config };
}

/** Reads the AI gate from the environment. Everything defaults closed. */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const mode = env.AI_MODE === 'subtle' || env.AI_MODE === 'custom' ? env.AI_MODE : 'off';
  const provider =
    env.AI_PROVIDER === 'local' || env.AI_PROVIDER === 'self-hosted' || env.AI_PROVIDER === 'external'
      ? env.AI_PROVIDER
      : null;
  return {
    mode,
    provider,
    endpoint: env.AI_ENDPOINT || null,
    model: env.AI_MODEL || null,
    allowExternal: env.AI_ALLOW_EXTERNAL === 'true',
    operations: env.AI_OPERATIONS || null,
    strength: env.AI_STRENGTH || null,
  };
}
