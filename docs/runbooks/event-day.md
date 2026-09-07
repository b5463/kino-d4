# Event day: hosting KINO Roll on demand

Production is one PC that runs on event days. It comes up before the party,
serves `https://kino.acronym.sk` while the party happens, stays up afterwards
until the upload queue has drained and one backup has finished, and then it may
sleep or be shut down. Nothing in this phase asks the machine to be awake when
nobody is using KINO.

What that removes, so nobody looks for it: no permanent sleep disable, no
unattended overnight availability, no automatic recovery while nobody is
shooting, no dedicated machine, no 24/7 Docker uptime. Those belong to the
always-on phase, and that phase is
[`origin-machine-move.md`](origin-machine-move.md).

What it does not remove: the canonical URL. `https://kino.acronym.sk` is the
product's address for the life of the product, including after the origin
machine is replaced. Nothing on a camera, in a QR code or in a guest's phone
ever holds a LAN address, a PC name or a temporary IP.

The public ingress mechanism is a separate decision and this document does not
assume one. Where a check depends on it, it says so and points at
[`public-ingress-options.md`](public-ingress-options.md). Bring-up of the relay
shape, which is the recommended one, is
[`production-relay-deploy.md`](production-relay-deploy.md).

All commands run from the repository root on the origin PC.

---

## 1. Pre-event acceptance checklist

Twelve checks, A to L. Walk them in order — each one rules something out, so a
later check read on its own means less. Every row has one expected result and
one thing to do if it does not appear.

Start about an hour before guests arrive. C, D and K are the ones that can take
time to fix.

### A. The PC is online

```powershell
Test-NetConnection 1.1.1.1 -Port 443 -InformationLevel Quiet
```

**Expect:** `True`.

**If not:** this is the venue's or the operator's own internet, not KINO. Fix it
before anything else in this list is meaningful; nothing below can pass without
it.

### B. Docker is healthy

```powershell
docker version --format '{{.Server.Version}}'
docker compose version
```

**Expect:** a server version and a Compose v2 version, both printed, no error.

**If not:** Docker Desktop is not running or has not finished starting. Start it
and wait for the whale to stop animating. Docker Desktop runs in the signed-in
user session, so a PC that was rebooted and not signed into has no engine at
all.

### C. The stack is healthy

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 up -Relay
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 status -Relay
```

`-Relay` belongs on every action for a relay deployment; drop it only on a stack
that publishes 80/443 itself.

**Expect:** `up` prints `api healthy` and `web healthy`. `status` lists `api`,
`web`, `proxy`, `worker`, `postgres`, `redis`, `object-storage` as running,
`migrate` and `createbucket` as `Exited (0)`.

**If not:** read the named service's log — `deploy.ps1 logs -Service api -Relay`
— and the deployment runbook's rollback section. A first build after a `git
pull` takes 10-20 minutes; that is not a failure, it is a reason to start early.

### D. The public ingress is healthy

Mechanism-dependent. On the relay shape:

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 logs -Service relay -Relay
```

**Expect:** the line `login to server success`. A running container is not
proof: frpc retries forever, so a wrong token gives a healthy-looking container
that never connected.

**If not:** check `RELAY_HOST` and `RELAY_TOKEN` against the VPS's own `.env`,
and that the VPS still has 7000 open. For any other ingress, the equivalent
check is whichever line that mechanism prints on a successful connection — see
[`public-ingress-options.md`](public-ingress-options.md).

### E. `kino.acronym.sk` resolves

```powershell
Resolve-DnsName kino.acronym.sk -Server 1.1.1.1
```

**Expect:** the `A` record is the current public front door's address, and there
is no leftover `AAAA`.

**If not:** `37.9.175.156` is the Websupport parking address, which means the
record was never changed or has not propagated. Anything else unexpected is a
DNS edit nobody finished. Do not work around this by handing anyone another
URL.

### F. HTTPS is valid

Open `https://kino.acronym.sk/` in a browser and look at the padlock, or:

```powershell
curl.exe -sI https://kino.acronym.sk/
```

**Expect:** no certificate warning; the request completes without a TLS error.
Plain HTTP redirects: `curl.exe -sI http://kino.acronym.sk/` gives 308 to
https.

**If not:** the certificate belongs to whatever terminates TLS at the edge, not
to this PC. On the relay, read Caddy's log on the VPS. Never delete `caddy_data`
to force a retry — Let's Encrypt rate-limits duplicate orders and the site then
stays broken for hours.

### G. `/api/healthz` is healthy

```powershell
curl.exe -sS https://kino.acronym.sk/api/healthz
```

