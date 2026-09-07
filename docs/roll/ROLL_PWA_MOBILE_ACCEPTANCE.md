# Roll mobile PWA acceptance

The procedure for accepting the guest app on a real phone against `https://kino.acronym.sk`. One operator, one phone, about 25 minutes. Every check below has one expected result and one failure action; nothing here asks for a judgement call.

This is the installed-app and on-device half of acceptance. The end-to-end guest loop with the Twin standing in for the camera is [ROLL_GUEST_ACCEPTANCE_TESTS.md](ROLL_GUEST_ACCEPTANCE_TESTS.md); running a party is [HOST_GUIDE.md](HOST_GUIDE.md). Do not run this instead of those.

## Before you start

- A phone that has never opened `kino.acronym.sk`. If it has, delete the installed app, then in the browser clear site data for that host. A warm service worker invalidates checks 1, 3, 20 and 21.
- One iOS phone and one Android phone if both are in scope. Run the whole list on each; the save, install and status-bar behaviour differ.
- A live roll with at least four captures on it, one of which has four frames. Have the roll code and, if the roll is PIN protected, the PIN.
- The host dashboard open on a laptop, for the closed-roll and live-arrival checks.
- Charge the phone above 30%. iOS throttles background work below that and check 22 will read as a failure that is not one.

Marks used below:

- **[DEPLOY]** — cannot pass until `https://kino.acronym.sk` is serving.
- **[CAMERA]** — cannot pass until a real D4 is uploading to production; the Twin does not substitute, because what is being checked is a photograph arriving from the device while the phone is open.
- **[DEVICE]** — cannot be checked in a desktop browser at any URL; it needs the physical phone.

## Measured facts of the built app

These come from the built output, not the source. If a check disagrees with one of them, the deployed build is not this build.

| Fact | Value |
|---|---|
| Manifest `name` / `short_name` | `KINO Roll` / `KINO Roll` |
| Manifest `start_url` / `scope` | `/` / `/` |
| Manifest `display` | `standalone` |
| Manifest `theme_color` / `background_color` | `#0b0b0c` / `#0b0b0c` |
| Manifest icons | `/icon-192.png` 192×192, `/icon-512.png` 512×512, both `any maskable`, both opaque to the corner (`#174e98`) |
| `apple-touch-icon` | `/icon-apple-touch.png`, 180×180, 24-bit, no alpha |
| Guest shell ground | `#0b0b0c`, painted before the bundle runs as well as after |
| `/host` shell ground | `#e9edf2`, `theme-color` swapped to `#e9edf2` at runtime |
| Viewport | `width=device-width, initial-scale=1.0, viewport-fit=cover` |
| Service worker | `/sw.js`, scope `/`, navigation fallback `/index.html`, denylist `^/api/` |
| Precache | 14 manifest entries, 12 distinct URLs, 560.8 KiB: the shell HTML, one JS chunk, one CSS file, two woff2 subsets, two wordmark PNGs, three icons, the webmanifest, the workbox-window chunk |
| Runtime caches | `kino-roll-api` (NetworkFirst, 5 s network timeout, everything under `/api/` except `/api/assets/` and `…/events`), `kino-roll-assets` (CacheFirst, 500 entries, 24 h) |
| SSE endpoint | `GET /api/rolls/<slug>/events`, never intercepted by the service worker |
| Update behaviour | `registerType: 'prompt'`. A new build shows a bar reading "A newer version of this page is ready." with **Reload** and **Later**. Nothing reloads on its own. |
| Install prompt | none. The app registers no `beforeinstallprompt` listener, so the browser's own menu is the only route to install. |

## Origin configuration

The app needs **no** build-time or run-time configuration to serve from `https://kino.acronym.sk`. Every URL it forms is origin-relative: `base: '/'`, `start_url` and `scope` are `/`, the API client is constructed with an empty base so every call is same-origin, the SSE URL resolves against `window.location.href`, and share and link-preview URLs come from `window.location`. The built bundle contains no host name, no port and no environment variable. There is nothing to set, and nothing to get wrong.

The one origin the app does **not** control is where `/api/assets/<id>/content` redirects to. The API answers 302 with a presigned object-store URL, and the phone follows it. That target comes from the API's storage configuration, not from this app. Check 6 is the check that catches it.

