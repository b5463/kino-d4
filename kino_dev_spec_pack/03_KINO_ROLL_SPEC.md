# KINO Roll — Full Product Specification

## 1. Definition

KINO Roll is the live shared gallery and archive for KINO cameras.

Primary use:
- house parties.

Also suitable for:
- trips;
- weddings;
- festivals;
- family events;
- shoots;
- gatherings.

Primary domain:

```text
https://kino.acronym.sk
```

Recommended Roll URL:

```text
https://kino.acronym.sk/r/7F3K9Q
```

## 2. Core experience

```text
Host starts Roll
   ↓
KINO joins Wi-Fi
   ↓
server creates/joins Roll
   ↓
camera displays QR
   ↓
guests open PWA
   ↓
KINO captures
   ↓
SD first
   ↓
background upload
   ↓
thumbnail/wiggle appears live
   ↓
full originals continue uploading
```

No guest account required.
No app install required.

## 3. Local-first upload rule

Capture critical path:

```text
SHUTTER
  ↓
capture
  ↓
SAVE TO SD
  ↓
camera ready
  ↓
derivatives
  ↓
upload queue
```

Internet/server failure must never block shooting.

Queue persists across reboot.

## 4. Upload priority

Recommended:
1. metadata;
2. thumbnail;
3. lightweight wiggle preview;
4. processed KINO still;
5. full original frames;
6. larger derivatives;
7. optional AI derivatives.

Goal: fast perceived arrival in gallery.

## 5. Guest PWA

Guest features:
- live feed;
- wiggle playback;
- capture detail;
- view individual frames;
- download if allowed;
- share;
- favorite/reaction if enabled;
- full-screen playback;
- optional PWA install.

Do not make install mandatory.

## 6. Guest feed

Example:

```text
KINO ROLL
FRIDAY HOUSE PARTY              LIVE

[ animated wiggle ]
17:32 · Party Neg

♡ 23   Download   Share

[shot] [shot] [shot]
[shot] [shot] [shot]
```

New captures appear without refresh.

## 7. Real-time

Initial recommendation:
- Server-Sent Events (SSE).

Endpoint example:

```text
GET /api/rolls/:slug/events
```

Events:

```text
roll.opened
roll.closed
capture.created
capture.updated
capture.hidden
capture.deleted
processing.completed
```

WebSockets only later if truly needed.

## 8. Roll creation

Create from:
- camera touchscreen;
- Studio;
- host web.

Fields:
- title;
- privacy;
- optional PIN;
- downloads enabled;
- reactions enabled;
- optional retention policy later.

Server returns:
- Roll ID;
- slug;
- guest URL;
- host session/link;
- upload authorization scope.

## 9. Privacy

### Unlisted — default
Secret URL.

### PIN protected
Secret URL + short PIN.

### Public
Optional later, explicit only.

V1 should have no public directory.

Set:

```text
X-Robots-Tag: noindex, nofollow
```

## 10. Host dashboard

Route:

```text
https://kino.acronym.sk/host
```

Example:

```text
FRIDAY HOUSE PARTY

Status       LIVE
KINO         KD4-00001
Captures     127
Guests       34
Pending      3

[Show QR]
[Close Roll]
[Download All]
```

Host tools:
- hide;
- unhide;
- delete;
- disable downloads;
- rename;
- set PIN;
- regenerate guest slug;
- close/reopen;
- download originals;
- export ZIP;
- generate recap;
- inspect upload state.

## 11. Hide vs delete

Hide:
- immediate guest removal;
- retained for host/archive.

Delete:
- destructive;
- confirmation;
- optional trash/grace period.

## 12. Capture types

Initial:

```text
wiggle
quad
single
```

Future:

```text
video
burst
panorama
other multi-camera
```

Do not hard-code 4-frame media model into Roll.

## 13. Wiggle detail

Show:
- animated wiggle;
- play/pause;
- four originals;
- processed still;
- metadata;
- download/share.

Default D4 order:

