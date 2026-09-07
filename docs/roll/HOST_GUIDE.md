# Running a party on KINO Roll

For the person throwing the party. Start to finish, in the order the evening happens.

This describes what the software does today. Where it does not do something, the sentence says so. Behaviour marked **(unverified)** is described from the change contract for this branch and was not read back out of the code at the time of writing.

---

## 1. Before anyone arrives

Three things must be true. None of them can be fixed at the party.

**The camera is provisioned.** Connect the D4 to a computer with a data-capable USB-C cable and open KINO Studio. Studio registers the camera against the server and writes the device credential into the camera's NVS. The camera cannot register itself in the field: registration needs the server's provisioning token, and without it the server answers `401 PROVISIONING_TOKEN_REQUIRED`. Registration is first-write-wins per serial in production — a second attempt on the same serial gets `409 DEVICE_ALREADY_REGISTERED`, not a fresh token.

**Wi-Fi is saved on the camera.** The camera joins the network on its own at power-on. Save the network you will actually use at the venue, on the camera, before the day. A guest network with a captive portal will not work: the camera has no browser.

**The server is reachable from that network.** Open `https://<your host>/api/healthz` from a phone on the venue Wi-Fi. It must answer `200` with `db`, `redis` and `storage` all true. A `503` names which of the three is down.

Also check the camera's compiled API base matches the server you intend to use. `GET_CONFIG network.apiBase` in Studio shows it. A bench camera often still points at a development API.

---

## 2. Create the roll

Two ways, same result:

- **From the camera, through Studio.** `ROLL_CREATE` with a name. The camera becomes the host device for that roll.
- **From the web.** `POST /api/host/rolls` from the site.

Either way the answer contains four things: `rollId`, `slug`, `guestUrl`, `hostUrl` — and `hostToken`, once.

### The host link, and the one copy problem

The host link looks like:

```
https://<your host>/host#token=<hostToken>
```

The server stores only a SHA-256 hash of that token. **It cannot be shown to you again.** There is no "resend host link", no email, no account to recover it from. Nothing in the product can reissue it.

What the host link is the only key to:

- the dashboard for that roll;
- hiding, trashing and restoring captures;
- setting or clearing the PIN;
- closing the roll;
- exporting the photographs.

If you lose it, the roll keeps running and guests keep seeing photographs. You lose moderation and export for that roll, permanently, unless an operator with database access intervenes.

So, before you do anything else: copy it out of the browser and paste it somewhere that survives the evening. A note on your own phone, a password manager entry, a message to yourself. Not just the open browser tab.

