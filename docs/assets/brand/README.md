# KINO wordmarks

The original D4 source sheet has been split into four exact crops. Pick the file for the surface behind it.

| File | Use |
|---|---|
| `kino-d4-black-on-light.png` | Primary D4 mark on white or very light surfaces |
| `kino-d4-charcoal-on-light.png` | Softer D4 mark on white or very light surfaces |
| `kino-d4-silver-on-dark.png` | Metallic D4 mark on black or near-black surfaces |
| `kino-d4-white-on-dark.png` | Highest-contrast D4 mark on black or near-black surfaces |
| `kino-studio-wordmark.png` | KINO Studio product mark on a light surface |
| `kino-roll.png` | KINO Roll product mark on a light surface |
| `kino-d4-twin.png` | KINO D4 twin product mark on a light surface |
| `kino-d4-wordmark-sheet.png` | Original four-up source sheet, kept for provenance |

Do not place a light-surface crop on a dark background or invert a raster file in CSS. Use the matching source asset. The root README selects the black or white D4 mark with `prefers-color-scheme`.

## What the apps ship

Every file above is opaque RGB with its field baked in, so none of them can sit
on app chrome directly — Twin's header is `#1b1e24`, Roll's is the header blue,
and a pasted crop would show its own rectangle. Each app therefore carries a
trimmed, transparent, single-ink derivation under `apps/<app>/src/assets/`:

| Derived file | Source | Ink |
|---|---|---|
| `apps/studio/src/assets/kino-studio.png` | `kino-studio-wordmark.png` | black |
| `apps/twin/src/assets/kino-d4-twin-light.png` | `kino-d4-twin.png` | white |
| `apps/roll-web/src/assets/kino-roll-light.png` | `kino-roll.png` | white |
| `apps/roll-web/src/assets/kino-roll-dark.png` | `kino-roll.png` | black |

The derivation keys ink coverage from `255 - luminance` and recolours it. That
is not the CSS inversion forbidden above: because the `*-on-dark` crops are
exact negatives of the `*-on-light` ones, colouring the coverage white
reproduces the official dark-surface artwork, badge knockout included. To
regenerate after a source changes, redo the same two steps — key luminance to
alpha, crop to the ink bounding box.

These derived files stay `LicenseRef-KINO-Reserved` under `REUSE.toml`. The MIT
grant covering `apps/**` must not be allowed to capture them;
`npm run license:check` fails if those paths lose their annotation.
