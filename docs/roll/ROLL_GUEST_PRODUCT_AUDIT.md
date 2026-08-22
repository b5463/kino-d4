# Roll guest product audit

State of the guest-facing product against the Roll product brief (guest-first, Wiggle-first, live). Audited 2026-08-22 on `apps/roll-web` + `apps/api`. "Exists" means implemented and tested on this branch, not specified.

## The core test

"Scan the QR at a party, is it immediately fun and useful?" — the mechanics exist: QR → live feed → capture detail → save/share, with live arrival over SSE and no account, email, or install required. What would a shared Drive folder NOT give? Today: live arrival, Wiggle playback, QR entry, hearts, host moderation, PIN privacy. Still missing from that answer: My Picks, party display mode, social-format saves.

## Exists

| Brief item | Where |
|---|---|
| Guest entry by QR/URL, no account | `guestUrlFor` (`apps/api/src/rolls/rolls.ts`), roll-web routes |
| Live arrival (real SSE, no mock) | `docs/roll/ROLL_REALTIME_ARCHITECTURE.md` |
| Progressive capture states | thumb-first upload → `preview-ready`; per-derivative `processing.completed` |
| Wiggle playback (loop, pause, frame view) | `apps/roll-web/src/components/WigglePlayer.tsx` |
| Capability-aware assets; single frame renders as a still, no broken Wiggle UI | `mode` + ready-assets-only feed (`captures/feed.ts`) |
| Save | Download links on capture detail (when the host enables downloads) |
| Share | Native Web Share with clipboard fallback (`CaptureDetail.tsx`) |
| Reactions (hearts) | `captures/reactions.ts`, anonymous session |
| PIN-protected Rolls; unguessable slugs | `PinGate.tsx`, `auth/pins.ts`, slug generator |
| Host moderation with live propagation | `captures/moderation.ts` → `capture.hidden`/`capture.deleted` events |
| Live vs archive (open/closed Roll) | roll status ladder, `RollClosed.tsx` |
| Offline resilience: reconnect + head refetch, cached thumbnails | `useRollEvents.ts`, `cache/assets.ts` |
| Idempotent device upload, weak-network proof | `test:uploader --drop-part --dup-retry` |
| Load/liveness test | `npm run party:sim` (issue #75) |
| Twin as a real capture source + camera QR | `docs/roll/ROLL_TWIN_INTEGRATION.md` (issue #75) |
| No social network (no follows, profiles, DMs) | by omission, deliberate |

## Gaps (follow-up candidates, kept in the GitHub project)

| Brief item | State |
|---|---|
| MY PICKS — local favorites view | Hearts exist server-side; there is no guest-local picks screen. |
| "N new" pill instead of force-prepend | New captures prepend into the feed immediately (`useRollFeed.prepend`); a browsing guest gets scrolled content shifted. |
| DISPLAY MODE (TV/projector) + tasteful QR | Not implemented. |
| Social-format outputs (9:16, 4:5, 1:1) | Only original-aspect derivatives (wiggle webp/mp4, gif, stills). |
| SAVE WIGGLE as MP4 one-tap on the capture card | MP4 derivative exists; the guest UI exposes generic download links rather than a labelled SAVE WIGGLE action. |
| NFC entry | Not implemented (QR/URL only). |
| Privacy tiers PUBLIC/UNLISTED/PRIVATE | Implemented tiers are effectively UNLISTED (unguessable slug) and PIN_PROTECTED; no PUBLIC directory (deliberate) and no PRIVATE mode distinct from PIN. |
| Guest analytics (opens, plays, time-to-visibility) | Server metrics exist (`plugins/metrics.ts`); no product-level guest analytics. Party-sim measures time-to-visibility in dev. |
| Restrained AI enhancement in the pipeline | `ai-enhance` job scaffold exists (`apps/worker/src/jobs/aiEnhance.ts`); not part of the default derivative chain. |

## Firmware reality

Milestone 1 firmware has no Wi-Fi/Roll upload and the Twin's current-firmware profile honestly refuses group capture and Roll commands. Nothing in the guest product pretends otherwise; the development path runs through the Twin bridge until the firmware milestone defined in [ROLL_DEVICE_CONTRACT.md](ROLL_DEVICE_CONTRACT.md).
