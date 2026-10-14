# KINO D4 on-device UI

The screen spec for the 4.3-inch panel on the ESP32-P4: what each screen is, how it is laid out, which colour means what, how it moves, and how to check a change. It describes `firmware/p4/main/ui.c` as it is, not a plan.

When this file and the code disagree, the code is right and this file is a bug. `npm run ui:doc:check` fails when a constant named here in backticks no longer exists, when a table row gives a constant a value the code does not hold, or when the palette and launch tables differ from `packages/design-system/kino-device-palette.json`.

The words on the glass are not here. They are in [`docs/DEVICE_COPY.md`](../docs/DEVICE_COPY.md), with the rule every line follows, and `npm run copy:check` holds the two together.

## Files

| File | What it holds |
|---|---|
| `firmware/p4/main/ui.c` | Every screen, the hit test, the moves, the UI task. No NVS and no filesystem: the Twin compiles it to wasm. |
| `firmware/p4/main/ui.h` | `ui_start()`, `ui_set_launch_index()`, `ui_liveness()`, and the screen over KDP: `ui_shot_ask()`, `ui_tap_post()`, `ui_key_post()`, `ui_plate_post()`. |
| `firmware/p4/main/ui_theme.h` | `RGB()`, the launch shade names, the type roles and `K_PAIRS`. |
| `firmware/p4/main/ui_palette.h` | Generated from the palette JSON by `scripts/gen-device-palette.mjs`. Never edited by hand. |
| `firmware/p4/main/ui_motion.h` | Every duration and curve, and the five motion rules. |
| `firmware/p4/main/ui_font.h` | Inter and Oxanium at six sizes, 8-bit coverage. |
| `firmware/p4/main/logo_kino_d4.h` | The KINO D4 wordmark, 8-bit coverage. Reserved, not MIT. |
| `firmware/p4/main/ui_mark_odd_jobs.h` | The ODD JOBS symbol at two sizes, 8-bit coverage. Reserved, not MIT. |
| `firmware/p4/main/gfx.c` | The tile renderer and the panel-orientation moves. |
| `firmware/p4/main/kdp_ui.c` | GET_SCREEN, SCREEN_PLATE, UI_TAP and UI_KEY on the KDP task (#246). It asks `ui.c` and never draws. |
| `firmware/p4/main/conditions.h` | The conditions a screen reports, and their severity. |
| `firmware/p4/host_preview/preview.c` | Renders every screen for both hands and audits them. |
| `firmware/p4/twin_ui/twin_ui.c` | The same `ui.c` in KINO Twin. |

## Screen map

Logical space is `UI_W` x `UI_H`, 800 x 480 px, landscape. The panel's own long axis is vertical; `gfx.c` turns each tile on the way out.

| Screen | Opened from | Back goes to | What it does |
|---|---|---|---|
| `SCR_MENU` | Boot, and Back from the top level | stays | The SHOOT card and five rows: LOOK, GALLERY, ROLL, SETTINGS, POWER. |
| `SCR_SHOOT` | The SHOOT card | `SCR_MENU` | The four streams, a quarter of the panel each, edge to edge. A MENU button on the hand's side. A 34 px status bar at the foot with the look, the mode, the flash when one is fitted (`capture_has_flash()`; D4-V1 has none, so no flash panel and no gap, and the look's panel takes the room), the four (with a count such as 3/4 beside them only when one is missing), STUDIO while Studio talks, and the card only when it is missing or under `COND_CARD_LOW_SHOTS` photographs left and the card pill is not saying it (during the count, which hides the pill, the bar keeps it); a press on the decisions opens LOOK. Outermost at the bar's hand end, the TIMER panel: TIMER OFF in `K_INK_QUIET` or TIMER 10 S in `K_INK`, its own target in the same `SH_LOOK_HIT_H` band, out to the hand's edge. The look's panel takes what is left and cuts a long name with an ellipsis. A pane with no picture says NO PICTURE over a 248 x 52 RESTART THE CAMERAS button; the button is the target, not the pane. |
| `SCR_LOOK` | The LOOK row, or the SHOOT bar | `SCR_MENU`, or `SCR_SHOOT` when opened from it | The look picker, COLOUR or B&W, WIGGLE or QUAD, FLASH AUTO, ON or OFF only with a flash fitted (`capture_has_flash()`: with none the row is two columns, MODE nearer the hand, and no FLASH item is drawn or hit; FN steps nothing), and in QUAD which lens: ALL, or a lens as the four-mark with its cell lit (`lens_glyph()`), no camera numbers. |
| `SCR_GALLERY` | The GALLERY row | `SCR_MENU` | Three by two tiles of 252 x 189 px, the page pair in the header, `n / N` beside the title. |
| `SCR_PHOTO` | A gallery tile, and after a shot | `SCR_GALLERY`; `SCR_SHOOT` after a shot | The photograph in a 600 x 450 well, playing. A 162 px column on the hand's side: the facts, previous and next, DELETE, SEND TO ROLL, FAVOURITE. Previous and next cross gallery pages: past a page's edge the page turns, the photograph stays up, and the near end of the new page opens once the gallery task has read it (`photo_seek_poll()`; the grid after `PHOTO_SEEK_MAX_US`). Only the roll's two ends are dead. A horizontal swipe on the well steps it too, leftwards to the next for either hand (`pure_swipe_dir()`, judged on the lift); while it is down it presses nothing. |
| `SCR_ROLL` | The ROLL row | `SCR_MENU` | The QR a guest scans, the address, the code, one word for the connection, and the counts from the card. |
| `SCR_SETTINGS` | The SETTINGS row | `SCR_MENU` | Six rows: Display, Sound, Connection, Storage, About, Status. |
| `SCR_DISPLAY` | Settings | `SCR_SETTINGS` | Dim after, sleep after, how long a shot stays up, camera idle. |
| `SCR_SOUND` | Settings | `SCR_SETTINGS` | The shutter sound, button and shutter sound on or off, volume. |
| `SCR_CONNECTION` | Settings | `SCR_SETTINGS` | Six facts at a 42 px pitch, and the time-zone pair. |
| `SCR_STORAGE` | Settings | `SCR_SETTINGS` | Card, free space, photos, the used bar, DELETE ALL PHOTOS, FORMAT CARD. |
| `SCR_ABOUT` | Settings | `SCR_SETTINGS` | The unit's facts, each camera's firmware and sensor, MADE BY and the ODD JOBS mark, a help QR. |
| `SCR_STATUS` | Settings | `SCR_SETTINGS` | Every condition, worst first. RESTART THE CAMERAS, and MEASURE AGAIN once the four have been measured. |
| `SCR_POWER` | The POWER row | `SCR_MENU` | Restart, Shut down (drawn disabled: the slide is the switch), Factory reset. |