**Expect:** `{"ok":true,"db":true,"redis":true,"storage":true}` with status 200.

**If not:** a `503` naming a dependency is the stack, and the JSON proves the
ingress is fine. A `502` with valid TLS is the opposite: the edge answered and
nothing was behind it. The full table is in
[`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md#is-the-tunnel-down-or-is-the-stack-down).

### H. The PWA opens on a phone, on mobile data

On a phone with **Wi-Fi switched off**, open `https://kino.acronym.sk/`.

**Expect:** the Roll app renders.

**If not:** and it works on the venue Wi-Fi, then the venue's router is
resolving or intercepting the name locally and no guest outside that network can
reach KINO. Mobile data is the only honest test here: the venue LAN can make a
broken deployment look perfect. This check is not optional and cannot be
delegated to the operator's own laptop on the same LAN.

### I. The D4 reports the production server reachable

On the camera, open the ROLL screen.

**Expect:** the connection word is **ONLINE**. (Over USB in Studio, the
equivalent is `ROLL_STATUS` reporting `serverState: "reachable"` and
`network.apiBase` = `https://kino.acronym.sk`.)

**If not:** **OFFLINE** is the camera's Wi-Fi — venue network, range, password.
**KINO NOT ANSWERING** is the server or the path to it, and means A to G were
read too optimistically; go back to G. **UPLOAD PAUSED** is a refused
credential and will not clear itself: re-provision the camera in Studio before
the party, because nothing it shoots will upload until somebody does.

### J. The Roll QR opens the correct public URL

Scan the roll's QR with a phone — the one on the camera's ROLL screen or on the
printed card.

**Expect:** the phone opens `https://kino.acronym.sk/r/<slug>` and lands on that
roll.

**If not:** the QR is built from `PUBLIC_BASE_URL`. A QR that opens a LAN
address, a `localhost` or the wrong host means `infra/.env.production` is wrong;
fix it, `deploy.ps1 up -Relay` again, and create the roll after the fix — a roll
created with the wrong base URL keeps the wrong link.

### K. One real physical-shutter photograph appears on the phone

Press the camera's shutter button. Not a capture triggered from Studio over
KDP — the physical button, because it is a different code path on a different
task and it is the one every guest will use.

**Expect:** the photograph appears on the guest phone's roll page without a
reload, within a few seconds.

**If not:** the ROLL screen says which half is at fault. "N waiting to upload"
that never falls is the upload path; a tile that never appears while the
dashboard shows the capture is the live feed. A capture visible only after a
manual reload is an edge buffering the event stream — see the failure table in
section 2.

### L. The queue returns to zero

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 drain -Roll <slug> -Expect 1
```

**Expect:** `VERDICT: SAFE TO SHUT DOWN`, with the one test photograph counted.

**If not:** read the printed reasons. A camera "last heard from 200 s ago" is
usually a camera that went to sleep on the bench, not a fault; wake it and run
the command again.

### The verdict

**EVENT READY** only if A through L all passed. Eleven of twelve is not ready —
each of these twelve is the sole check on one thing, and the one you skipped is
the one that will fail in front of guests.

If a check cannot be made to pass, the party can still be photographed: the
cameras shoot to their cards and upload later. Say that out loud to whoever is
hosting, and do not stop the party to fix a deployment.

---

## 2. During the event: what is and is not a camera failure

Say this out loud at the party, in these words:

> If the PC, the tunnel or the internet goes away, the cameras keep working.
> Every photograph is written to the camera's own card with its roll and its
> identity. They upload themselves when the server comes back. Nobody has to
> press anything.

That is not reassurance, it is the design. The shutter path does not wait on the
network, the capture is on the SD card with its UUID and its roll before
anything is uploaded, and the upload queue is durable across a power cycle.
Measured on the bench on 2026-09-05: a 40-capture outage and a 105-capture
backlog, all recovered with no manual step.

### What the camera says, in its own words

The ROLL screen's wording is the operator's script. Quote it rather than
paraphrasing; guests can read the same screen.

| On the screen | What is actually true | What to say |
|---|---|---|
| **OFFLINE** / "N waiting to upload" / "Saved safely on camera" / "They go when Wi-Fi returns." | The camera has no network. The photographs are on the card. | "The camera is fine, it just can't see the Wi-Fi. Nothing is lost." |
| **KINO NOT ANSWERING** / "N waiting to upload" / "Saved safely on camera" / "Wi-Fi is up. They go when KINO answers." | Wi-Fi is up; our origin, ingress or internet is down. Not the venue's network. | "Our server is away. The camera keeps shooting and sends them when it's back." |
| **ONLINE** / "N waiting to upload" with a bar / "Uploading now" | Recovery in progress. | "It's catching up. Nothing to do." |
| **ONLINE** / "All uploaded" / "Last upload Ns ago" | The camera owes the server nothing. | "This camera is done." |
| **UPLOAD PAUSED** / "N waiting to upload" / "Saved safely on camera" / "Check the roll in Studio." | The queue halted on a credential this server refused (401/403). This one does **not** clear itself. | "This camera needs re-provisioning. Photographs are safe; keep shooting." |
| "COUNTING THE CARD" | The camera has not finished reading its card since boot. It does not yet know what it owes. | Wait. A zero seen here is not a zero. |
| "Nothing waiting" / "Uploads resume when Wi-Fi returns." | Nothing to send. | Nothing. |

The big number above those lines is the count on the card and it never goes down
because of a network fault. If it is rising, photography is working.

### What the operator does

Nothing, during the party, beyond noticing. There is no manual enqueue, and
there is no command that pushes a backlog: the camera's own timer resumes and
works its queue when the server answers again. **UPLOAD PAUSED** is the single
exception, and it is a Studio job over USB, not a server job.

If the PC has to be rebooted mid-event, that is allowed and it is not an
emergency. Bring the stack back with `deploy.ps1 up -Relay` and the cameras
reconnect on their own.

### Faults that look like the camera and are not

| Symptom | Layer | First command |
|---|---|---|
| `/api/healthz` returns **502** with valid TLS | The ingress. The edge answered; nothing was behind it — PC off, asleep, Docker down, tunnel not connected. | `deploy.ps1 logs -Service relay -Relay` |
| **503** with a JSON body naming `db`, `redis` or `storage` | The stack. That JSON could only have been written by our API, so the ingress is fine. | `deploy.ps1 logs -Service api -Relay` |
| Health is fine, capture pages load, and the feed **freezes and then jumps several photographs at once** | Something between the API and the phone is buffering the event stream. The API already sends `x-accel-buffering: no` and `no-transform`, and a heartbeat every 25 s; a hop that ignores those is the suspect. | Compare a second phone on a different network, then [`public-ingress-options.md`](public-ingress-options.md) |
| Captures reach the dashboard and stay pending for more than five minutes | The worker, not the camera. The bytes are on the server; nothing is rendering them. | `deploy.ps1 logs -Service worker -Relay` |

### Which numbers prove the recovery afterwards

Not "it looked fine". These four:

1. **On the camera:** the ROLL screen reads "All uploaded" with a "Last upload
   Ns ago", and no line reads "waiting to upload".
2. **From the heartbeat:** `deploy.ps1 drain -Roll <slug>` shows every camera
   with `waiting 0 uploading 0 failed 0`, seen seconds ago, and `paused false`.
   That `waiting` figure already includes the card's backlog beyond the RAM
   window — the firmware sums `pending + cardPending` before it sends the
   heartbeat, which is the same number the screen calls waiting.
3. **On the server:** the roll's capture count equals what the event should have
   produced. `-Expect <n>` makes `drain` check it for you.
4. **No duplicates:** the count above is exact, not approximate. A capture is
   keyed by its device-generated UUID with a unique index on `(roll_id,
   capture_uuid)`, and each asset upload carries the idempotency key
   `<captureUuid>:<role>:<frameIndex>`. A retried upload after an outage
   therefore cannot produce a second photograph. If the count is *higher* than
   expected, the excess is somebody else's captures on the same roll, not
   duplicates.

---

## 3. Post-event: drain, then back up

Leave the stack running after the guests leave. This takes minutes, not hours,
and it is the whole reason the machine stays awake past the party.

### The drain gate

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 drain -Roll <slug> -Expect <count>
```

It passes when all of this is true:

| Gate | Where it comes from |
|---|---|
| `pending = 0` | each camera's last heartbeat (`pending + cardPending`, summed by the firmware) |
| `uploading = 0` | same |
| `cardPending = 0` | inside the `pending` figure above; it is not a separate field on the wire |
| `failed = 0` | same. Non-zero means jobs this server refused: retry them from Studio |
| `scanComplete = true` | **not on the heartbeat wire.** Confirm it on the camera: the ROLL screen must read "All uploaded", never "COUNTING THE CARD" |
| the expected capture count on the roll | `-Expect <count>`, checked against the `captures` rows |

`drain` also refuses to pass on things the list above does not mention but that
mean the same thing: a camera that has not called in for more than 180 s (its
numbers are not current), a camera that reports `UPLOAD PAUSED`, an asset still
in flight, an upload session still open, a capture with no original on this
server, or an object store holding fewer objects than the database claims.

**Where the answer comes from, and why:** `drain` reads the origin's own
PostgreSQL through `docker compose exec postgres psql`, and counts objects with
`mc` inside the stack. The alternatives were the camera's ROLL screen (true
about the card, but it is a device in somebody's hand, there are four of them,
and it knows nothing about whether the server kept the bytes), a USB query over
KDP (needs the camera cabled to this PC — collecting four cameras and a cable to
answer a question about the server), and the host dashboard or the API over the
canonical URL (right numbers, but reached through a browser, a host token and
the public ingress, all of which can be the thing that is broken). The local
database read needs no token, no browser, no cable and no ingress, and it works
with the tunnel down — which is exactly the state in which somebody wants to
know whether it is safe to give up and go to bed. The long version of that
argument, and the two things this read cannot see, are in the comment block
above `Get-DrainReport` in `infra/deploy.ps1`.

