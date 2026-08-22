# Roll guest acceptance tests

Manual walks that prove the guest loop end to end, with the Twin standing in for the physical camera. Environment: [ROLL_TWIN_INTEGRATION.md](ROLL_TWIN_INTEGRATION.md). No seeded photos, no mocked realtime, no manual database writes.

## A. Party walk (Twin as the camera)

1. Start postgres/redis/minio, API, worker, roll-web, twin.
2. Twin: POWER ON → FIRMWARE tab → `SIMULATED FUTURE` profile.
3. ROLL tab → CREATE ROLL "Test Party". PASS: the virtual D4 display shows a `JOIN THIS ROLL` QR.
4. Open the QR (phone on the LAN, or OPEN GUEST ROLL). PASS: an empty live Roll.
5. STAGE tab: place a person ~1.5 m from the camera, set dim party lighting.
6. Press SHUTTER. PASS: the virtual display shows the capture sequence; the ROLL tab queue counts move; the phone shows the new capture live (thumbnail first, Wiggle after the worker finishes) without a reload.
7. On the phone: open the capture, Download, Share (native share sheet where available), tap the heart. PASS: all work; the heart count persists across a reload.

## B. Four-camera capture (simulated-future profile)

1. Profile `SIMULATED FUTURE`, subject at 1 m.
2. SHUTTER. PASS: four distinct perspectives upload (`original-frame` 1–4), the Roll shows an animated Wiggle, and the wiggle MP4 derivative downloads.
3. Move the subject to 3 m and capture again. PASS: visibly less parallax between frames.

## C. Current-firmware capture (Milestone 1 honesty)

1. Profile `CURRENT FIRMWARE 0.1.0`. CAM2–4 report offline; group SHUTTER commits nothing (incomplete groups are not published) — exactly like the physical build.
2. ROLL tab → SEND TEST FRAME. PASS: one CAM1 JPEG uploads as `mode: single`; the Roll shows a plain still with no Wiggle controls; the capture's provenance names the `d4-m1b` profile.

## D. Server outage (queue and resume)

1. On a live Roll, capture #1 and see it arrive.
2. Stop the API. Capture #2 and #3. PASS: the shutter is unaffected; the ROLL tab shows the queue retrying; the phone shows the connection dot reconnecting.
3. Start the API. PASS: #2 and #3 arrive exactly once each, in order, with no duplicates; the guest needed no reload.

## E. Load

`npm run party:sim` with the outage drill — see [ROLL_PARTY_LOAD_TEST.md](ROLL_PARTY_LOAD_TEST.md). PASS: report ends `ok: true, duplicates: 0`.

## F. My Picks (issue #79)

1. On a live Roll with a few captures, open one and tap the heart.
2. Back on the feed, open the MY PICKS tab. PASS: the hearted capture is there; the tab count matches.
3. Reload the page. PASS: the pick survives (it lives in this browser, not an account).
4. Un-heart the capture. PASS: it leaves MY PICKS.
5. As the host, hide a picked capture. PASS: it disappears from MY PICKS without an error.

## G. New-photos pill (issue #79)

1. On a Roll with enough captures to scroll, scroll well below the top.
2. Capture from the Twin. PASS: the grid does NOT shift under your thumb; a sticky "1 new" pill appears above the grid.
3. Capture again. PASS: the pill reads "2 new".
4. Tap the pill. PASS: the page scrolls to the top and both captures sit at the head with the NEW badge.
5. Scroll back to the very top and capture once more. PASS: it prepends immediately, no pill.

## H. Display mode (issue #79)

1. On a second screen (TV/projector/monitor), open `/r/<slug>/display?qr=1`. PASS: black full-bleed view, no site chrome; a corner QR with the slug beneath it.
2. Scan the QR with a phone. PASS: the phone lands on the Roll feed.
3. Let it sit. PASS: the display cycles through the newest captures and the screen does not sleep.
4. Capture from the Twin. PASS: the display cuts to the new capture without a reload.

## I. Save wiggle and social formats (issue #79)

1. Open a wiggle capture's detail page on a Roll with downloads enabled.
2. Tap SAVE WIGGLE. PASS: "Rendering…" shows; when the worker finishes, the control becomes a download and tapping it lands an MP4 that plays in the phone's gallery.
3. Tap 9:16, then 4:5, then 1:1. PASS: same request-then-download flow; the saved files measure 1080×1920, 1080×1350 and 1080×1080.
4. As the host, turn downloads off and reload the capture. PASS: every save control is gone.

When the Roll-upload firmware milestone lands, walks A–D must pass with the physical D4 in place of the Twin, unchanged on the Roll side ([ROLL_DEVICE_CONTRACT.md](ROLL_DEVICE_CONTRACT.md)).