```text
1 → 2 → 3 → 4 → 3 → 2
```

## 14. Quad detail

Show 2×2 (for D4) and recipe labels.

Example:

```text
Party Neg      Motion
Raw Digi       Acros-ish
```

## 15. Asset model

One capture owns multiple assets:
- thumbnail;
- processed still;
- original frames;
- wiggle WebP;
- MP4;
- GIF;
- contact sheet;
- AI-enhanced derivative.

UI must not equate capture with file.

## 16. Upload API

Suggested:

```text
POST   /api/device/rolls/:rollId/captures
POST   /api/device/captures/:captureId/assets/init
PUT    /api/device/uploads/:uploadId/parts/:partNo
POST   /api/device/uploads/:uploadId/complete
POST   /api/device/captures/:captureId/complete
GET    /api/device/captures/:captureId/status
```

Use resumable uploads for large assets.

## 17. Device authentication

Each KINO gets a per-device credential during provisioning.

Example identity:

```text
KINO D4
KD4-00001
```

Device token can:
- upload as this device;
- operate on assigned/open Rolls;
- never expose Wi-Fi credentials;
- never grant host admin.

## 18. Guest identity

Default anonymous.

May use ephemeral local ID/cookie.

Do not require guest accounts.

## 19. Processing workers

Jobs:

```text
generate-thumbnail
generate-gallery-still
render-wiggle-webp
render-wiggle-mp4
render-contact-sheet
extract-metadata
generate-recap
ai-enhance
```

All asynchronous, idempotent, retryable.

## 20. AI enhancement

Optional derivative only.

Expose conceptually:
- Original;
- KINO;
- KINO Enhanced.

Wiggle-safe processing must avoid frame-to-frame hallucination.

Safer operations:
- mild denoise;
- JPEG cleanup;
- restrained deblur;
- 1.5–2× upscale;
- preserve/reapply grain.

Do not default to face reconstruction/beauty processing.

## 21. Party recap

Host can generate recap after party.

Potential outputs:
- MP4;
- chronological web reel;
- title card;
- timestamps;
- mixed wiggle/quad moments.

## 22. Roll states

```text
Draft
Live
Closed
Archived
Trash/Deleted
```

Closed:
- no new uploads unless reopened;
- guest gallery remains accessible according to policy.

Archived:
- retained for host/history.

## 23. PWA requirements

- responsive;
- installable;
- iOS Safari + Android Chrome;
- cached shell;
- flaky network tolerant;
- lazy assets;
- virtualized long feed;
- live updates;
- offscreen wiggle animations paused;
- no mandatory refresh.

## 24. Performance assumptions

Design for:
- hundreds/thousands of captures;
- dozens of concurrent viewers;
- future 12 MP assets;
- multiple cameras per Roll.

Use thumbnails in first viewport, not originals.

## 25. Downloads

Guest:
- according to host permission.

Host:
- individual capture ZIP;
- originals;
- processed;
- full Roll export.

Large exports are background jobs with expiring links.

## 26. QR

Guest QR:

```text
https://kino.acronym.sk/r/<slug>
```

Host auth link/QR must be distinct.

## 27. Network provisioning

Studio sends camera:
- SSID;
- password;
- saved networks;
- server URL;
- auto-upload;
- resume setting.

Default server:

```text
https://kino.acronym.sk
```

Wi-Fi credentials remain local to camera.

## 28. Ownership/storage

PostgreSQL:
- structured metadata.

S3-compatible object storage:
- media.

Camera SD:
- local source of truth until successful upload.

## 29. Moderation

Host:
- hide;
- unhide;
- delete;
- disable downloads;
- close Roll.

Do not overbuild automatic moderation for V1.

## 30. Roll production acceptance

Ready when:
- no-login guest flow works;
- live feed works;
- queue survives Wi-Fi/server/reboot failures;
- uploads deduplicate;
- host moderation works;
- long Rolls remain performant;
- processing jobs fail independently;
- backups work;
- downloads respect permission;
- Wi-Fi credentials never reach backend.