`drain` exits 0 on `SAFE TO SHUT DOWN` and 1 on `NOT SAFE`, so it can gate a
script. Nothing is lost while you wait for it: the card keeps the photographs.

### The event backup

One step, and it covers both stores. A PostgreSQL dump on its own protects no
photograph: the rows say which asset exists and where its object lives, and the
object lives in the object store.

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 event-backup -Roll <slug> -BackupRoot D:\kino-backups
```

That writes `D:\kino-backups\events\<yyyy-MM-dd>-<slug>\daily\<UTC stamp>\`
containing `postgres.dump`, an `objects/` mirror of both buckets, `BACKUP_INFO`
and `SHA256SUMS` — then verifies it and fails loudly if the dump is tiny, the
object mirror is empty, or the checksums do not match. The date and the roll
code are in the path, so a year later the directory name still says which party
it was.

It is not a third backup implementation: it is `infra/backup-task.ps1 run`
followed by `verify`, with a per-event `-BackupRoot`. Neither that script nor
`infra/scripts/backup.sh` needed changing to do per-event destinations —
`BACKUP_ROOT` was always just a root, and `backup.sh` writes its timestamped
snapshot underneath whatever root it is handed.

`-BackupRoot` must be a disk whose failure is not the same failure as this PC's:
an external drive or a NAS mount. Neither script can check that and neither
pretends to.

The daily scheduled task (`backup-task.ps1 register`) is a different thing and
still worth having. It protects the days between events; this protects the
event.

### Then, and only then

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 down -Relay
```

