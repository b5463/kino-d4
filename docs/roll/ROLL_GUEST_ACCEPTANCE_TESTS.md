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

When the Roll-upload firmware milestone lands, walks A–D must pass with the physical D4 in place of the Twin, unchanged on the Roll side ([ROLL_DEVICE_CONTRACT.md](ROLL_DEVICE_CONTRACT.md)).
