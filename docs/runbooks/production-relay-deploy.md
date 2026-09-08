# Deployment day: kino.acronym.sk through a relay VPS

The stack runs on the operator's Windows PC. The public name
`https://kino.acronym.sk` reaches it through one outbound connection to a small
VPS. Nothing on the PC listens on the internet, DNS stays at Websupport, and
the router is not touched.

This runbook is the whole day, in order: what to provision, the one DNS record,
the commands on each machine, how to prove it works, how to tell a dead tunnel
from a dead stack, and how to get back if it goes wrong.

Companion documents: [`infra/README.md`](../../infra/README.md) for what the
compose files contain, [`restore.md`](restore.md) for backup and restore,
[`observability.md`](observability.md) for metrics.

## Why a relay and not port forwarding

Measured on the PC, 2026-09-06 and re-checked 2026-09-07:

| Fact | Value |
|---|---|
| Egress address seen by the internet | `46.34.228.61` (O2 Slovakia) |
| `tracert` hop 1 | `10.20.99.1` — the operator's own router |
| `tracert` hop 2 | `10.106.16.198` — private, **beyond** the router |
| `tracert` hop 4 | `10.109.122.193` — private, beyond the router |
| `tracert` hop 5 | `90.176.30.41` — first public address |
| Global IPv6 on the PC | none; no IPv6 egress at all |
| `kino.acronym.sk` today | `37.9.175.156`, `2a00:4b40:aaaa:2004::7` (Websupport parking) |

Two private hops sitting **beyond** the operator's own router is the signature
of carrier-grade NAT: the public address `46.34.228.61` belongs to the carrier,
not to the router, and it is shared. An inbound TCP connection to port 443 has
nowhere to be forwarded from, because the carrier's NAT has no rule for this
subscriber and no interface the operator can configure. No DNS record and no
router setting changes that. An `AAAA` record to the PC is impossible for a
second, independent reason: the PC has no IPv6 address to put in one.

So direct inbound hosting is not viable, and per the standing instruction we
stop before any network change.
>
> **Status, 2026-09-08: this is the FALLBACK ingress, not the selected one.**
> The selected path is a Pinggy Pro custom-domain tunnel, whose purchase is
> blocked pending privacy and data-processing clarification — see
> [public-ingress-options.md](public-ingress-options.md) for the standing
> decision and [pinggy-plan-facts.md](pinggy-plan-facts.md) for the blocker.
> Nothing below is invalid or abandoned: this procedure is complete, tested as
> far as it can be without a VPS, and it is the privacy and control answer,
> because a relay we operate has no third-party tunnel provider reading
> application payloads. Follow it if the Pinggy privacy position cannot be made
> acceptable, if Pinggy proves unreliable or changes its custom-domain
> behaviour, or if a deployment needs infrastructure under our own control.

The relay is the path that works while
Websupport stays authoritative for `acronym.sk`.

**The one remaining unknown.** Everything above is consistent with CGNAT but
does not close it, because the traceroute cannot see the router's own WAN
interface. The router's status page can. Read it before buying anything:

| Router WAN address shows | Meaning | What to do |
|---|---|---|
| `46.34.228.61` (equals the egress address) | Not behind CGNAT. The public address terminates on the router. | The direct path becomes possible: one `A` record to `46.34.228.61`, router TCP 80 and 443 forwarded to this PC, production compose as-is with Caddy doing ACME. It is still a *worse* path — a residential address is dynamic, so a Websupport-API updater would be needed on the PC, and the Apache problem below becomes blocking rather than irrelevant. The relay remains the recommendation; the direct path becomes a fallback that exists. |
| `10.x.x.x` or `100.64–100.127.x.x` | CGNAT confirmed. | Relay. Inbound 80/443 can never arrive. |
| A public address that is **not** `46.34.228.61` | Something else is in the path (a second NAT, a VPN, a modem in router mode). | Do not deploy on assumptions. Record what it says and re-derive. |

Nothing else in this document changes with the answer. The relay path works in
all three cases.

## Apache holds 80 and 443 on the PC

Measured on the PC, 2026-09-07:

```
netstat -ano | findstr ":80 "     ->  TCP 0.0.0.0:80    LISTENING  8088
netstat -ano | findstr ":443 "    ->  TCP 0.0.0.0:443   LISTENING  8088
```

