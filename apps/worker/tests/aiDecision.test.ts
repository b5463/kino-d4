import { describe, expect, it } from 'vitest';
import { loadAiConfig, resolveAiDecision } from '../src/ai/provider';

describe('AI enhancement gate (audit #62)', () => {
  it('defaults completely closed: empty environment reads as OFF', () => {
    const config = loadAiConfig({});
    expect(config.mode).toBe('off');
    expect(resolveAiDecision(config)).toEqual({ run: false, reason: 'AI_ENHANCE_DISABLED' });
  });

  it('OFF wins over a fully configured provider — nothing applies silently', () => {
    const config = loadAiConfig({
      AI_MODE: 'off',
      AI_PROVIDER: 'local',
      AI_ENDPOINT: 'http://localhost:9500',
      AI_MODEL: 'kino-restore-1',
    });
    expect(resolveAiDecision(config)).toEqual({ run: false, reason: 'AI_ENHANCE_DISABLED' });
  });

  it('SUBTLE without a provider skips as NOT_CONFIGURED', () => {
    const config = loadAiConfig({ AI_MODE: 'subtle' });
    expect(resolveAiDecision(config)).toEqual({ run: false, reason: 'AI_ENHANCE_NOT_CONFIGURED' });
  });

  it('an external provider without explicit consent is refused, never called', () => {
    const config = loadAiConfig({
      AI_MODE: 'subtle',
      AI_PROVIDER: 'external',
      AI_ENDPOINT: 'https://api.example.com',
      AI_MODEL: 'enhance-v2',
    });
    expect(resolveAiDecision(config)).toEqual({ run: false, reason: 'AI_ENHANCE_EXTERNAL_NOT_CONSENTED' });

    const consented = loadAiConfig({
      AI_MODE: 'subtle',
      AI_PROVIDER: 'external',
      AI_ENDPOINT: 'https://api.example.com',
      AI_MODEL: 'enhance-v2',
      AI_ALLOW_EXTERNAL: 'true',
    });
    expect(resolveAiDecision(consented).run).toBe(true);
  });

  it('local and self-hosted providers need no external consent', () => {
    for (const provider of ['local', 'self-hosted'] as const) {
      const config = loadAiConfig({
        AI_MODE: 'custom',
        AI_PROVIDER: provider,
        AI_ENDPOINT: 'http://kino-ai:9500',
        AI_MODEL: 'kino-restore-1',
      });
      expect(resolveAiDecision(config).run).toBe(true);
    }
  });
});
