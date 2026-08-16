# Studio spec audit — 02 §2/§5/§6/§14/§16/§30/§32, 07 §14/§16

Audit sweep run as part of Task 13. Each row below was checked against the code that exists, not
against the plan: **already present** means a file was read and the behaviour is there, **implemented
now** means this task built it, **N/A** means the spec asks for something the contract cannot carry
yet and says why.

Line numbers are as of this commit.

| Item | Spec | Verdict | Evidence |
|---|---|---|---|
| Gallery "push to Roll" | 02 §16 | implemented now | `packages/kdp/src/protocol/commands.ts:101` (`UPLOAD_ENQUEUE = 0xaa`), `packages/test-fixtures/src/MockKinoDevice.ts:768,834`, `apps/studio/src/pages/Gallery/PushToRoll.tsx`, `apps/studio/src/pages/Gallery/CaptureInspector.tsx:309,542`. Tests: `rollPage.test.ts` → `(f) push to Roll` (7 cases) |
| `.cube` LUT import, 17×17×17 device grid | 02 §14 | implemented now (parser); **partial** — no upload command | `apps/studio/src/recipes/cubeLut.ts`, wired at `apps/studio/src/pages/Looks/LooksPage.tsx:266,579`. Tests: `specAudit.test.ts` → `02 §14 — .cube LUT import` (7 cases). See deviation D-1 |
| KINO look JSON import/export | 02 §14 | already present | `apps/studio/src/pages/Looks/LooksPage.tsx:232` (`importJson` → `validateRecipe`), `:337` IMPORT JSON, `:369` EXPORT JSON; `apps/studio/src/recipes/recipeTypes.ts:55` `validateRecipe`. Tests: `apps/studio/tests/recipes.test.ts` |
| Time sync on connect | 02 §30 | **N/A — no KDP command exists** | No `SET_TIME`/clock/RTC command in `packages/kdp/src/protocol/commands.ts`, none in `MockKinoDevice`, none in `firmware-contract/commands.md`. See deviation D-2 |
| Unsupported-browser explanation | 02 §2 | already present | `apps/studio/src/state/connectionStore.ts:38` (`serialSupported`), `apps/studio/src/components/ConnectHome.tsx:49-53` (explicit "No Web Serial in this browser…" note), `:63-64` (Web Serial NOT AVAILABLE fact row), `:33` (CONNECT disabled), `:36-38` (OPEN DEMO DEVICE stays enabled). Also `apps/studio/src/app/session.ts:123-131` — `connectSerial()` refuses with a stated reason rather than throwing |
| Connection strip — nine states | 02 §6 | implemented now (2 of 9 were missing, 2 collapsed) | `apps/studio/src/state/connectionStore.ts` (`ConnectionFault`, `PHASE_LABEL`, `FAULT_LABEL`, `connectionStrip`), `apps/studio/src/components/ConnectionStrip.tsx`, rendered by `StatusBar.tsx:28` and `Sidebar.tsx:126`. Tests: `specAudit.test.ts` → `02 §6 — connection strip states` (19 cases) |
| Unknown future capability fields tolerated | 07 §14 | already present | `apps/studio/src/state/deviceStore.ts:78-95` — `supports()` / `supportsRollUpload()` read flags by name off the reported object, never off a fixed shape; the wire decoder is `JSON.parse` (`packages/kdp/src/protocol/packet.ts`), and `packages/schemas/src/device.ts:44-70` is `.passthrough()` with `features: z.record(z.unknown())`. Test added anyway (07 §14 asks for it): `specAudit.test.ts` → `tolerates unknown capability fields from a newer camera` |
| Version-mismatch banner | 07 §14 | implemented now | `apps/studio/src/state/connectionStore.ts` (`connectionNotice`), `apps/studio/src/components/ConnectionNotice.tsx`, rendered at `apps/studio/src/components/ConnectHome.tsx:47`; raised by `apps/studio/src/app/session.ts:229` (`handshakeFault`) → `:187`. Tests: `specAudit.test.ts` → `renders a version-mismatch banner when the camera speaks another protocol` |
| Never long-timeout an unsupported command | 07 §14 | already present | `apps/studio/src/app/session.ts:273-277` (capability probe tolerates `KinoUnsupportedError`/`KinoTimeoutError`), `apps/studio/src/pages/Roll/RollPage.tsx:94-110` (`Unsupported` panel instead of a call), `apps/studio/src/components/Sidebar.tsx` `navItems({rollUpload})`. Tests: `rollPage.test.ts` → `(e) capability gating (02 §27)` |
| Gallery scale 0 / 60 / 2,000 / 10,000 rows | 07 §16 | implemented now (test); paging already present | `apps/studio/src/pages/Gallery/galleryPaging.ts` (extracted from `GalleryPage`), `apps/studio/src/pages/Gallery/GalleryPage.tsx:81-85` (cursor pagination, 100-row responses, listing cap), `:154-185` (thumbnails fetched for the open page only, 2 at a time — lazy assets). Tests: `specAudit.test.ts` → `07 §16 — gallery scale` (5 cases, incl. 10,000 rows) |
| HELLO retry ×3, nonce echo, boot-spew resync | 02 §5, §32 | already present — **now on the live path** | `packages/kdp/src/protocol/KinoProtocolClient.ts:154` (`HELLO_ATTEMPTS = 3`), `:270` `hello()`, `:305` nonce echo, `packages/kdp/src/protocol/packet.ts:12-14` (byte-stream decoder, resynchronizes on the magic). Tests: `packages/kdp/tests/decoder-acceptance.test.ts` → `decoder / boot text`, `HELLO / retry`, `HELLO / nonce echo`, `HELLO / protocol negotiation`. Studio reached this code only after this task — see the ledger row below |
| Session-change detection on the live path | 02 §5, §32 (Task 7 ledger) | **implemented now** — this was a real gap | `apps/studio/src/app/session.ts:209-222` (`handshake` now calls `client.hello({knownSessionId})`), `:238-250` (`onSessionChanged` drops cached drafts, bench claim, sound cache). Tests: `specAudit.test.ts` → `02 §5/§32 — session-change detection on the live path`; underlying machinery `packages/kdp/tests/decoder-acceptance.test.ts` → `client / session ID` (5 cases) |