Rules that hold on every screen:

- Back goes one level, to `SCREEN_PARENT`, never to a remembered screen. Two exceptions, both back to the finder: LOOK opened from the finder (`s_look_from_shoot`), and the review after a shot (`s_review_from_shot`).
- The shutter key takes a photograph on SHOOT and on the untouched review after a shot. On any other screen it opens the finder, and the capture strip reports a running capture over whatever is on the glass. Every key acts on its down edge; a long press does nothing. With TIMER 10 S on SHOOT's bar the shutter starts a `TIMER_S` second count instead (`fire_shutter()`), and the count's end is the capture (`shutter_now()`). Either key or a tap that lands on the picture while it runs cancels it, and so do turning the panel off and leaving SHOOT; each toasts Timer cancelled. A thumb already resting on the picture when the count starts is the framing grip and does not cancel it. Under HOLD a report that lands during the count does not take that press: the cancel comes first and the report waits for the next one. Under a resting thumb the report stays held and the count's end clears it. The setting is session state: off at boot and at the sleep, never written to config.
- A screen sets `s_list_top` while it draws, and the hit test reads it afterwards. A rectangle the hit test computes on its own is the bug `ui.c` kept finding.
- After a good shot on SHOOT the photograph opens for review, for the longer of `shoot.displayAfterShotS` and `MOTION_REVIEW_MIN_S`, plus `MOTION_REVIEW_TAIL_MS`, then returns to the finder as a back move. `-1` holds it until a touch. While its clock runs and nothing has touched it, the shutter fires and the finder slides back in; `shutter_now()` acknowledges the report still up first. With TIMER 10 S on, that press starts the count, which runs on the finder. A report that lands while the self-timer counts opens no review: it stays on SHOOT's banner, and the count's end acknowledges it. A touch stops the clock, and the shutter then only opens the finder. BACK and a confirmed DELETE end on SHOOT, DELETE with the undo toast; the next photograph clears that toast. The clock never carries an open dialog off. Under HOLD the first press acknowledges and the next opens the finder. PHOTO opened from GALLERY has none of this. On PHOTO the capture strip is a card inside the photo well (`PH_STRIP_Y`), clear of the column, and a toast sits above it.

Dialogs are questions and nothing else. Seven exist: `DLG_RESTART`, `DLG_DELETE`, `DLG_DELETE_ALL`, `DLG_FORMAT`, `DLG_FACTORY`, `DLG_WELCOME` and `DLG_UPDATED`. Focus starts on the safe action, the lower row: Cancel, or Keep on `DLG_DELETE` (`dlg_safe_word()`). What a question is about sits between its title and its sentence: DELETE shows the photograph, its gallery tile at half size (`photo_thumb()` through `blit_half()`, a 2 x 2 integer mean; nothing is decoded for it, and with no tile in memory the question is drawn without it), and DELETE ALL and FORMAT CARD show the photographs they take in `K_TYPE_TITLE` (`dlg_count()`; none before the card is counted). A sleep closes an open question with the safe action; the two notes stay. Something the camera is doing, rather than asking, is a strip or a row, never a dialog.

## The hand

The shutter sits on the body's top wall at the +X end. The right hand holds that end, and the only digit free for the glass is the right thumb, pivoting at the panel's right edge. It reaches about 45 mm, the right 400 px.

- Chrome goes on the hand's side. `body.hand` is read once per frame into `s_right_hand`, and every rectangle with a side is an inset from the hand's edge through `from_hand()`. A left-handed shooter is a config write, not a layout.
- Back is a 52 px square at the hand's edge of the header. On GALLERY the page pair sits inward of it. PREV is always the left of a pair, on GALLERY, PHOTO and LOOK: the slots mirror with the hand, reading order does not.
- The menu card, the photo column and the finder's MENU button sit on the hand's side too.
- `HEAD_H` is fixed at 62 px on every detail screen.
- Every touch target is at least 52 px in both directions: 6.1 mm at 8.5 px/mm. On SHOOT and PHOTO, where chrome sits on a picture, the target reaches `HIT_SLOP` past the drawn button.
- `host_preview` sweeps every hit map for both hands. It fails a target under 52 px, chrome on the wrong half or stretched to the far edge, and a pair with NEXT left of PREV.

| Constant | Value | Meaning |
|---|---|---|
| `HEAD_H` | 62 | The header band, px. |
| `BTN_SQ` | 52 | Every icon button: back, the page pair, a picker's two buttons. |
| `HIT_SLOP` | 12 | How far a target reaches past a button drawn on a picture. |
| `HAND_EDGE` | 6 | A contact that begins this close to the hand's edge is a palm, not a finger. |
| `TOUCH_DRIFT` | 40 | A contact that travels further than this is not a tap and fires nothing. |
| `PURE_TAP_MAX_MS` | 2500 | A contact held longer than this, ms, is not a tap. The pressed paint clears while the finger is still down, nothing fires on the lift, and one klog line says so. Not shorter: a slow, deliberate press runs to 2 s. |
| `PURE_SWIPE_TRAVEL_PX` | 120 | A contact on PHOTO's well that travels at least this far across is a swipe, px. |
| `PURE_SWIPE_OFF_AXIS_PX` | 60 | A swipe stays under this many px up or down, or it steps nothing. |
| `PURE_STILL_CONTACT_S` | 10 | Off SHOOT, a contact still this long, s, stops counting as activity. |
| `PURE_STILL_CONTACT_PX` | 40 | Still means within this many panel px of where the contact last moved. |
| `SH_LOOK_HIT_H` | 52 | The SHOOT bar's target, taller than the 34 px bar it covers. |