PID 8088 is `httpd.exe` from `C:\Bitnami\wordpress-6.0.3-0\apache2\bin\`, run by
the Windows service **`wordpressApache-1`**, start mode **Automatic** — so it
comes back on every reboot. A second Apache, `PEMHTTPD` (EDB Postgres
Enterprise Manager, PID 8032), is also running but does not hold 80 or 443.
A third service, `wordpressApache`, is registered and stopped.

What that blocks, per path:

| Path | Blocked by Apache? | Why |
|---|---|---|
| **Relay VPS (this document, the fallback)** | **No.** | With the relay overlay the stack publishes **zero** host ports (proven below). Caddy serves `:80` inside the Compose network only. frpc dials **out** to the VPS. Apache can keep both ports and nothing collides. |
| Cloudflare Tunnel overlay | No, same reason. Not chosen for a different reason: the **free** shape needs Cloudflare authoritative for `acronym.sk`, and the zone is staying at Websupport. Cloudflare is not impossible — a partial (CNAME) setup keeps the zone but is Business or Enterprise only at $250/month, and Cloudflare for SaaS custom hostnames costs $0/month with 100 hostnames on the free plan but needs a second domain on a Cloudflare account as the front door. Costs, conditions and the server-sent-events argument that keeps the relay first: [`public-ingress-options.md`](public-ingress-options.md). | |
| Direct, router-forwarded | **Yes, hard block.** | The production stack publishes `80:80` and `443:443`. `docker compose up` fails on port allocation, and the site stays down. Before that path is possible: `Stop-Service wordpressApache-1` and `Set-Service wordpressApache-1 -StartupType Disabled`, or move Apache to other ports. Do not do this to make the relay work — it is not needed there. |

`deploy.ps1 check` now warns when 80 or 443 is already held and the relay
overlay is not selected. It caught PID 8088 on this machine.

## What to provision

| Item | Requirement | Notes |
|---|---|---|
| VPS | 1 vCPU, 1 GB RAM, 10 GB disk, **static IPv4**, Debian 12 or Ubuntu 24.04 | It holds no data: two containers, TLS state, nothing else. The cheapest tier from a provider the operator trusts is enough. Prefer one physically near Slovakia — every byte of every photograph a guest views crosses it twice. |
| VPS firewall | inbound TCP **80**, **443**, **7000** only; SSH on whatever port the provider gives you | 80/443 for Caddy and ACME, 7000 for frps. Nothing else. |
| Websupport | authority for `acronym.sk` stays exactly where it is | One record to add. See below. |
| PC | Docker Desktop running, `infra/.env.production` filled in | Sections below. |
| `RELAY_TOKEN` | one long random string, generated once | `openssl rand -hex 32`. Goes in **both** env files, byte-identical. |
| Off-PC backup target | a path on another disk or a NAS mount | `infra/backup-task.ps1 register -BackupRoot <path>`. Not optional: until it has produced a snapshot there is no backup of a single photograph. |

Cost is one VPS per month and nothing else. No Cloudflare account, no DNS
migration, no static-IP order from O2.

## Websupport: one A record, nothing else touched

In the Websupport DNS editor for `acronym.sk`:

| Action | Type | Name | Value | TTL |
|---|---|---|---|---|
| **Add or edit** | `A` | `kino` | the VPS's static IPv4 | 600 |

That is the entire DNS change.

- Do **not** change the nameservers. Websupport stays authoritative.
- Do **not** add an `AAAA` for `kino` unless the VPS has a real IPv6 address
  **and** you have tested the stack over it. A published `AAAA` that does not
  answer makes the site fail for IPv6-preferring phones while looking fine on
  the PC.
- The existing `kino` records pointing at Websupport parking
  (`37.9.175.156`, `2a00:4b40:aaaa:2004::7`) must be **replaced**, not
  supplemented. An `A` at the VPS alongside the parking `AAAA` gives every
  IPv6 phone the parking page.
- Leave `acronym.sk` itself, `www`, MX and TXT alone. Nothing here touches
  mail.
- TTL 600 while deploying. Raise it later if you want; there is no need.

Wait for it before continuing. From the PC:

```powershell
Resolve-DnsName kino.acronym.sk -Type A -Server 1.1.1.1
Resolve-DnsName kino.acronym.sk -Type AAAA -Server 1.1.1.1
```

The `A` must be the VPS. The `AAAA` must be **absent** (or the VPS's own).
Caddy cannot get a certificate until the `A` is live worldwide.

## On the VPS, in order

SSH in as a user with sudo.

```sh
# 1. Docker.
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker

# 2. Firewall: 80, 443, 7000, and your SSH port. Nothing else.
sudo ufw allow 22/tcp        # or the provider's SSH port
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7000/tcp
sudo ufw --force enable
sudo ufw status numbered

# 3. The relay's two config files. Copy only infra/relay/vps/ from the repo -
#    the VPS needs nothing else and must never hold .env.production.
mkdir -p ~/kino-relay && cd ~/kino-relay
# scp -r <pc>:'.../kino d4/infra/relay/vps/*' ~/kino-relay/   (or git clone and copy)
ls    # expect: Caddyfile  docker-compose.yml  frps.toml  .env.example

# 4. The environment file.
cp .env.example .env
openssl rand -hex 32          # copy this; it is RELAY_TOKEN on BOTH machines
nano .env                     # set KINO_SITE_ADDRESS=kino.acronym.sk and RELAY_TOKEN

# 5. Validate before starting anything.
sudo docker compose config --quiet && echo OK

# 6. Start.
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs caddy | tail -40
```

Caddy will try ACME immediately. Expect `certificate obtained successfully` for
`kino.acronym.sk` within a minute. If it loops on
`no server was reachable` or an authorization failure, the `A` record has not
propagated or the firewall is still closed on 80 — fix that, not the Caddyfile.

At this point `https://kino.acronym.sk/` answers with a **502**. That is
correct and expected: TLS terminates, and there is nothing behind it yet.
A 502 here is the proof that the VPS half works.

## On the PC, in order

PowerShell, from the repository root.

```powershell
# 1. Environment file. Writes generated secrets for every change-me value.
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 init

# 2. Edit infra\.env.production by hand for the four values no generator knows:
#      KINO_SITE_ADDRESS=kino.acronym.sk
#      PUBLIC_BASE_URL=https://kino.acronym.sk
#      RELAY_HOST=<the VPS's static IPv4>
#      RELAY_TOKEN=<the exact string from the VPS's .env>
#    PROVISIONING_TOKEN was generated by init; keep it, you need it in Studio.
notepad infra\.env.production

# 3. Check. -Relay on EVERY command from here on.
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 check -Relay

# 4. Build and start. First run pulls and builds; allow 10-20 minutes.
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 up -Relay
```

`up -Relay` waits for `api` and `web` to report healthy, then prints the frpc
log. Look for `login to server success`. A running `relay` container is not
proof of a tunnel — frpc retries forever by design (`loginFailExit = false`),
so a wrong token produces a healthy-looking container that never connects.

Why `-Relay` on every command, including `down` and `logs`: without it the
compose file list is the production file alone, which drops the frpc container
and republishes 80/443 — which Apache holds, so the `up` fails outright.

## Verify

Do this from a phone on **mobile data**, not from the PC and not from the LAN.
A machine inside the house can succeed for reasons that have nothing to do with
the public path.

| Check | Command or action | Expected |
|---|---|---|
| DNS | `Resolve-DnsName kino.acronym.sk -Server 1.1.1.1` | `A` = the VPS. No stray `AAAA`. |
| TLS | open `https://kino.acronym.sk/` | Padlock, no warning. Certificate issued to `kino.acronym.sk` by Let's Encrypt (ISRG), `notAfter` about 90 days out. |
| TLS, from a shell | `curl -vI https://kino.acronym.sk/ 2>&1 \| grep -E "subject:\|issuer:\|expire"` | Same, in text. |
| API health | `curl -s https://kino.acronym.sk/api/healthz` | `{"ok":true,"db":true,"redis":true,"storage":true}`, HTTP 200. Any `false` gives HTTP 503 and names the broken dependency. |
| PWA | `https://kino.acronym.sk/` | The Roll app, not a 502 and not the Websupport parking page. |
| Studio | `https://kino.acronym.sk/studio/` | Studio loads. |
| Live feed (SSE) | open a roll page, upload one capture from another device | The tile appears without a reload. This is the path most likely to be broken by a proxy, so test it deliberately. |
| Nothing listens on the PC | `netstat -ano \| findstr ":443 "` | Only PID 8088 (Apache). No Docker listener. |
| Redirect | `curl -sI http://kino.acronym.sk/` | 308 to `https://`. |
| Client address is real | `docker compose ... logs api` after a phone request | The logged request IP is the phone's public address, not `172.x` or `10.x`. If it is private, `TRUST_PROXY` is wrong and every rate limit is keyed on the wrong value. |