## What the connection-strip audit actually found

02 §6 names nine states. Before this task the strip rendered seven of them, and two of those seven
were the same lamp:

| 02 §6 state | Before | Now |
|---|---|---|
| Connected | `connected` | unchanged |
| Connecting | `requesting-port` / `connecting` / `handshaking` | unchanged |
| Reconnecting | `reconnecting` | unchanged |
| Maintenance | `maintenance` | unchanged |
| Updating | `updating` | unchanged |
| Recovery | *missing* | `recovery` phase, entered when the reconnect loop gives up after a reboot (`session.ts:460`) |
| Disconnected | `disconnected` | unchanged |
| Protocol mismatch | folded into `error` — lamp said `ERROR` | `error` + `fault: 'protocol-mismatch'` → `PROTOCOL MISMATCH` |
| Hardware error | folded into `error` — lamp said `ERROR` | `error` + `fault: 'hardware'` → `HARDWARE ERROR` |

The state machine was left alone apart from the one new phase and the fault discriminator: the point
of the item is rendering coverage, not a rewrite. Both strips (bottom status bar, sidebar footer) had
their own copy of the lamp ternary; they now share `ConnectionStrip`, so a state cannot be named in
one and left as a bare `ERROR` in the other.

`recovery` and `hardware` are interpretations, stated here so they can be argued with:

- **Recovery** — 02 §22 is about a board that no longer runs firmware, which Studio cannot talk to by
  definition. The reachable, honest moment for the state is the one where Studio has just proved it:
  a reboot was expected, twelve reconnect attempts failed, the board never came back. The banner
  points at Updates › Advanced Recovery.