## Colour

### The rule

- Monochrome at rest. Colour is an event.
- One colour: MAO pink, as the launch shade. It means a press, the SHOOT card, a capture landing, and the boot field warming. Nothing else.
- Red means a fault. Type in red is `K_FAULT_INK`; a red fill carries `K_GROUND` type, never `K_INK`.
- A selection that stays (the live segment, a toggle that is on, a favourite) is `K_ON`: an ink fill with a ground label. Ink, not colour.
- No yellow anywhere: not in the palette, not in the boot field. Cobalt 3D63FF is reserved and unused in v1.
- Greys are neutral in their RGB565 code: G6 = 2 R5 = 2 B5, so the panel shows no green cast.
- Something unavailable recedes: `dim_ink()` on its own row, no edge, no chevron. Never a grey box.

Retired with the MAO base: terracotta E8734A, the peach card E8A183, mint 86D6B4, the green menu ramp, the green-cast greys, and the amber and green boot-field inks.

### The base

From MAO's colour header, mao_ui_type.h in the MAO tree: ground 08080A, ink F1ECE2. The values live in `packages/design-system/kino-device-palette.json`; `npm run palette:gen` writes `ui_palette.h` and `npm run palette:check` fails when it is stale. Contrast is WCAG, computed the way `rel_lum()` in `ui.c` computes it: on the RGB565 code, each channel expanded as `x*255/31` or `x*255/63`.

<!-- ui-doc:palette -->
| Colour | sRGB | RGB565 | On `K_GROUND` | Use |
|---|---|---|---|---|
| `K_GROUND` | 08080A | 0x0841 | 1.00 | Every screen's face, the finder, the photograph, the boot field, sleep. |
| `K_SCRIM` | 000000 | 0x0000 | 1.05 | The scrim over a screen, the panel going dark. |
| `K_SURFACE` | 101010 | 0x1082 | 1.05 | A window or list ground, a status panel, the toast plate, a button at rest on the page. Found by its edge or its content. |
| `K_ROW` | 181818 | 0x18C3 | 1.13 | Every row you can press, and a disabled one. |
| `K_RULE` | 282828 | 0x2945 | 1.36 | The hairline between facts, under a header; the track under a bar. |
| `K_OFF` | 303030 | 0x3186 | 1.52 | A toggle that is off, Cancel, a neutral press, an empty four-mark cell. Only `K_INK` goes on it. |
| `K_EDGE` | 82807B | 0x840F | 5.14 | The edge of a thing you can press. 3.37 on `K_OFF`. |
| `K_INK` | F1ECE2 | 0xF77C | 17.44 | Every word on the dark grounds, the marks, the star, SENT, a selected segment's fill. |
| `K_INK_QUIET` | 8F8B85 | 0x8C50 | 5.73 | Captions, readings, a second line. Never on `K_OFF`. |
| `K_ACCENT_INK` | 2A0E1C | 0x2863 | 1.11 | Type on the launch shade: the SHOOT card, a pressed control. |
| `K_FAULT` | E5484D | 0xE249 | 5.14 | Red as a mark or a fill: a lost camera, a destructive press, the card pill and the lens hint. |
| `K_FAULT_INK` | F26A60 | 0xF34C | 6.79 | Red as type on the dark grounds. |

Roles point at a colour; a role changes meaning by pointing somewhere else.

| Role | Is | For |
|---|---|---|
| `K_FACE` | `K_GROUND` | The menu's and every detail screen's face. |
| `K_ON` | `K_INK` | A selection that stays. |
| `K_ON_INK` | `K_GROUND` | The label or knob on `K_ON`. |
| `K_TITLE` | `K_INK` | A screen's or a dialog's title. |
| `K_MARK` | `K_INK` | The wordmark at sleep and power-down, and every other mark. |
| `K_TOAST` | `K_SURFACE` | The toast's plate, with a `K_EDGE` outline and `K_INK` words. |
| `K_ACCENT` | the launch shade | The SHOOT card, a landed four-mark cell. The boot field's warm inks, `K_BF_WARM`, are built from it. |
| `K_ACCENT_DOWN` | the shade, pressed | The SHOOT card under a finger. |
| `K_PRESS` | `K_ACCENT` | Any control under a finger, with `K_PRESS_INK` (`K_ACCENT_INK`) on it. |

### The launch shade

The pink shifts slightly on each start. `K_LAUNCH` holds eight shades: MAO pink F3A2C4 and seven steps toward lavender C7A6F7, computed offline in OKLCH with the lightness and chroma of F3A2C4 kept and the hue moved by at most 40 % of the gap, 20 degrees in all. It never moves toward orange, peach or yellow. Each shade is a distinct RGB565 code. `K_LAUNCH_DOWN` is the same hue at 84 % of its OKLCH lightness, for a press.

`main.c` owns the boot count and passes it once through `ui_set_launch_index()`; `ui.c` keeps row `boot_count % K_LAUNCH_N` in two halfwords and never reads NVS. `host_preview` and the Twin pass 0, so every render and every Twin picture is row 0. The launch shade colours the SHOOT card, a press, the capture landing and the boot field (`K_BF_WARM`, one row of four inks per shade).