Then the camera: build the bench image with
`-DKINO_ROLL_API_BASE=https://kino.acronym.sk`, or clear the stored
`network.apiBase` and set it from Studio. A body still pointing at the LAN dev
API uploads nothing to production and looks like a broken camera.

## Is it the tunnel or is it the stack?

The single most useful skill on deployment day. Work down the list; the first
row that fails names the layer.

| Symptom at `https://kino.acronym.sk` | Layer | Confirm | Fix |
|---|---|---|---|
| DNS does not resolve, or resolves to `37.9.175.156` | DNS | `Resolve-DnsName ... -Server 1.1.1.1` | Websupport record wrong or not propagated. Wait, or fix the record. |
| Connection refused / times out at the TCP level | VPS or its firewall | `ssh` in; `sudo docker compose ps`; `sudo ufw status` | Start the VPS caddy; open 80/443. |
| TLS warning or wrong certificate | VPS Caddy / ACME | `sudo docker compose logs caddy \| tail -50` | Usually the `A` record or a closed port 80. Do not delete `caddy_data` to "retry" — that discards the certificate and burns Let's Encrypt rate limit. |
| **HTTP 502 from an otherwise valid TLS connection** | **The tunnel is down.** | On the VPS: `sudo docker compose logs frps \| tail -30`, and `sudo ss -ltnp \| grep 8080` shows nothing bound. On the PC: `deploy.ps1 logs -Service relay -Relay` | The PC's frpc is not connected: PC off, asleep, no internet, Docker Desktop not running, wrong `RELAY_TOKEN`, or 7000 closed on the VPS. |
| **HTTP 503 with a JSON body naming `db`, `redis` or `storage` as `false`** | **The stack is up, a dependency is down.** The tunnel is fine — that JSON came from the API through it. | `deploy.ps1 status -Relay` | Restart or investigate the named container. |
| HTTP 502 **and** the PC shows `login to server success` | frps ↔ Caddy on the VPS | On the VPS: `sudo ss -ltnp \| grep 8080` | If 8080 is bound but Caddy still 502s, the VPS Caddyfile's upstream is wrong. If it is not bound, frps rejected the proxy — check `allowPorts` in `frps.toml`. |
| Pages load, live feed never updates | SSE through the proxies | Watch the browser's network tab: the `events` request should stay open with `Content-Type: text/event-stream` and **no** `Content-Encoding` | All three Caddyfiles now exclude `text/event-stream` from compression and set `flush_interval -1`. If a hop still buffers, that hop's `encode` is the suspect. |
| Everything works from the PC, nothing from a phone | You tested from inside | Retest on mobile data | Not a fault. Retest properly. |

The clean discriminator, worth memorising: **502 means the tunnel; 503 with a
JSON body means the stack.** A 503 could only have been written by the API.

## Rollback and recovery