- **Hardware error** — the link to the camera failed without anyone asking for it: the port would not
  open, or a live session's transport dropped. A user-initiated disconnect stays `DISCONNECTED`.

## Deviations

### D-1 — `.cube` LUT is parsed and validated, but not uploaded

02 §14 asks for `.cube` support and a 17×17×17 device LUT. What exists now:

- `parseCubeLut` reads the format, enforces the 17³ grid (a 33³ export is rejected **by name**, not
  silently resampled — down-sampling a cube is a colour decision, not a parsing one), and returns
  `Float32Array(17·17·17·3)`.
- The Looks editor's LUT field imports a `.cube`, validates it, and records its **name** in
  `advanced.lut` (the field `recipeTypes.ts:31` already reserved).

What does not exist: a KDP command to carry the 14,739-float grid to the card. `advanced.lut` is a
name, and the UI says so in as many words rather than implying the camera has the LUT. Closing this
needs a chunked upload in the shape of `SOUND_BEGIN/CHUNK/END` (`0x27`–`0x29`) plus a `lut`
capability flag — a firmware-contract addition, out of scope here.

### D-2 — 02 §30 time sync has no command to ride on

"On connect, optionally sync camera time from computer." There is no `SET_TIME`-class command in KDP
(`commands.ts` has no clock/RTC id in any block), the reference device has no handler, and
`firmware-contract/commands.md` lists none. 04 §7 does not name one either.

Rather than invent a protocol command inside a Studio task, this is recorded as a contract gap.
Closing it needs the same three-part addition `UPLOAD_ENQUEUE` got in this commit:

1. `Cmd.SET_TIME` in `packages/kdp/src/protocol/commands.ts` — next free slot in the Configuration
   block (`0x14`), since the device clock is configuration, not diagnostics.
2. A handler in `MockKinoDevice` plus a `timeSync` capability flag, so Studio can gate the prompt.
3. A row and payload in `firmware-contract/commands.md`, labelled **mock** like the rest of the
   Network/Roll group, and a deviation note in `firmware-contract/README.md` recording that this repo
   allocated the value.

Until then Studio does not offer the prompt: an optional prompt whose only outcome is a NACK is worse
than no prompt.

### D-3 — `UPLOAD_ENQUEUE` (`0xaa`) is a repo allocation

02 §16 requires "push to Roll" and 04 §7 lists no command for it, so this commit allocated the next
free value in the Network/Roll block. Recorded in `firmware-contract/README.md` § D3 and specified in
`firmware-contract/commands.md`.

### D-4 — the gallery lists at most 5,000 rows of a larger card

`GALLERY_LIST_CAP` (`galleryPaging.ts`) stops the mount-time cursor walk at 5,000 rows: a 10,000
capture card is 100 `MEDIA_LIST` round trips before the first tile appears. The header states both
numbers (`N LISTED · M ON CARD`), filters work on what was listed, and the page slice stays bounded
either way. 07 §16 requires pagination, virtualization, lazy assets and no lockup at 10,000 rows —
all four hold — but it is worth saying plainly that row 7,412 is not reachable from the grid today.
A search/jump-to-date control is the real fix, and it is not in this task.

## Testing notes

- Studio's test environment is `node` (`apps/studio/vitest.config.ts`), so components are rendered
  with `react-dom/server`. **Zustand v5 hands `renderToStaticMarkup` the store's *initial* state**, so
  a component that reads a store cannot be driven from a test. Anything whose rendering is asserted
  takes its data as props — that is why `PushToRoll` takes `rollUpload` and `roll`, and why the strip
  lamp was extracted into `ConnectionStrip`.
- The demo camera keeps shooting while a test pages through a large card, so the scale tests assert
  `total` at t0 and bound the walk, rather than demanding an exact row count after 50 round trips.