`K_LAUNCH_N` is 8. Contrast is `K_ACCENT_INK` on the shade, the shade on `K_GROUND`, and `K_ACCENT_INK` on the pressed shade. The floors are 7.0, 7.0 and 4.5.

<!-- ui-doc:launch -->
| Row | Shade | Pressed | Ink on shade | Shade on ground | Ink on pressed |
|---|---|---|---|---|---|
| 0 | F3A2C4 | C67D9C | 9.33 | 10.32 | 5.85 |
| 1 | EFA2C6 | C6799C | 9.09 | 10.05 | 5.68 |
| 2 | EFA6CE | C67DA5 | 9.40 | 10.39 | 5.90 |
| 3 | EFA2CE | C679A5 | 9.15 | 10.12 | 5.73 |
| 4 | EFA2D6 | C67DAD | 9.22 | 10.20 | 5.95 |
| 5 | E7A6D6 | BD7DAD | 9.23 | 10.21 | 5.77 |
| 6 | E7A2D6 | BD79AD | 8.99 | 9.94 | 5.60 |
| 7 | E7A6DE | BD7DB5 | 9.31 | 10.30 | 5.82 |

### What colour means

| Event or state | Fill | Ink |
|---|---|---|
| A list row at rest | `K_ROW` | `K_INK` |
| A button at rest (Back, pager, picker, MENU, the photo column) | `K_SURFACE` on the page, `K_OFF` on a surface, `edge_ink()` outline | `K_INK` |
| A control under a finger | `K_PRESS` | `K_PRESS_INK` |
| Selected segment, toggle on, favourite set | `K_ON` | `K_ON_INK` |
| Toggle off, Cancel, a neutral press | `K_OFF`, `K_EDGE` outline | `K_INK` |
| Disabled row | `K_ROW`, no edge, no chevron | `dim_ink(K_INK, K_ROW)` |
| Destructive row at rest | `K_ROW` | `K_FAULT_INK` |
| Destructive row pressed, DELETE pressed | `K_FAULT` | `K_GROUND` |
| Card pill and lens hint on SHOOT | `K_FAULT` pill | `K_GROUND` |
| First-use hint on SHOOT | `K_INK` pill | `K_GROUND` |
| Severity on a STATUS row: PROBLEM, CHECK, NOTE | a 4 px bar beside the row | `K_FAULT_INK`, `K_INK`, `K_INK_QUIET`, always with the word |
| The header chip | none | `K_FAULT_INK` on a FAULT, `K_INK` on a WARN; the readings beside it `K_INK_QUIET` |
| Toast | `K_TOAST`, `K_EDGE` outline | `K_INK` |
| Menu rows | `K_ROW`, flat | `K_INK` |
| SHOOT card | `K_ACCENT` | `K_ACCENT_INK` |
| Capture working | `K_INK` bar; a lens asked `K_OFF`, its frame in easing to `K_INK` over `IN_EASE_MS`, a lens left out a `K_INK` outline. The ease is paced at 20 ms from SAVING only; while frames still cross the links it steps on the finder's own pass | `K_INK` |
| Capture landed | `K_ACCENT` cells for `MOTION_LAND_HOLD_MS`, then back to `K_INK` over `MOTION_LAND_BACK_MS` | `K_INK` |
| Capture partial or failed | `K_FAULT` on the lost cells while the strip is up | `K_INK` |
| ROLL lamp | online `K_INK`, error `K_FAULT`, offline a `K_INK_QUIET` ring | |
| Storage gauge | `K_INK` on `K_RULE` | |
| Star, SENT | `K_INK` | `K_GROUND` on SENT |
| QR | a `K_INK` plate | `K_GROUND` modules |
| Marks | none | `K_MARK` |

A failed capture keeps its red while the strip is up: a lost frame is a fact, not an event. That is the one departure from LAND.

`K_PAIRS` in `ui_theme.h` lists every ink-on-fill pair `ui.c` draws, with its floor: 4.5 for text, 3.0 for edges, marks and the one face over 18 pt. `firmware/p4/host_tests/test_theme.c` measures each with `rel_lum()` once per launch shade, checks the no-yellow guard over the palette and the boot field, the code neutrality of every grey, and that no two colours share a 565 code. `host_preview` measures the same strings again from the pixels they land on. A pair goes into `K_PAIRS` in the same change that first draws it.

## Type

Two families. Caps are set in Oxanium, sentences in Inter. Nothing switches family to make a string fit.

| Role | Face | Line height | Family | Sets |
|---|---|---|---|---|
| `K_TYPE_CAPTION` | T | 18 px | Oxanium | Captions, readings, group labels, the toast. |
| `K_TYPE_BODY` | S | 24 px | Inter | A screen's sentences, a value in words. |
| `K_TYPE_LABEL` | R | 27 px | Oxanium | A row's name, segments, a caps value on a row. |
| `K_TYPE_BODY_L` | M | 32 px | Inter | A fact's value, a sentence that must carry. |
| `K_TYPE_TITLE` | L | 41 px | Oxanium | A screen's title, a menu row, a look's name. |
| `K_TYPE_HERO` | XL | 75 px | Oxanium | SHOOT on the card, and nothing else. |

- `ui.c` names a face by role only. `UI_FONT_*` appears in it nowhere else.
- `fit_face()` falls back from TITLE to LABEL, then cuts at LABEL with `text_fit()`. A value that arrives as data takes its face from what it is: `text_face()` sets a caps reading in the Oxanium role of the same weight.
- HERO carries S, H, O and T and no other letter (`tools/subset-font.mjs`). A new HERO word needs its letters added to the cut; `host_preview` fails until they are.
- `host_preview` fails any caps string set in Inter.
- Glyphs are 8-bit coverage, baked by `tools/mkfont.swift`. Licences are in `THIRD_PARTY_NOTICES.md`.

## Marks