### Rolling the software back

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 backup            # pg_dump first, always
git -C "<repo>" log --oneline -10                                            # pick the last good commit
git -C "<repo>" checkout <commit>
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 up -Relay          # rebuilds from that tree
```

**What a code rollback does not undo: the database schema.** Migrations are
forward-only (`apps/api/src/migrate.ts` runs Drizzle's migrator, which applies
only entries newer than the last applied one). An older image's `migrate`
therefore does nothing and the old code runs against the **new** schema. That
is safe when the migration only added things. It is not safe when a migration
dropped or renamed a column the old code reads — in that case restore the
database from the last snapshot taken **before** the deploy, per
[`restore.md`](restore.md), and accept the data loss between then and now.

Decide this before deploying, not during: look at what the pending migrations
do. Additive only, or destructive?

### Safe to re-run, any number of times

| Thing | Why it is safe |
|---|---|
| `deploy.ps1 check -Relay` | Reads only. |
| `deploy.ps1 up -Relay` | Idempotent. Recreates only what changed. |
| `deploy.ps1 down -Relay` then `up -Relay` | Volumes are always preserved; `down` never passes `-v`. |
| The `migrate` container | Drizzle skips already-applied migrations. |
| `createbucket` | `mc mb --ignore-existing`. |
| `backup-task.ps1 run` / `verify` | New dated snapshot; retention prunes. `verify` reads only. |
| `infra/scripts/restore-drill.sh` | Builds its own throwaway Compose project with scratch volumes. Never touches production. |
| `infra/scripts/backfill-thumbnails.ts` | Queues idempotent jobs. Dry run by default. Do not start one during a live party — it inflates the host's Pending count. |
| VPS `docker compose up -d` | Idempotent. Caddy reuses the certificate in `caddy_data`. |

### Never re-run, and what to do instead

| Thing | Why | Instead |
|---|---|---|
| `docker compose down -v`, or deleting `pgdata` / `miniodata` | Destroys the database and every photograph. There is no undo. | `down` without `-v`. To reset a *test* stack, use a different `KINO_ENV` so it gets its own volumes. |
| `deploy.ps1 init` over an existing `.env.production` | It refuses, and that refusal is a feature: regenerated secrets orphan the database password, the cookie secret (every guest session invalidated) and every device token. | Edit the existing file. |
| Editing or deleting a migration that has already been applied to production | The applied journal no longer matches the folder. The next `migrate` either fails or, worse, skips a real change. | Add a new forward migration. |
| `DEVICE_REGISTRATION_MODE=rotate` left enabled | Any request re-submitting a serial rotates a deployed camera's credential. | Set it only for one restart, register the one physically verified device, set it back to `first-write-wins`, restart again. |
| Deleting `caddy_data` on the VPS to "retry" TLS | Discards the issued certificate and its ACME account, and Let's Encrypt rate-limits repeats (5 duplicate certificates per name per week). | Read `logs caddy` and fix the actual cause: DNS, or port 80. |
| Rotating `RELAY_TOKEN` on one machine only | frpc retries forever and the site 502s with no error that names the token. | Change both files, restart both sides. |
| Restoring a newer database over an older media snapshot | Asset rows pointing at objects that do not exist. | One snapshot is one recovery point. Restore both halves from the same dated directory. |

### Windows-specific risks, with the remedy

Not warnings. Do these.

| Risk | Remedy | Verify |
|---|---|---|
| **The PC sleeps and the site dies** | `powercfg /change standby-timeout-ac 0`, `powercfg /change hibernate-timeout-ac 0`, `powercfg /change monitor-timeout-ac 15`. Run as administrator. Keep the machine on mains. | `powercfg /query SCHEME_CURRENT SUB_SLEEP` shows the AC standby index as 0. |
| **After a reboot the stack is down until someone signs in** — Docker Desktop runs in the user session | Two parts, both needed. (1) Docker Desktop → Settings → General → tick *Start Docker Desktop when you sign in*. (2) Enable automatic sign-in, then lock the screen so the session exists without the desktop being exposed: `reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 1 /f`, `... /v DefaultUserName /t REG_SZ /d "<user>" /f`, `... /v DefaultDomainName /t REG_SZ /d "<machine>" /f`, and store the password with `netplwiz` (untick *Users must enter a user name and password*) rather than in `DefaultPassword`, which is plaintext in the registry. Then a Task Scheduler task at logon running `rundll32.exe user32.dll,LockWorkStation`. | Reboot. Do not touch the keyboard. From a phone on mobile data, `https://kino.acronym.sk/api/healthz` comes back within about three minutes. This is the test; nothing else proves it. |
| **Docker Desktop starts but the engine does not** (WSL2 update pending, a dialog waiting for a click) | After any Windows or Docker Desktop update, sign in interactively once and let it finish. `wsl --update` proactively. Do not leave a pending update over a party. | `docker version` returns a server version, not a pipe error. |
| **The containers do not come back** | Nothing to do: every long-running service is `restart: unless-stopped` and Docker Desktop restarts them once the engine is up. The exception is a service stopped by hand — `unless-stopped` remembers that and leaves it stopped. | `deploy.ps1 status -Relay` after a reboot shows every service `Up`. |
| **A Windows update reboots the PC mid-party** | Set active hours, or pause updates for the day: Settings → Windows Update → Advanced → Active hours. | Not verifiable in advance. Check before an event. |
| **The backup task does not run because nobody is signed in** | `backup-task.ps1 register` already registers it as SYSTEM with `-StartWhenAvailable`. Use it; do not build a task that runs "only when the user is logged on". | `backup-task.ps1 status`, then `backup-task.ps1 verify -BackupRoot <path>` the next morning. Exit 0 means restorable. |
| **The disk fills** | Every container now caps its JSON log at 20 MB × 5 files. The uncapped growth is object storage — photographs. | `docker system df` and free space on the Docker data drive. Alert below 20%. |