---

## Part 1 — the checks

### First load

**1. Cold load of the roll link. [DEPLOY]**
Open `https://kino.acronym.sk/r/<CODE>` from a fresh phone.
PASS: the page paints a near-black ground with no pale flash at any point, the header plate shows the roll title and a frame counter, and photograph tiles appear. No browser error page, no white screen.
FAIL: capture the URL bar text and the browser's console if reachable; the shell is not being served or the API is not behind the same origin.

**2. Deep link, cold. [DEPLOY]**
Open `https://kino.acronym.sk/r/<CODE>/c/<captureId>` in a new tab on the same fresh phone.
PASS: the capture page itself loads — hero photograph, a `CAM 1`–`CAM 4` frame strip for a four-frame capture, a `shot … device … frames …` line, and a **Save** button with a heart beside it. Not the landing page, not "Not found".
FAIL: the edge is not falling back to `/index.html` for unknown paths. Fix the edge, not the app.

**3. Reload of the deep link. [DEPLOY]**
On the page from check 2, pull to refresh.
PASS: the same capture page comes back at the same URL.
FAIL: same cause as check 2.

**4. No horizontal scroll.**
On the feed, swipe left and right.
PASS: the page does not move sideways at any scroll depth.
FAIL: note the capture and the phone width; a tile or a plate is overflowing.

**5. Nothing is indexable.**
Not a phone check — one request from anywhere: `curl -sI https://kino.acronym.sk/r/<CODE>`. **[DEPLOY]**
PASS: the HTML carries `<meta name="robots" content="noindex, nofollow">` and API responses under `/api/rolls/` carry `X-Robots-Tag: noindex, nofollow`.
FAIL: stop. A roll is unlisted and must not reach a search index.

**6. Photographs come from a host the phone can reach. [DEPLOY]**
On the capture page, long-press the hero photograph and choose the browser's "open image in new tab" (Android) or check the network panel from a tethered desktop.
PASS: the image loads. Its final URL is either same-origin under `https://kino.acronym.sk` or another `https://` host that resolves publicly.
FAIL: if the final URL names `localhost`, a `192.168.*`/`10.*` address, or a bare `http://` host, every photograph will fail for every guest not on the venue LAN. This is the API's storage configuration, not the app's — hand it to whoever owns the deploy and stop this procedure here.

### Install

**7. Install to the home screen. [DEPLOY] [DEVICE]**
iOS: Share → *Add to Home Screen*. Android: browser menu → *Install app* or *Add to Home screen*.
PASS: the offered name is `KINO Roll`. The offered icon is the white D4 badge on blue, filling its tile with no white border and no screenshot of the page.
FAIL: if the icon is a screenshot, `apple-touch-icon` did not load — check that `/icon-apple-touch.png` returns 200. If the name is a URL, the manifest did not load — check `/manifest.webmanifest` returns 200 with `application/manifest+json`.

**8. Icon on the home screen. [DEVICE]**
Look at the finished home-screen icon.
PASS: the badge is legible, centred, and the tile has no transparent corners showing through as white or black.
FAIL: photograph the home screen and attach it; the maskable safe area is wrong.

**9. Launch from the icon. [DEPLOY] [DEVICE]**
Close the browser entirely. Tap the home-screen icon.
PASS: it opens with no browser address bar and no browser tab strip. The splash while it starts is near-black, not white and not pale grey. It lands on the "Open a roll" page with a **Back to `<roll title>`** link under it.
FAIL: an address bar means `display: standalone` or the scope is not being served; a white splash means `background_color` is not reaching the OS.

**10. The way back in. [DEPLOY] [DEVICE]**
Tap **Back to `<roll title>`**.
PASS: the roll feed, inside the installed app, still with no address bar.
FAIL: if the link is absent, the phone dropped `localStorage`; re-open the roll by code once and repeat check 9.

**11. Status bar and notch. [DEVICE]**
In the installed app on a notched phone, look at the top and bottom of the feed.
PASS: the header plate's content sits below the clock and battery, not under them. The bottom action plate on a capture page sits above the home indicator, not under it. Nothing is clipped by a rounded corner.
FAIL: photograph it. `viewport-fit=cover` and the safe-area padding are both in the build; a failure here is device-specific and needs the photograph.