Every mark is ink (`K_MARK`), drawn as coverage with `mask_blit()`, never stepped. Baked art is never redrawn.

- **The KINO D4 wordmark.** `logo_kino_d4.h`, 374 x 52, baked by `tools/mkmask.mjs` from `docs/assets/brand/kino-d4-white-on-dark.png`. Shown at sleep, restart and power-down.
- **The ODD JOBS symbol.** `ui_mark_odd_jobs.h`, baked by `tools/mkmask.mjs` from the supplied outline `hardware/pcb/kino-d4-carrier-a0/brand/odd-jobs-symbol.json` and never redrawn. The 50 x 40 bake is drawn on ABOUT under MADE BY. The 158 x 128 bake is in the header and not drawn: a boot mark is an option, not built.
- **The four-mark.** `four_mark()`: four cells, one per camera, left to right or two by two. Cell i is always lens i, in slot order, never the i-th frame counted. On the menu card a filled cell is a camera that answers and a 3 px outline is one that does not. Everywhere else an outline, a sixth of the cell thick, is a lens that was not asked (`FM_ABSENT`). On a capture strip a cell is that lens's frame: `K_OFF` while it is out, easing to `K_INK` as it crosses in, the launch shade as it lands, `K_FAULT` lost. On a gallery tile and PHOTO the cells come from `gallery_item_t.have`, which lenses have a file on the card, and on PHOTO a file that would not decode is red as well. The card does not record which lenses were asked, so there every lens counts as asked; the review after a shot takes them from the report (`s_photo_asked`), so a lens left out stays an outline and is not counted MISSING, as on the strip beside it; a quad's empty quarter carries the mark with its lens red, and MISSING or DAMAGED. When all four lenses land, the strip's gaps close to one bar over `MOTION_LAND_HOLD_MS`, stay shut while the shade turns, and open again over the last `LAND_REOPEN_MS` (`close_gap()`), inside the same `MOTION_LAND_MS`. Nothing short of four closes.
- **Icons.** One set, drawn, not baked: a 22 px box (`ICON_BOX`) and a 2.5 px anti-aliased stroke, sampled once into PSRAM. Back is an arrow; the pager's chevrons are the item before and after.

## Grid

One set of numbers for every screen. A stack of rows is checked against the page with a `_Static_assert` beside the screen's own constants.

| Constant | Value | Meaning |
|---|---|---|
| `GRID` | 8 | The step every gap and stack is a multiple of. |
| `PAGE_M` | 16 | The page margin: header, cards, wells, page buttons. Type stays inside it. |
| `INSET_TEXT` | 18 | Type inside a card or a well, from the card's edge. |
| `FACT_PITCH` | 46 | One fact row in a table. |
| `CN_PITCH` | 42 | CONNECTION's fact pitch, the one exception: six facts and the time-zone pair. |
| `R_CARD` | 10 | The corner of a card, a button, a row. |
| `R_PILL` | h / 2 | The corner of a pill: a badge, a bar. |
| `ROW_H` | 64 | A list row's pitch on a detail screen. |
| `ROW_GAP` | 8 | Between list rows. Rows are separate cards. |
| `LIST_TOP_DEFAULT` | 79 | Where a list starts when it fills the body. A shorter body is centred by `body_top()`. |
| `MZ_CARD_W` | 400 | The menu card. |
| `MZ_ROW_W` | 352 | A menu row. |
| `MZ_ROW_H` | 83 | A menu row's height. The card is five rows and four gaps tall. |
| `SH_BAR_H` | 34 | The status bar along the finder's foot. |
| `PH_W` | 600 | The photograph's well, 4:3 with `PH_H`. |
| `PH_H` | 450 | |
| `PH_COL_W` | 162 | The photograph's control column. |
| `LK_CTL_H` | 56 | A LOOK segment. |

## Motion

All of it is in `ui_motion.h`. `ui.c` asks for a move by name and never writes a duration inline.

The five rules, as `ui_motion.h` states them:

- **ANCHOR.** The thing you chose survives into the next state. A screen grows out of the row that was pressed.
- **LAND.** An outcome finishes in a stable place, with at most one colour event and one sound at the same instant. Colour arrives, does its job in `MOTION_LAND_MS` and leaves.
- **RECEDE.** Something unavailable loses presence: a quieter ink on its own ground.
- **SMOOTH.** No level changes in a step or a cut. A scrim, a fade or a move runs on a curve, one value per presented frame.
- **WIGGLE.** The exception. A wigglegram is hard cuts at its frame rate (`wiggle.fps`, `PURE_WIGGLE_FPS_DEFAULT`), one way round, the subject pinned. Its smoothness is alignment, never a crossfade.

Curves: `motion_smooth()` (smootherstep) for anything that travels on its own, `motion_ease_out()` for the screen answering a touch, `motion_accel()` for something leaving for good.

Who started a move picks its curve. A tap's release and a key run inside the `s_by_hand` bracket, and a move started there is by hand.

| Move | Started by | Curve |
|---|---|---|
| Open out of a row | A tap or a key, the shutter included | `motion_by_hand()` on the move's time. 11.0 % of the travel at 16 ms. |
| Back into the row | A tap or a key | `motion_by_hand()` on the time, flipped: it leaves fast and settles into the row. 13.5 % at 16 ms. |
| Slide beside the parent | A tap or a key | `motion_by_hand()` on the time. |
| The review opening after a shot, and closing on its clock | Nobody | `motion_smooth()`. |
| The cascade, the splash | Nobody | `motion_smooth()`; the splash leaves on `motion_accel()`. |

`motion_by_hand()` is cubic ease-out (`motion_ease_out()`). `MOTION_HAND_QUAD` set to 1 swaps in quadratic ease-out (`motion_ease_out_quad()`, 7.5 % at 16 ms) if the cubic reads abrupt on the panel. It is 0. The spans stay `MOTION_OPEN_MS` and `MOTION_BACK_MS` either way, and a move lands on the destination's own pixels: `lerpi()` rounds half away from zero, so no last-frame 1 px snap.