Volumes — database, object storage, TLS certificates — are preserved. Restore
the sleep setting (section 4) and the machine is the operator's PC again.

Stopping the stack is optional. Leaving it up costs nothing but power and means
the next event needs fewer of section 1's checks.

---

## 4. Sleep, for one event only

The PC must not sleep while it is the origin. It must also not be permanently
prevented from sleeping — this is the operator's own machine, and a permanent
change is the always-on phase's business, not this one.

So: read the current value, change it for the event, put it back afterwards.
Run these in an **elevated** PowerShell. Do not let a script do it for you; the
value you are about to overwrite is the one you need to restore.

**Read it first, and write the answer down.**

```powershell
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
powercfg /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE
```

Read `Current AC Power Setting Index`. It is hex **seconds**: `0x00000708` is
1800 s, which is 30 minutes. `0x00000000` means sleep is already off on AC and
there is nothing to restore.

**Disable for the event:**

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Those take **minutes**, and `0` means never. Leave the display timeout alone —
a dark screen does not stop Docker.

**Check nothing else will interrupt:** `powercfg /requests` shows what is
currently holding the machine awake or asleep. Keep the PC on mains; the `-ac`
settings say nothing about battery.

**Restore afterwards**, with the numbers you read above, converted to minutes:

```powershell
powercfg /change standby-timeout-ac 30
powercfg /change hibernate-timeout-ac 180
```

Then read it back with the same two `/query` commands and confirm the index
matches what you wrote down.

If the PC did sleep mid-event, that is the 502-with-valid-TLS symptom in section
2 and it costs no photographs: the cameras hold them and upload when the machine
wakes.

---

## What this document deliberately does not require

Recorded because these were production prerequisites before the model changed,
and they will be again in the next phase:

- a permanent Windows sleep disable;
- unattended overnight availability;
- automatic recovery when nobody is using KINO;
- a dedicated PC;
- 24/7 Docker uptime.

All five belong to [`origin-machine-move.md`](origin-machine-move.md). Gate F1
and F2 in [`production-relay-deploy.md`](production-relay-deploy.md) are the old
wording of the first two; they are not gates for an on-demand event deployment.