**12. Type size.**
Look at the smallest text on the feed — the date and clock marks.
PASS: readable at arm's length without zooming.
FAIL: note the phone model and its system font-size setting.

### The roll

**13. The feed.**
Scroll the feed to the bottom of what has loaded, then keep scrolling.
PASS: tiles keep arriving as you go; the scroll position never jumps under your thumb.
FAIL: note where it stopped and whether the frame counter in the header matches the number of tiles.

**14. Tabs.**
Tap **Picks**, then **Info**, then **Roll**.
PASS: **Picks** shows either your hearted photographs or the line "Nothing picked / Tap the heart on a photograph to keep it here. Picks stay on this phone." **Info** shows the roll's own details. **Roll** returns to the grid at the top.
FAIL: name the tab and what it showed.

**15. Open a capture.**
Tap any tile.
PASS: the capture page, with the hero photograph filling the width.
FAIL: note whether the URL changed.

**16. Frames.**
On a four-frame capture, look at the strip under the hero.
PASS: exactly four thumbnails labelled `CAM 1`, `CAM 2`, `CAM 3`, `CAM 4`, and the meta line reads `frames 1-4`.
FAIL: count what is there and read the meta line verbatim. Fewer than four means the capture group is incomplete on the server, not that the page is wrong.

**17. Back.**
Tap the `‹` in the header.
PASS: the feed, at the scroll position you left it, not at the top.
FAIL: note the scroll position you had.

### Saving and sharing

**18. Save sheet.**
On a capture page, tap **Save**.
PASS: a sheet rises with the heading "Save · goes to your photos" and these rows, in this order: **Original** (with the pixel size), **Wiggle** (`mp4 · to Photos`), **Story** (`9:16`), **Post** (`4:5`), **Square** (`1:1`), **Share a link** (`anyone with the roll`), **Cancel**.
FAIL: list the rows you got. If the whole plate reads "Saving is off for this roll", the host has downloads disabled — turn them on and repeat.

**19. Save to Photos. [DEVICE]**
Tap **Original**.
PASS: the system share sheet appears offering *Save Image*. Choose it, open Photos, and the photograph is the newest item in the camera roll.
FAIL: if a file downloads instead of the sheet appearing, the app could not read the photograph's bytes — the object store is not allowing a cross-origin read from `https://kino.acronym.sk`. Record it as a CORS failure on the storage host, not an app bug.

**20. Save a wiggle. [DEVICE]**
Tap **Save** again, then **Wiggle**.
PASS: either the share sheet offers *Save Video* immediately, or the row reads "Preparing…" and the sheet appears within a minute without you touching anything else.
FAIL: if the status line under the plate says "Could not prepare that file: …", quote it in full — the render worker answered, and its message is the diagnosis.

**21. Share a link.**
Tap **Save** → **Share a link**.
PASS: the system share sheet offers the capture's own URL, `https://kino.acronym.sk/r/<CODE>/c/<captureId>`. Send it to yourself and open it: it lands on the same photograph.
FAIL: if a status line reads "Link copied" instead of a sheet appearing, the phone has no share API — paste the clipboard and confirm the URL is right; that is a pass for the URL and a note against the phone.

**22. Hearts.**
Tap the heart on a capture. Reload the page.
PASS: the outline heart fills and its count rises by one; after the reload it is still filled with the same count.
FAIL: note the count before, after, and after the reload.

**23. Picks.**
Go back to the feed and open **Picks**.
PASS: the capture you hearted is there. Un-heart it and it leaves.
FAIL: note whether the heart on the capture page is still filled.

### Gates and states

**24. PIN gate.**
Only if the roll has a PIN. Open the roll link on a second fresh phone, or after clearing site data.
PASS: a page reading "PRIVATE ROLL · `<CODE>`" over "This roll needs a PIN" and "It is printed on the card with the roll code." Enter the wrong PIN: an error line appears and no photographs load. Enter the right PIN: the feed loads.
FAIL: quote the error line. A gate that lets you through on a wrong PIN is a stop-everything failure.

**25. A closed roll.**
On the host dashboard, close the roll. Reload the phone.
PASS: a banner reading "Closed · `<DD.MM.YY>`" over "No more photographs are coming. Everything here stays." Every photograph already on the roll still opens and still saves.
FAIL: note the banner text and whether a photograph still opens. Re-open the roll on the dashboard before continuing.