The row's wash follows the card, not the clock. By hand, on an open it is gone when the card is halfway out, over about five frames; on a back move it condenses over the card's last fifth and is whole on the frame the card lands. Untouched moves keep it on the clock: the first third of an open, the last third of a back move.

| Token | Value | What |
|---|---|---|
| `MOTION_OPEN_MS` | 420 ms | A screen opening out of the row pressed. |
| `MOTION_BACK_MS` | 340 ms | And closing back into it. |
| `MOTION_CASCADE_MS` | 700 ms | The menu's rows arriving after the boot. |
| `MOTION_HANDOFF_MS` | 420 ms | Any first screen but the menu, dissolving in out of the field. |
| `MOTION_SPLASH_GROW_MS` | 1820 ms | The boot field, out of nothing to the panel. |
| `MOTION_SPLASH_HOLD_MS` | 860 ms | Full, the cells re-rolling. |
| `MOTION_SPLASH_BACK_MS` | 1080 ms | And away, on `motion_accel()`. |
| `MOTION_LAND_HOLD_MS` | 120 ms | The landed cells in the launch shade. |
| `MOTION_LAND_BACK_MS` | 180 ms | And back to ink on `motion_smooth()`. |
| `MOTION_LAND_MS` | 300 ms | LAND in all. |
| `MOTION_PILL_PULSE_UP_MS` | 140 ms | The card pill out `MOTION_PILL_PULSE_PX` a side, on a shutter capture.c refused for the card. |
| `MOTION_PILL_PULSE_BACK_MS` | 280 ms | And back, on `motion_smooth()`. |
| `MOTION_PILL_PULSE_MS` | 420 ms | PULSE in all. |
| `MOTION_TOAST_MS` | 2200 ms | A toast. |
| `MOTION_UNDO_MS` | 30000 ms | The undo toast after a delete. |
| `MOTION_DIM_MS` | 1600 ms | The dim scrim arriving. |
| `MOTION_UNDIM_MS` | 160 ms | And leaving on a touch, on `motion_ease_out()`. |
| `MOTION_WAKE_MS` | 240 ms | The screen coming back from sleep. |
| `MOTION_POWER_FADE_FRAMES` | 20 | The power-down fade, frames on `motion_smooth()`. |

The moves:

- **Open.** The pressed row is the destination's header from the first frame. The card grows to the page with the destination revealed inside it; the rows above lift and the rows below drop as two rigid blocks. Back closes the card into the row you left from.
- **Slide.** A detail screen arriving beside its parent, SETTINGS to STORAGE or GALLERY to PHOTO. Both frames are prepared once and shown in panel orientation by `gfx_slide_show()`.
- **Cascade.** The menu's rows landing one after another, only after the boot.
- **Snapshot.** SHOOT and GALLERY are too costly to draw per frame of a move, so each is drawn once into the stash and travels as a picture.

## Feedback

### Sound

One sound per outcome, played at the moment the screen shows it, not when the fact was learned.

| Call | When | Gate |
|---|---|---|
| `audio_shutter()` | A capture the pipeline accepted. A refused press is a warning only; a press queued behind a save is silent until it fires. Also the SOUND screen's preview. | `body.sounds.save` |
| `audio_tick()` | A finger landing on a target; each second of the self-timer, and every 250 ms of its last 3 s. Gated where it is called, the count's ticks included. | `body.sounds.ui` |
| `audio_warning()` | Something did not work: a refused shutter, a failed capture, a failed action. Two low 220 Hz pulses, unlike any other sound. | `body.sounds.warning` |
| `audio_sync()` | The four marks closing on a point after a capture. | `body.sounds.ui` |
| `audio_done()` | Something finished: sent to the roll, restored, the card ready, the card formatted, the four measured, the cameras restarted. | `body.sounds.ui` |

### On the glass

- A press shows the launch shade on the control on the touch-down edge, before the action runs.
- A control drawn dead takes no press (`press_dead()`): no shade, no tick. The lift still answers with a toast that says why. SEND TO ROLL off a Roll is the one: "No active roll".
- A remark is a toast: under 40 characters, `MOTION_TOAST_MS` on the glass, placed clear of the control that raised it. The undo after a delete stays `MOTION_UNDO_MS`.
- The camera at work is a strip along the foot: a capture's four cells and a word, UPDATING 42%, FORMATTING THE CARD, RESTARTING THE CAMERAS. A strip never blocks a touch.
- A question is a dialog. Only a question is a dialog.

## Overlay order

`draw_screen()` paints in this order, each layer over the last:

1. The screen, header included.
2. The capture strip (`draw_capture_banner()`).
3. On SHOOT only, one slot: the self-timer count, or else the card pill, or else the first-use hint, or else the lens hint.
4. The working strip: UPDATING 42% (UPDATING in maintenance between images), or else FORMATTING THE CARD, or else RESTARTING THE CAMERAS.
5. The toast.
6. The dialog.
7. The dim scrim, `DIM_SCRIM_K` at full dim, over everything.
8. A called-off sleep's mark, leaving over the scrim.

Outside `draw_screen()`, whole-panel renders replace it: the boot field, the wordmark at sleep and power-down, RESTARTING, black, and the test plate (`draw_plate()`).

## System states