The dashboard has a **copy host link** button for exactly this. **(unverified — described from this branch's change contract; not read back out of `apps/roll-web` at the time of writing.)**

There is also an optional **keep me signed in on this device** on the dashboard. Turning it on stores the token in that browser so a reload does not lock you out. It is a convenience on *that* device only; it is not a backup of the token, and it is not a way to get the token back if you never copied it. **(unverified — same reason.)**

---

## 3. Join the cameras

The camera that created the roll is already on it.

**A second camera joins by code.** In Studio, connected to that camera over USB-C, send `ROLL_JOIN` with the roll's six-character code. The camera's own screen has no join control — there is no keyboard on the body — so this is a USB-C step, not a party step. Join the second camera before the party.

Ten wrong codes in a row lock joining for that device (`429 JOIN_LOCKED`).

After a reboot a camera finds its rolls again by itself.

---

## 4. How guests get in

A roll code is **six characters** from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. There is no `0`, `O`, `1`, `I` or `L` in the alphabet, so a code read off a screen across a room cannot be mistyped into a different roll. Codes are case-insensitive on the way in; the site upper-cases what is typed.

Four routes in, all equivalent:

| Route | What the guest does |
|---|---|
| Camera screen | Scans the QR block on the D4's ROLL screen, under **SCAN TO JOIN**. If the join URL is too long to encode, the camera shows the six-character code large instead, with "Enter this code to join". |
| Printed card | Scans the QR on a card you printed from the dashboard. **(unverified — printable QR card is from this branch's change contract.)** |
| TV display | Scans from a screen showing `/r/<CODE>/display` — the display page, meant for a television or a projector, which also shows photographs as they land. |
| Typing | Goes to the site root and types the six characters into the roll-code box. |

The camera screen is the reliable one: it needs no printer, no television, and it is where guests already are.

---

## 5. Setting a PIN

A roll with no PIN is *unlisted*: anyone holding the code can see it. Setting a PIN makes it *pin* privacy — the code alone is no longer enough.

Set or change it from the dashboard.

**Changing the PIN logs every guest out.** This is deliberate and it is not configurable. The guest's session cookie is a fingerprint of the stored PIN hash, and setting a PIN always re-hashes with a fresh salt — even to the same PIN. So every guest currently browsing is bounced back to the PIN gate and must type the new PIN. If you change the PIN at 23:00, forty people have to be told the new one at 23:00.

Clearing the PIN does the same thing: sessions issued under the old hash stop working.

The PIN itself is never written to the audit log — only that it changed.

If the *code* leaked rather than the PIN, rotate the code instead (**regenerate guest link** on the dashboard). Every copy of the old code stops resolving the moment it lands, and any signed media URLs handed out under the old code stop working too. Both cameras and both kinds of link have to be re-shown to guests afterwards.

---

## 6. During the party

You have two screens telling you two different things. They are not redundant.

### The camera's ROLL screen — the truth about the camera

One word for the connection:

| Word | Meaning | What it rules out |
|---|---|---|
| **ONLINE** | Wi-Fi is up and the server answered the last request. | Nothing is wrong with the network path. |
| **OFFLINE** | The camera has no network. | Not a server problem. Wi-Fi, range, or the venue's router. |
| **KINO NOT ANSWERING** | Wi-Fi is up; the server did not answer. | Not the camera's Wi-Fi. The server, the tunnel, or the internet between them. |
| **UPLOAD PAUSED** | The queue has stopped itself. Credentials or roll association were refused. | Not transient. It will not fix itself; the camera says "Check the roll in Studio." |

Under the connection word, the card count as one big number, then at most three lines:

- **"N waiting to upload"** with **"Saved safely on camera"** — the photographs exist on the SD card. They are not lost. They are waiting for a way out.
- **"N waiting to upload"** with a progress bar and "Uploading now" — work is moving right now.
- **"COUNTING THE CARD"** — the camera is still reading the card after boot. It does not yet know how many are waiting. This lasts seconds. A zero seen during this is not a real zero.
- **"All uploaded"** with **"Last upload Ns ago"** (or `Nm`, `Nh`) — nothing is owed.

### The dashboard — the truth about the server

Capture counts, live guest count, the moderation list, and a camera panel showing each joined camera: when it was last heard from, and how much it still owes. A camera that has joined but never sent a heartbeat shows as never heard from rather than as zero pending — those are different facts and the panel keeps them different. **(unverified — the camera panel and its heartbeat source are from this branch's change contract.)**

### Which to trust for what

- **"Are the photographs safe?"** — the camera. Originals land on the SD card before anything else. "Saved safely on camera" means exactly that.
- **"Can guests see them?"** — the dashboard. A photograph on the card that has not uploaded does not exist for guests.
- **"Is the network broken?"** — the camera's connection word. It is the only place that distinguishes *no Wi-Fi* from *server not answering*.
- **"Is anybody actually looking?"** — the dashboard's guest count. If Redis is down it reports 0 guests rather than failing; `/api/healthz` is where that outage is visible.

If the two disagree about a count, the camera is ahead of the server, not the other way round. Uploads lag; they do not run backwards.

---

## 7. Moderation

Two different actions on the dashboard, and they are not the same:

**Hide.** The photograph stops appearing to guests. Nothing is deleted. Unhide puts it straight back. Use this for the ordinary case: someone's eyes shut, a bad frame, a photo the subject asked you to take down for now.

**Trash.** The photograph goes into the trash and stops appearing to guests. The bytes are *not* removed immediately: they survive a grace period of **7 days**, and the dashboard shows each trashed capture with the date its bytes will actually go. Within that window, **restore** brings the capture back intact. **(unverified — the restore control and `POST /api/host/captures/:captureId/restore` are from this branch's change contract; `docs/roll/ROLL_DEVICE_CONTRACT.md` and the moderation code confirm the 7-day grace and the trash state, not the restore route.)**

After the 7 days a purge job removes the objects. There is no undo past that point.

**Clear roll** trashes every capture not already trashed, in one action. It is the same 7-day grace, applied to everything at once.

---

## 8. Closing the roll

Set the roll to **closed** on the dashboard. What changes:

- The gallery stays readable. Guests keep their link and keep seeing the photographs.
- New uploads are refused with `409 ROLL_CLOSED`.
- An upload session already open when you closed the roll is allowed to finish — closing does not strand half-transferred bytes.

**Close it after the cameras have drained, not before.** A camera still holding captures for a closed roll gets `409` on every attempt, treats it as a transient fault, backs off up to 30 s, and after 12 attempts parks the job as failed. The photographs are still on the SD card and can be recovered, but they will not upload themselves to a closed roll. Watch for **"All uploaded"** on both cameras' ROLL screens first.

From closed you can reopen (back to live) or archive. **Archive is terminal** — an archived roll cannot be reopened.

---

## 9. Exporting

Export gives you one ZIP of the whole roll: every original frame of every capture.

**Size.** Ask the dashboard for the size estimate before you start. A 300-capture party is on the order of four gigabytes. **(unverified — `GET /api/host/rolls/:rollId/export/estimate` and the dashboard estimate are from this branch's change contract.)**

**It is prepared once.** Starting an export queues a background job. While that job is running, asking again joins the same job rather than starting a second one. When it finishes, the dashboard gives you a download.

**Re-exporting makes another copy.** Once an export has finished, a new export request is a new job and a new ZIP, built from the roll as it is *now* — so a photograph you trashed between the two exports is in the first ZIP and not the second. Each ZIP occupies storage on the server.

**Where it goes.** The dashboard hands you a download link. In production the bytes come back through the API rather than from an internal storage URL, so the link works from outside the server's network. The signed link is good for 24 hours; after that, ask the dashboard for the export again. **(unverified — the proxied production download is from this branch's change contract; the 24-hour signed-URL lifetime is read from `apps/api/src/exports/exports.ts`.)**

Turning off guest downloads does not lock *you* out of your own export.

---

## 10. After the party

Say this plainly, because guests will ask.

**Nothing expires.** There is no retention policy in the product today. A roll does not close itself, does not archive itself, and does not delete itself. Photographs stay on the server until somebody removes them. "Somebody" is an operator with access to the deployment — it is not a scheduled job and it is not something a guest can trigger.

What *is* automatic is one thing only: a capture you put in the trash has its bytes purged 7 days later. Nothing else.

To have a roll's photographs removed:

1. Trash them yourself. **Clear roll** on the dashboard trashes every capture in one action. Seven days later the objects are purged. This is the only self-service path, and it needs the host link.
2. For anything beyond that — the roll row itself, an export ZIP, a roll whose host link was lost — ask the operator of the deployment. It is a manual action against the database and the object store. There is no request form and no automatic route.

Tell guests the honest version: the photographs stay up until the host clears them or the operator removes them, and the host link is what makes the first of those possible. That is why section 2 spends so long on not losing it.

---

## Related

- [Roll device contract](ROLL_DEVICE_CONTRACT.md) — what the camera does on the wire.
- [Troubleshooting](../TROUBLESHOOTING.md) — the "photos are not appearing" ladder.
- [Infrastructure](../../infra/README.md) — deployment, backups, restore.