**26. A link to a removed photograph.**
Hide one capture from the host dashboard, then open that capture's URL on the phone.
PASS: a page reading "This photograph is gone" over "The host removed it. The rest of the roll is still here.", with a **Back to the roll** link that works.
FAIL: if it says "No roll here", the wrong error is being shown for a hidden capture. Un-hide the capture afterwards.

**27. A dead link.**
Open `https://kino.acronym.sk/r/<CODE>/nonsense`.
PASS: a page reading "Not found" over "No page at /r/`<CODE>`/nonsense.", with an **Open a roll** link.
FAIL: a browser 404 page means the edge is not falling back to the shell.

### Offline

**28. Second visit, offline. [DEVICE]**
With the roll feed open and a few captures scrolled past, turn on airplane mode. Reload.
PASS: the app still opens. The header, the tabs and the tiles you had already seen are all there. A slim line reads "Offline — showing what was loaded".
FAIL: if the browser's offline page appears, the service worker is not in control — confirm `/sw.js` returns 200 with `text/javascript` and is served with `cache-control: no-cache`.

**29. Offline capture page. [DEVICE]**
Still in airplane mode, open a capture you had already opened.
PASS: the hero photograph and the frame strip are there, from cache.
FAIL: note whether the page chrome loaded and the photographs did not; that separates the shell precache from the asset cache.

**30. Offline limits. [DEVICE]**
Still in airplane mode, tap the heart on a capture, then open a capture you had **not** opened before.
PASS: the heart does not stick and the unseen capture shows a load failure. Neither is a crash, and the offline line stays visible.
FAIL: a blank page or a frozen app.

**31. Recovery. [DEVICE]**
Turn airplane mode off. Wait ten seconds without touching the phone.
PASS: the "Offline" line disappears on its own. Tapping the heart now works and sticks across a reload.
FAIL: reload once. If the line only clears on reload, note it — the app should clear it from the network event alone.

### Live

**32. A capture arriving while the phone is open. [DEPLOY] [CAMERA]**
Hold the phone at the top of the feed. Press the shutter on the camera.
PASS: within a few seconds the new photograph appears at the head of the grid, with a `New` badge, without you reloading and without the grid shifting anything under your thumb.
FAIL: reload the page. If the capture is there after a reload, the SSE stream is not reaching the phone — the edge is buffering `text/event-stream`. Hand that to whoever owns the deploy.

**33. A capture arriving while scrolled down. [DEPLOY] [CAMERA]**
Scroll well down the feed. Press the shutter again.
PASS: nothing moves under your thumb; a pill reading "1 new" appears above the grid. Press the shutter once more and it reads "2 new". Tap it: the page goes to the top with both new photographs at the head.
FAIL: note the pill's text and whether the grid jumped.

**34. Long open. [DEPLOY] [CAMERA] [DEVICE]**
Leave the app open on the feed for ten minutes, screen on, then press the shutter.
PASS: the new photograph still arrives live, with no reload.
FAIL: note how long it had been open; the stream is dropping and not resuming.

### Rotation

**35. Feed in landscape. [DEVICE]**
Turn the phone sideways on the feed.
PASS: the layout reflows to wider tiles, the header stays one row, and there is no sideways scroll. Turn it back: the layout returns and the scroll position is roughly where it was.
FAIL: photograph both orientations.

**36. Capture page in landscape. [DEVICE]**
Turn the phone sideways on a capture page.
PASS: the photograph fits within the screen with letterboxing rather than being cropped; the frame strip stays one row; scrolling down reaches the **Save** button and the heart.
FAIL: photograph it, and say whether the Save button was reachable by scrolling.

### Update

**37. A new build reaching an open phone. [DEPLOY]**
Deploy any change while the app is open on the phone, then bring the app back to the foreground.
PASS: a bar appears reading "A newer version of this page is ready." with **Reload** and **Later**. Nothing reloads until you tap **Reload**; tapping **Later** dismisses the bar and the app keeps working.
FAIL: if the page reloads on its own, the wrong register type is deployed. If no bar ever appears, confirm `/sw.js` and `/index.html` are served `no-cache` at the edge.