| State | What the glass does |
|---|---|
| Boot | The boot field grows over `MOTION_SPLASH_GROW_MS`, holds, and leaves on `motion_accel()`. A quadrant per camera: one that has not answered stays in `K_BF_COLD` greys while the rest warm to the launch shade. A key or a touch during the splash ends it on the spot: the key fires on the first screen's first pass, the touch presses nothing. The menu cascades in; any other first screen dissolves. |
| First start | `DLG_WELCOME`, once (`body.firstRunSeen`). |
| First start after an update | `DLG_UPDATED`, once (`body.lastVersion`). |
| A condition | The worst one is the first line of the SHOOT card, after its severity word: PROBLEM (`COND_FAULT`), CHECK (`COND_WARN`) or NOTE (`COND_NOTE`). On every detail screen the header chip names the worst one by its short name (`chip_words()`: 1 LENS DOWN, NO CARD, DATE NOT SET), in `K_FAULT_INK` on a FAULT and `K_INK` on a WARN. A NOTE never reaches the header. While the chip names the card, the header's card reading is left out. STATUS lists all of them. The list is `cond_id_t` in `conditions.h`; the words are in `docs/DEVICE_COPY.md`. |
| Capture | SHOOTING, then TAKEN. SAVING (TAKEN. NEXT ONE QUEUED after a second press), then SAVED, or how many cameras missed. One cell per lens throughout. Cells land in the shade, or stay red where a lens lost its frame. |
| Self-timer | On SHOOT, one scrim plate centred on the panes' cross: the digit in `K_TYPE_TITLE`, a ring of ten dots round it, and SELF-TIMER.  PRESS TO CANCEL under it. Each dot eases from `K_INK` to `K_OFF` across its second on `motion_smooth()`, clockwise from the gap at the foot; the positions are the const `TIMER_RING` table, no trigonometry at draw time. The pass runs SHOOT at 20 ms while it counts, except while a capture's frames cross the links (#158); there the ring eases on the 60 ms pass. Monochrome: a count is a state, not an event. |
| A card that will cost the next photograph | On SHOOT, a `K_FAULT` pill at the top from the pass's `sd_status()`: no card, card out, unreadable, failed its write test, or under the reserve capture.c refuses at (`pure_capture_reserve_bytes()`, four frames at `wiggle.resolution`). It states and never gates: capture.c is the one gate. A refusal for the card (an `SD_` code) pulses the pill. The pulse runs SHOOT at 20 ms, except while a capture's frames cross the links (#158); there it steps on the 60 ms pass. |
| First use | Until the first photograph exists (`sh_first_use()`: `gallery_media_count()` is 0, `capture_count()` is 0, no capture running), SHOOT's slot shows PRESS THE SHUTTER ON TOP in a `K_INK` pill, under the self-timer and the card pill, over the lens hint. A tap that lands on a pane with a picture while it is up toasts Press the shutter on top. and presses nothing. Ink, not red: nothing is wrong. |
| Delete all photos | The Photos row on STORAGE reads DELETING 120 OF 500 from `gallery_delete_progress()`, repainted while `gallery_deleting()` holds. Both destructive rows are disabled until it ends. The menu and other screens show nothing of it. |
| Updating | While a firmware update session is open (`fw_update_progress()`): UPDATING 42% on the working strip for the body's own image, UPDATING CAMERA 2 42% for a lens. In maintenance with no session open, before the first image or between two (`maint_active()`): UPDATING with no number. Ink, no shade: an update is a state. Repainted per whole percent by `update_poll()`, never per chunk, and on SHOOT by SHOOT's own clock. The shutter and RESTART THE CAMERAS are refused for the whole time and toast "Updating. Keep the camera on.", the shutter with the warning sound. A session no chunk reaches for `PURE_FW_IDLE_MS` (60 s) is abandoned, and maintenance ends `PURE_MAINT_HOLD_MS` (600 s) after the last ENTER_MAINTENANCE or FW_* command; both are checked on kdp_server's loop, maintenance on the UI task too (`maint_poll()`). Then the shutter works again. |
| Formatting | FORMATTING THE CARD on the working strip. |
| Cameras restarting | From the STATUS row or a dead pane's button, the same action and no confirm. RESTARTING THE CAMERAS for `MOTION_CAMS_RESTART_BANNER_MS`. For `CAM_RESTART_GRACE_MS` (7 s, a guess until the node boot is timed on the bench) a pane with no picture says STARTING and has no button, and the STATUS row only toasts. Both entry points re-arm the finder's settle clock. While a capture runs or a shot is queued (`capture_in_flight()`) there is no button and no cycle: the pane says NO PICTURE alone and a press toasts. While the self-timer counts there is no button either: the pane is picture, a tap on it cancels the count, and a press that beat the repaint cancels the count and cycles nothing. |
| Dim | After `body.autoDimS` (30 s by default) the scrim arrives over `MOTION_DIM_MS` to `DIM_SCRIM_K`. A touch lifts it over `MOTION_UNDIM_MS` and is acted on: a dim screen is still readable. On SHOOT the scrim waits until `PURE_SHOOT_DIM_LEAD_S` (10 s) before `body.sleepS`, or `body.autoDimS` if that is later, and never comes with sleep off (`dim_drawn()`). The scrim saves no current: the backlight is a GPIO. `power.c` still reports DIM at `body.autoDimS`, so KDP says "dim" while SHOOT draws none. |
| A resting contact | A press held past `PURE_TAP_MAX_MS` is released under the finger and fires nothing. Off SHOOT, a contact within `PURE_STILL_CONTACT_PX` of where it last moved for `PURE_STILL_CONTACT_S` stops counting as activity until it moves or lifts (`touch.c`, `pure_still_step()`), so a water bead, a sleeve or a pocket lets the screen dim and sleep. On SHOOT a resting thumb is someone framing and counts for `PURE_REST_CONTACT_S` (120 s) before it stops, so a camera left on SHOOT in a pocket still dims and sleeps, about two minutes plus `body.sleepS` after it last moved. |
| Sleep | After `body.sleepS` (120 s by default) the picture darkens, the wordmark fades in, holds and fades out inside `SLEEP_WIND_MS`, and `power.c` cuts the backlight. A touch brings the screen back over `MOTION_WAKE_MS`; that touch presses nothing. When the panel goes dark the camera moves somewhere safe to wake to (`sleep_safe_state()`, #247): an open question closes with its safe answer, never its action, and the two notes (`DLG_WELCOME`, `DLG_UPDATED`) stay, since they are marked seen when they open; the SETTINGS subtree, POWER and LOOK go to the menu with the row that led there focused; SHOOT, MENU, GALLERY, PHOTO and ROLL stay. Done in the dark, so the wake's lift is the first frame of the new place. A sleep called off before the dark changes nothing. |
| Restart, power-down | RESTARTING for `MOTION_RESTARTING_MS`, the wordmark, a fade over `MOTION_POWER_FADE_FRAMES` frames, then black. A blocking loop: it only runs on the way to a reset. |
| Safe mode | `COND_SAFE_MODE`: three crashes in a row left the radio and uploads out. Reported as a condition. |
| A dead panel | Cannot show anything. Reported over KDP. |
| Seen and driven over KDP | GET_SCREEN renders the screen once into the canvas between two passes (`shot_pass()`), through `render_screen()`, so the picture is what the glass shows: finder panes, toast, dim scrim, a held press. The host reads it out a page at a time, `PURE_SCREEN_CHUNK_MAX` bytes a page, while the UI carries on; a page is refused once the canvas generation (`gfx_canvas_gen()`) moved. Refused while a move, the sleep's wind-down or a wake's lift runs (`ui_screen_moving()`). A body asleep is not moving: its render is the screen under the sleep's scrim, and SCREEN_PLATE wakes it and goes up; the wake's lift runs when the plate drops. A UI_TAP goes through `ui_touch()`, which every touch read in `ui_pass()` uses, `UI_TAP_Q` deep: the palm edge, the drift and hold rules and the wake that swallows a press all apply, and each tap is lifted for `UI_TAP_GAP_US` before the next lands. A UI_KEY goes on the physical keys' queue. The state lives in PSRAM. |
| Test plate | SCREEN_PLATE: a 32-step grey ramp, every palette colour, the eight launch shades over their pressed steps, and a 1 px grid at a 20 px pitch, for photographs of the panel. No words. It holds the panel awake and ends on a touch, a key, SCREEN_PLATE off, a sleep asked for (the lens cover closing: `power_sleep_now()` ages the idle clock past `body.sleepS`, and the plate lets go instead of refreshing it), or after `UI_PLATE_MAX_US` (5 minutes). The press that ends it does nothing else. |


## Renderer budget

| Item | Figure |
|---|---|
| Tile | `TILE_W` x `TILE_H`, 48 x 96 px: 85 tiles a frame, 17 x 5. |
| Tile buffers | Two, 18 KB of internal SRAM in all, so one is written out while the next is drawn. |
| Display list | `DL_MAX` commands in PSRAM, their 10-byte boxes in internal SRAM (3.75 KB), and a `DL_STR` string arena in PSRAM. |
| A full list | The frame is drawn directly instead. Nothing is lost; the frame is slower. |
| Moves | 51 to 58 fps measured on the panel. SHOOT and GALLERY move as snapshots: drawn per frame they ran at 30 and 25 fps. |

| Constant | Value | Meaning |
|---|---|---|
| `TILE_W` | 48 | Tile width, logical px. |
| `TILE_H` | 96 | Tile height: the run written per panel row. |
| `DL_MAX` | 384 | Display list commands. The busiest frame seen is about 230. |
| `DL_STR` | 8192 | Bytes of strings a frame may record. |

The rules a change must keep:

- A frame is recorded once (`dl_begin()`, `dl_push()`) and replayed per tile (`dl_replay()`). A draw callback must be a function of state only: it may run once per tile.
- No per-pixel float maths in a hot loop. A fixed picture that moves (a slide, a snapshot) moves in panel orientation.
- Internal SRAM is the scarce pool: about 66 KB free after boot, and the C6 recovery reserve must read 2/2. No new internal `.bss` or `.data` beyond a few hundred bytes. A table goes in flash as `const`, or in PSRAM with EXT_RAM_BSS_ATTR. Nothing goes in IRAM.
- No camlink lock inside a draw. Screens read the `s_cams` snapshot `ui_pass()` refreshes.
- `ui.c` touches no NVS and no filesystem. A new FreeRTOS, heap or ESP-IDF call in `ui.c` needs a stub in `firmware/p4/host_preview/shim` and `firmware/p4/host_preview/preview.c`, and in `firmware/p4/twin_ui/shim` and `firmware/p4/twin_ui/twin_ui.c`.

## Verify a change

On the workstation:

1. Before the change, record the pictures: `make -C firmware/p4/host_preview approve`.
2. After it: `make -C firmware/p4/host_preview check`. The run fails on any audit fault: type outside `PAGE_M`, a pair under its contrast floor, a target under 52 px, chrome on the wrong side, caps in Inter, a changed scene count. Then it lists every picture that changed. Look at each one, for both hands (`out/` and `out/left/`).
3. `make -C firmware/p4/host_tests test-theme`, or `test-all` in the `espressif/idf:v5.5.1` container.
4. `npm run palette:check`, `npm run copy:check`, `npm run ui:doc:check`, `npm run license:check`.
5. Re-bake the Twin under WSL (`npm run twin:ui:bake`), then `npm run twin:ui:check` and the hand walk, `e2e/twin-hand-walk.spec.ts`.

On the bench, for a change to drawing or memory:

1. Build both images, the plain one and the radio one, and read the radio image size against the CI guard.
2. Flash, then read a move's frame rate from the log (GET_LOGS): each move logs its frames, fps and the split between drawing, writing out and waiting for the panel.
3. Read internal free and "recovery reserve 2/2" from the runtime stats on the radio image.

## Earlier documents

`firmware/D4_UI.md`, `firmware/WORLD.md` and the UI half of `firmware/D4_INTERACTION.md` described interfaces that were built, looked at and replaced. They now point here. Their text is in git history at `acbd722`.