### Getting back to "the site serves" fastest

In order. Stop at the first one that works.

1. `deploy.ps1 status -Relay` — is anything not `Up`?
2. `deploy.ps1 logs -Service api -Relay` (then `worker`, `relay`) — read the
   first error, not the last.
3. `deploy.ps1 up -Relay` — recreates whatever drifted.
4. `deploy.ps1 down -Relay` then `up -Relay` — volumes survive.
5. Restart Docker Desktop, then step 3.
6. Reboot the PC, then wait three minutes and check `/api/healthz`.
7. Roll the code back (above).
8. Restore from the last verified snapshot ([`restore.md`](restore.md)).

Steps 1–6 cannot lose data. Step 7 can, through the schema. Step 8 loses
everything since the snapshot, by definition.

**While the site is down, photography is not.** The shutter works, the capture
is on the SD card with its UUID and Roll, the camera's queue waits, and the
uploads resume by themselves when the stack returns — measured on the bench on
2026-09-05 with a 40-capture outage and a 105-capture backlog. Do not stop a
party to fix a deployment.

## Pre-deployment gate list

Walk in order. Every row is a check with a yes/no answer. A `no` stops the
deploy at that row — do not proceed and revisit.

### A. Before spending money

| # | Gate | How | Pass |
|---|---|---|---|
| A1 | Router WAN address read from its status page | Log into `10.20.99.1` | Recorded, and matched against the table at the top of this document |
| A2 | The decision is understood | This document | Relay chosen, DNS stays at Websupport, no router change |

### B. Provisioned

| # | Gate | How | Pass |
|---|---|---|---|
| B1 | VPS exists with a static IPv4 | provider console | Address written down |
| B2 | VPS firewall | `sudo ufw status numbered` | 80, 443, 7000, SSH. Nothing else |
| B3 | `RELAY_TOKEN` generated once | `openssl rand -hex 32` | Identical in `infra/relay/vps/.env` and `infra/.env.production` |
| B4 | Websupport | DNS editor | One `A` `kino` → VPS. Parking `A` and `AAAA` removed. Nameservers untouched |
| B5 | DNS is live | `Resolve-DnsName kino.acronym.sk -Server 1.1.1.1` | `A` = VPS, no `AAAA` |

### C. VPS half

| # | Gate | How | Pass |
|---|---|---|---|
| C1 | Compose interpolates | `sudo docker compose config --quiet` | exit 0 |
| C2 | Both containers up | `sudo docker compose ps` | `caddy`, `frps` running |
| C3 | Certificate issued | `sudo docker compose logs caddy` | `certificate obtained successfully` for `kino.acronym.sk` |
| C4 | TLS answers | `https://kino.acronym.sk/` from a phone | Valid padlock, **502** body |

### D. PC half

| # | Gate | How | Pass |
|---|---|---|---|
| D1 | Docker engine reachable | `docker version` | Server version prints |
| D2 | No placeholders left | `deploy.ps1 check -Relay` | No `change-me`; `config --quiet` passes; prints `Shape: production + relay overlay` |
| D3 | Canonical URLs | `infra/.env.production` | `KINO_SITE_ADDRESS=kino.acronym.sk`, `PUBLIC_BASE_URL=https://kino.acronym.sk` |
| D4 | `RELAY_HOST` / `RELAY_TOKEN` | `infra/.env.production` | VPS address; token identical to the VPS's |
| D5 | Nothing but the edge publishes a port | `docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml -f infra/relay/docker-compose.relay.yml config \| Select-String published` | **No output.** Zero published ports in the relay shape |
| D6 | Stack healthy | `deploy.ps1 up -Relay` | `api healthy`, `web healthy` |
| D7 | Tunnel connected | the frpc log `up -Relay` prints | `login to server success` |
| D8 | Migrations ran before the app | `deploy.ps1 logs -Service migrate -Relay` | `[migrate] database is current`, container `Exited (0)` |
| D9 | Buckets exist | `deploy.ps1 logs -Service createbucket -Relay` | Exited 0; `storage` true in healthz |
| D10 | Volumes exist | `docker volume ls` | `kino-production_pgdata`, `_miniodata`, `_redisdata`, `_caddy_data` |
| D11 | PC publishes nothing | `netstat -ano \| findstr ":443 "` | Only Apache's PID. No Docker listener |