---

## Part 2 — what can be rehearsed today

`https://kino.acronym.sk` is not serving yet. The rehearsal below runs the same app against the LAN dev server so the operator learns the taps and the copy. It is a rehearsal, not the acceptance: nothing rehearsed here substitutes for a **[DEPLOY]** check.

### Rehearse the built app, not the dev server

Serve the built output, not `npm run dev`. A dev server ships un-bundled modules, registers no service worker manifest of the shape that ships, and hides exactly the class of failure this procedure exists to catch.

```bash
npm run build -w @kino/roll-web
npm run preview -w @kino/roll-web   # http://localhost:5173, /api proxied to :3000
```

Then reach it from the phone over the LAN at `http://<laptop-ip>:5173/r/<CODE>`.

### What that LAN address cannot do

A plain-`http` LAN address is not a secure context, and three of the things being accepted only exist in one:

- **No service worker.** Checks 28–31 and 37 are impossible. Nothing precaches, nothing survives airplane mode, no update bar can appear.
- **No install.** Checks 7–11 are impossible. There is no manifest install path, no standalone launch, no splash, and the home-screen icon question never arises.
- **No share sheet.** Checks 19–21 degrade: `navigator.share` is absent, so **Original** becomes a plain download that lands in Files rather than Photos, and **Share a link** copies to the clipboard instead of opening a sheet. What you are rehearsing there is the sheet's copy, not its behaviour.

To rehearse those three anyway, the phone needs an `https` origin. The honest options are a tunnel that terminates TLS for you, or `chrome://flags/#unsafely-treat-insecure-origin-as-secure` on an Android test phone with the LAN origin listed. Both are test-phone settings. Neither changes the app.

### What can be rehearsed today, on the LAN

Checks 1–4, 12–18, 22–27, 32–36 all work over the LAN once the roll and the captures exist, with the Twin ([ROLL_TWIN_INTEGRATION.md](ROLL_TWIN_INTEGRATION.md)) standing in for the camera on 32–34. That is the copy, the layout, the frame strip, the tabs, the hearts, the picks, the PIN gate, the closed banner, the dead ends, the live arrivals and both rotations — most of the procedure.

Check 6 will pass on the LAN and prove nothing: on the LAN the object store *is* reachable, which is precisely the condition that will not hold in production. Re-run 6 against the canonical origin and treat the LAN result as no evidence at all.

### The LAN address goes nowhere near shipped configuration

The app forms every URL from the origin it was loaded from, so a LAN rehearsal needs no configuration change and must not receive one:

- Do not add a base URL, an API host, or a `VITE_*` variable to make the LAN work. Nothing in the app reads one, and adding one is how a LAN address ships.
- Do not edit `vite.config.ts`. Its `server.proxy` and `preview.proxy` targets are `http://localhost:3000` and are dev-only — they are not emitted into `dist/`.
- The laptop's IP belongs on a sticky note, in a QR the host dashboard generates at run time, or in the phone's address bar. It does not belong in `index.html`, the manifest, or any file under `apps/roll-web/`.
- Verify before shipping: `grep -rI "192\.168\|10\.\|localhost" apps/roll-web/dist --include='*.js' --include='*.html' --include='*.webmanifest'`. The only permitted hit is the string `localhost` inside two dead `typeof window === 'undefined'` branches in the bundle, which cannot execute in a browser.

### What could not be verified without the production origin

Recorded here so nobody mistakes it for having been checked:

- That the edge falls back to `/index.html` for `/r/*` paths, and does not fall back for `/api/*`. Verified against a stand-in origin locally; the deployed edge's own rule is unverified.
- That the edge does not buffer `text/event-stream`, which is what check 32 depends on.
- That the object store the API redirects to is publicly reachable over TLS from a phone on cellular, and allows a cross-origin read from `https://kino.acronym.sk`. Checks 6 and 19.
- That `/sw.js` and `/index.html` are served with a no-cache policy at the edge. Without it a phone can hold an old shell for as long as its own heuristic cache lasts, and check 37 fails for a reason that is not in this app.
- Real safe-area inset values. A desktop browser reports zero for every `env(safe-area-inset-*)` regardless of emulation, so checks 11 and 36 have no non-device evidence behind them at all.
