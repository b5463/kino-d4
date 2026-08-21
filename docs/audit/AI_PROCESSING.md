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

- `ai-enhance` worker job is a deliberate stub: it records the contract in code — enhanced roles (`enhanced-still`, `enhanced-wiggle`), wiggle-safe operation list, forbidden-operation list, "enhance the set or not at all", originals as input — and returns `AI_ENHANCE_NOT_CONFIGURED` while producing nothing.
- **Missing:** OFF/SUBTLE/CUSTOM has no representation; there is no provider abstraction, no model/version config, no consent gate for external egress, and the stub records no provenance. The enhanced roles are already registered and download-gated despite being unproducible.
- The deterministic KINO look (device recipes: tone, grain, vignette, LUT) is the non-AI character layer and must remain the default aesthetic; AI never substitutes for it.

## Order of work

Provider-independent job interface (local/self-hosted/external behind one contract) → consent/config gating for anything external → provenance recording (`producer` on assets) → SUBTLE preset built from the permitted list → CUSTOM. Nothing ships before the consent gate and provenance exist — those two are the P1s; the enhancement itself is P2.
