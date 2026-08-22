# AI processing — rules, provenance, restrictions

KINO's aesthetic is the cheap compact camera: flash, grain, imperfect color, real texture. AI may help an image; it must never sterilize it into smartphone computational photography. These are the binding rules for any AI stage, plus the audited current state.

## Rules (binding)

1. **AI is optional, off by default.** Modes: `OFF` / `SUBTLE` / `CUSTOM`. Nothing generative applies silently.
2. **Originals are never touched.** Every AI output is a new derived asset next to the untouched original.
3. **No identity alteration.** Never replace faces, invent facial detail, change expressions/clothing, remove people, replace backgrounds, fake bokeh, or hallucinate detail. Face-aware work is local enhancement without identity change, behind explicit selection.
4. **Permitted, restrained:** mild denoise, detail recovery, careful upscale (1×/2×/4×, export-time, nondestructive), valid motion cleanup, highlight/shadow recovery, JPEG artifact reduction.
5. **Provenance is recorded:** source capture id, pipeline, profile, model/provider + version, strength/settings, export timestamp. Reproducible where possible.
6. **Privacy:** party photographs never leave for an external AI service without explicit configuration and consent. Provider abstraction must support local Studio, self-hosted, and external backends without coupling the pipeline to one vendor.
7. The output must still unmistakably look like it came from KINO.

## Current state (audited)

- `ai-enhance` implements the contract it records: enhanced roles (`enhanced-still`, `enhanced-wiggle`), the wiggle-safe operation list, the forbidden-operation list, "enhance the set or not at all", originals as input.
- OFF / SUBTLE / CUSTOM are real. `resolveAiDecision` is the single gate: OFF wins over any configuration, an unconfigured provider cannot run, and an external provider without `AI_ALLOW_EXTERNAL=true` is refused before any code could reach the network. OFF is the default, and nothing enqueues the job on its own.
- The first backend is `kino-local-sharp` (`apps/worker/src/ai/localSharp.ts`): in-process, no model, no network, deterministic — the grain field is seeded from the capture id and one field is shared by every frame, which is what keeps four viewpoints reading as one instant. SUBTLE is a frozen preset (mild denoise, restrained deblur, grain restored, strength 0.25, no upscale); CUSTOM reads `AI_OPERATIONS`/`AI_STRENGTH` and **rejects** anything off the wiggle-safe list rather than silently filtering it.
- Provenance rides `assets.producer`: mode, provider kind/name/version, model, the operations actually applied with their strength, source role and frame count — beside the `produced_at` every derivative already carries.
- **Missing:** remote provider clients (`self-hosted`/`external` pass the gate and then find no implementation — that is where a client attaches), and a per-roll config surface; the gate is deployment-wide environment configuration today.
- The deterministic KINO look (device recipes: tone, grain, vignette, LUT) is the non-AI character layer and must remain the default aesthetic; AI never substitutes for it.

## Order of work

Provider-independent job interface (local/self-hosted/external behind one contract) → consent/config gating for anything external → provenance recording (`producer` on assets) → SUBTLE preset built from the permitted list → CUSTOM. All five are done, and the P1s (gate, provenance) landed before any enhancement ran, as required.

Remaining, in order: a per-roll mode surface (`rolls.ai_mode` plus a host control) that can only narrow the deployment's environment gate, never widen it; then a remote provider client behind the same `EnhanceProvider` interface — which must not change a single call site.