### E. Through the canonical URL, from mobile data

| # | Gate | How | Pass |
|---|---|---|---|
| E1 | Health | `curl -s https://kino.acronym.sk/api/healthz` | `{"ok":true,"db":true,"redis":true,"storage":true}` |
| E2 | PWA | `https://kino.acronym.sk/` | Roll app |
| E3 | Studio | `https://kino.acronym.sk/studio/` | Studio |
| E4 | HTTP redirects | `curl -sI http://kino.acronym.sk/` | 308 → https |
| E5 | Client address | `api` log for that request | The phone's public address, not `10.x`/`172.x` |
| E6 | Live feed | upload one capture, watch a roll page | Tile appears without reload |
| E7 | Buckets are private | `mc anonymous get local/kino-media` inside the stack | No anonymous policy |
| E8 | Camera points at production | Studio `GET_CONFIG network.apiBase` | `https://kino.acronym.sk` |

### F. Not finished until these pass

| # | Gate | How | Pass |
|---|---|---|---|
| F1 | Sleep disabled | `powercfg /query SCHEME_CURRENT SUB_SLEEP` | AC standby index 0 |
| F2 | Survives a reboot unattended | Reboot, touch nothing, wait 3 min | `/api/healthz` answers from mobile data |
| F3 | Backup registered | `backup-task.ps1 register -BackupRoot <off-PC path>` then `status` | Task `Ready`, next run set |
| F4 | Backup produced a real snapshot | `backup-task.ps1 verify -BackupRoot <path>` | Exit 0: fresh, non-empty `postgres.dump`, non-empty object mirror, `SHA256SUMS` present |
| F5 | Restore proven once | `infra/scripts/restore-drill.sh` against that snapshot; record it in [`restore.md`](restore.md) | Drill passes and is logged |
| F6 | Camera registered | Studio over USB-C with `PROVISIONING_TOKEN` | Once per serial; production is first-write-wins |

### F1 and F2 do not apply to an on-demand deployment

The deployment model changed after this list was written. Production is now
**on-demand event hosting**: the stack runs on event days and long enough
afterwards for the upload queue to drain and one backup to finish, then the PC
may sleep or be shut down. It is not a 24/7 service.

So, for this stage:

- **F1 (sleep permanently disabled)** becomes a per-event toggle with the
  previous value read first and restored afterwards.
  [`event-day.md` §4](event-day.md) has the exact commands.
- **F2 (survives a reboot unattended)** is not required. Nobody needs the site
  at four in the morning, and a rebooted PC has no Docker engine until somebody
  signs in anyway.
- F3, F4, F5 and F6 stand unchanged, and F4 gains a per-event sibling:
  `deploy.ps1 event-backup -Roll <slug> -BackupRoot <path>`.

The twelve pre-event checks that replace F1 and F2, the during-event failure
model, and the drain gate are in [`event-day.md`](event-day.md). F1 and F2 come
back as requirements when the origin moves to a dedicated always-on machine:
[`origin-machine-move.md`](origin-machine-move.md).

### The answer

**Can `https://kino.acronym.sk` be served?**

- **Yes** — if and only if every row in B through E passes. F is what makes it
  a deployment rather than a demonstration: until F4 and F5 pass there is a
  stack and no recovery point, and until F2 passes the site dies at the next
  reboot.
- **No, and it cannot be made to** without either the relay or a DNS move, if
  A1 comes back `10.x` / `100.64–127.x` and the relay is refused. There is no
  third option that keeps DNS at Websupport and the router untouched.
- **Not yet** if A1 comes back `46.34.228.61`. The direct path then exists, but
  it needs Apache off 80/443, a router forwarding rule, and a dynamic-DNS
  updater against the Websupport API. The relay is still the shorter and more
  reversible path, and it is the one this document describes.

### When the stack later moves onto the VPS

Not deployment day, but decide it now so nothing is built that blocks it: back
up both stores with `backup.sh`, restore them on the VPS with
`restore-drill.sh`'s procedure, run the same production compose there **without**
the relay overlay, and point the VPS Caddy at the local stack. Switch the relay
off. The `A` record, the Roll codes, the PWA URL, the schema, the object keys
and the camera's `network.apiBase` do not change — which is the whole reason the
canonical URL was never a LAN address.
