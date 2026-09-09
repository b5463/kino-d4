# Public ingress options for kino.acronym.sk

> ## Standing decision, 2026-09-09
>
> | | |
> |---|---|
> | **SELECTED** | **None** — awaiting O2's answer on a public dynamic IPv4 |
> | **CURRENT BLOCKER** | O2 CGNAT on the operator's fixed-broadband line, and no globally routable IPv6 |
> | **PREFERRED IF AVAILABLE** | Direct IPv4 hosting from the operator's PC + Websupport DynDNS. **Conditional, not selected.** |
> | **FALLBACK** | Self-controlled relay VPS (`infra/relay/`) — technically valid |
> | **EVALUATED / NOT CURRENTLY SELECTED** | Pinggy Pro; Cloudflare Tunnel; Cloudflare for SaaS with a second domain; ngrok; Tailscale Funnel; direct forwarding while behind CGNAT |
>
> ### The one open external question
>
> > **Can O2 remove THIS fixed-broadband line from CGNAT and assign a public
> > dynamic IPv4 address?**
>
> Nothing else about ingress is undecided. That question needs an authoritative
> answer from O2 support and cannot be settled from this repository. The
> evidence that it is the only question left is in
> [The network constraint, confirmed](#the-network-constraint-confirmed--2026-09-09):
> O2's own RIPE registration names the egress block
> `O2SK-CGNAT-POOL-FBB`.
>
> ### If O2 says yes
>
> The preferred architecture becomes
>
> ```
> kino.acronym.sk → Websupport DNS / DynDNS → public dynamic IPv4
>                → router → Windows PC → KINO Roll
> ```
>
> because everything stays on the operator's PC — photographs included — with
> no tunnel provider, no VPS, no second domain, no DNS migration, no CDN and no
> recurring ingress cost. Websupport stays authoritative, and DynDNS handles a
> changing address.
>
> **This is not marked SELECTED, and must not be, until O2 confirms.** It is
> the preferred path *if* a public dynamic IPv4 is available. Note also that
> DynDNS is what solves an address that CHANGES; it is not, and can never be, a
> way around CGNAT.
>
> ### If O2 says no
>
> Direct PC hosting is permanently closed on this connection, and the ingress
> alternatives below may be reconsidered — **by operator decision.** This
> document does not pre-select one for that case.
>
> ### Status of each option
>
> **Pinggy Pro — EVALUATED, TECHNICALLY VIABLE, NOT CURRENTLY SELECTED.** This
> supersedes its selection of 2026-09-08. It is explicitly **not** technically
> rejected, and the evidence stands: it traversed the carrier NAT, its SSE
> streaming passed empirically at two pacings with a real phone on cellular,
> its persistent custom-domain architecture was feasible, and the Pro pricing
> and custom-domain research was completed (about USD 3 a month for one seat,
> no published transfer quota). It is not selected because the operator asked
> for a free or self-hosted path to be tried first, because the privacy and
> data-processing position was never resolved — Pinggy can inspect HTTP tunnel
> traffic through its web debugger, its terms take broad rights over submitted
> content, no DPA or standard contractual clauses were identified, and
> processing sits under Indian jurisdiction — and because no purchase was ever
> authorised. Detail in [pinggy-plan-facts.md](pinggy-plan-facts.md).
>
> **Cloudflare Tunnel — EVALUATED, NOT SELECTED.** The Free-plan CDN terms are
> an uncomfortable fit for a product whose guest traffic is overwhelmingly
> photographs, while the specified architecture keeps photographs on the PC and
> excludes the paid Cloudflare storage mitigation that the terms point at. Not
> reopened here.
>
> **Relay VPS — FALLBACK, TECHNICALLY VALID.** Fully prepared, and the privacy
> and control answer precisely because raw relay infrastructure carries no
> third-party HTTP tunnel provider that can read application payloads. It
> remains available if O2 refuses a public IPv4, if the operator later wants
> maximum infrastructure control, or if third-party tunnel privacy and terms
> stay unacceptable. **Not selected.** Its procedure stays live in
> [production-relay-deploy.md](production-relay-deploy.md).
>
> **Cloudflare for SaaS with a second domain, ngrok, Tailscale Funnel, and
> direct forwarding while behind CGNAT — EVALUATED, NOT SELECTED.** The last of
> those is not a preference but a measurement: while this line is behind CGNAT,
> forwarding cannot work at all.
>
> ### A separate implementation issue, not an ingress blocker
>
> Ports 80 and 443 on the operator's PC are already held by Bitnami's Apache
> (`httpd.exe`, service `wordpressApache-1`, start mode Automatic). If direct
> public hosting ever becomes viable, KINO's Caddy cannot simply bind to host
> 80/443 until that conflict is deliberately resolved — by moving or
> reconfiguring Apache, by reverse-proxying KINO through the existing front
> end, by different local ports with a router mapping, or by some other
> arrangement chosen on purpose.
>
> **No solution is chosen here, and none should be implemented yet.** This is
> subordinate to the CGNAT question: there is no reason to touch a working
> WordPress installation until O2 confirms that a public IPv4 path exists at
> all.
>
> ### What this document is now
>
> It is the comparison that produced the shortlist, kept as the record of why
> each option was ranked where it was. Two earlier recommendations are
> **superseded** and deliberately left in place below rather than rewritten, so
> the reasoning can be audited: the 2026-09-07 recommendation of the relay VPS,
> and the 2026-09-08 selection of Pinggy Pro. Read each as the case its author
> made on the evidence available at the time. Pinggy was not viable on
> 2026-09-07 because its streaming behaviour was unknown, and measurement
> settled that; the relay's case still holds as the fallback's case.

An assessment, not a deployment. Nothing in this document has been done. No DNS
record was changed, no router setting was touched, no account was created, no
tunnel client was run. The last section is the only place with instructions in
it, and it is fenced off with a warning.

Written 2026-09-07. Every price is list price on that date, in the currency the
vendor quotes it in. Prices and free tiers move; re-read the vendor page before
paying anything.

Companion documents: [`infra/README.md`](../../infra/README.md) for what the
compose files contain, [`production-relay-deploy.md`](production-relay-deploy.md)
for the day the relay path is actually executed.

## The problem in one paragraph

The stack runs on a Windows PC on a domestic O2 Slovakia line. It egresses as
`46.34.228.61`, but `tracert` shows the operator's own router at hop 1
(`10.20.99.1`) and then two carrier-side private addresses beyond it
(`10.106.16.198`, `10.109.122.193`) before the first public hop
(`90.176.30.41`). That is carrier NAT: the public address is the carrier's and
is shared, so an inbound TCP connection to 443 has no forwarding rule to
arrive through and no interface the operator can configure. The PC has no
global IPv6, so an `AAAA` record to it is impossible for a second, independent
reason. Ports 80 and 443 on the PC are held anyway, by `httpd.exe` (PID 8088)
from `C:\Bitnami\wordpress-6.0.3-0\apache2\bin\`, service `wordpressApache-1`,
start mode Automatic. Therefore every viable option is an **outbound**
connection from the PC to something with a public address.

The hostname is fixed at `https://kino.acronym.sk` forever — it is compiled
into camera firmware (`-DKINO_ROLL_API_BASE`), stored in each camera's
`network.apiBase`, and is the PWA's same-origin API. The zone `acronym.sk`
stays on Websupport (`ns1`, `ns2`, `ns3.websupport.sk`, confirmed by
`Resolve-DnsName` on 2026-09-07). Today `kino.acronym.sk` answers
`37.9.175.156` and `2a00:4b40:aaaa:2004::7`, both TTL 600 — Websupport
parking.

## The network constraint, confirmed — 2026-09-09

The paragraph above was written from a traceroute and was right. This section
is the proof, gathered because "CGNAT confirmed" had been asserted rather than
evidenced, and an architecture was being chosen on top of it.

**Verdict: direct PC hosting is blocked by O2 CGNAT.**

### Evidence

| Observation | Value |
|---|---|
| ISP | O2 Slovakia, AS28952 |
| Connection | fixed broadband — O2's own registration says `FBB`, so this is not read off the ASN |
| Public IPv4 seen from outside | `46.34.228.61`, agreed by ipify, icanhazip and ifconfig.co |
| Local gateway | `10.20.99.1` (Ubiquiti, nginx on 80/443/8080) |
| Upstream provider hop | `10.106.16.198` — RFC1918 |
| Further provider hop | `10.109.122.193` — RFC1918 |
| First public routed hop | `90.176.30.41` (O2) |
| Router holds the public IPv4 | **No** |
| Global IPv6 | none on the host; no IPv6 default route and no delegated prefix |

The traceroute was run twice, to `1.1.1.1` and to `8.8.8.8`, and gave the same
five hops. **Three private hops stand between this PC and the first public
address.** Even with full administrative control of the Ubiquiti gateway, a
port-forward there terminates inside `10.106/10.109` space. No device the
operator can reach holds `46.34.228.61`.

### The decisive record

O2's own RIPE registration for the address this line egresses as:

```
netname:  O2SK-CGNAT-POOL-FBB
status:   ASSIGNED PA
org:      O2.SK
```

The ISP names the block a **CGNAT pool for fixed broadband**. That is
documentation from the party that operates it, not an inference from hop
shapes, and it is why this section says *confirmed* rather than *consistent
with*.

### Inbound probe

A temporary HTTP listener was bound to `0.0.0.0:58080`, verified answering on
loopback and on the LAN address, and then addressed from outside:

- four external nodes (AT, TR, UA, US) — **all "Connection timed out"**
- the listener logged **no inbound connection at all**, only the two local hits
- external ICMP to the same address from three further nodes (FR, IR, SI) —
  all timed out

The listener was stopped, the port released and the script deleted.

**Caveat, stated because it matters:** Windows Firewall blocks inbound on all
three profiles and had no rule admitting that port, and the session was not
elevated, so no temporary allow rule could be added. **The probe is therefore
supporting evidence, not proof.** It cannot distinguish a packet dropped by the
carrier from one dropped at the host.

It does not need to. The firewall explains neither the three private hops nor
`O2SK-CGNAT-POOL-FBB`, and those two are what carry the verdict.

### What O2 publishes

**Public static IPv4 — NOT AVAILABLE.** From O2's own product page, verbatim:

> "Služba 'Verejná statická IP adresa' nie je dostupná pre O2 Internet optikou
> ani O2 Internet vzduchom."

*(The 'Public static IP address' service is not available for O2 Internet over
fibre, nor for O2 Internet wireless.)*

**Public dynamic IPv4 / CGNAT opt-out — UNKNOWN.** O2 publishes nothing either
way. Recorded as unknown rather than unavailable: absence from a marketing page
is not a refusal, and business tariffs may differ. Only O2 can answer it.

### Websupport, and what DynDNS is not

- An explicit `A kino.acronym.sk` record **is possible**, and would override the
  wildcard without touching the root, `www`, mail, MX, SPF, DKIM or the
  wildcard itself.
- `kino.acronym.sk` has **no record of its own today** — it resolves only
  because `*.acronym.sk` catches it. See
  [`acronym-sk-dns-premigration.md`](acronym-sk-dns-premigration.md).
- Websupport runs an official **DynDNS2** service, so ddclient and most routers
  can drive it. Credentials come from the panel under *Zabezpečenie a
  prihlásenie* → *API autentifikácia*, generated with the DynDNS option.

**DynDNS is not a solution to CGNAT, and must never be written up as one.** It
solves exactly one problem: a public address that *changes*. It cannot conjure
a public address that does not exist, and it cannot create an inbound path.
Behind carrier NAT a DynDNS updater would faithfully publish `46.34.228.61` —
an address shared with other O2 subscribers, on which nothing routes to this
PC. It becomes useful the moment a real public IPv4 exists, and not one moment
before.

### Architecture consequence

The ordinary shape

```
kino.acronym.sk → public IPv4 → router port forward → Windows PC
```

**cannot work on this connection.** Not because of a setting, a firewall rule
or a DNS record, but because the public address belongs to the carrier and is
shared. There is nothing to forward from and no interface to configure.

A second, independent obstacle would remain even on a public line, and is
recorded so it is not rediscovered: ports 80 and 443 on this PC are already
held by Bitnami's Apache (`httpd.exe`, service `wordpressApache-1`, start mode
Automatic). That one is merely a conflict to resolve; CGNAT is not.

### The one open external question

> **Can O2 remove this fixed-broadband line from CGNAT and assign a public
> dynamic IPv4?**

That is the only unresolved question in this section, and it cannot be answered
from here — it needs O2 directly. Everything else above is settled.

Nothing in this section selects, re-opens or rules out any ingress option. It
records what the connection is.

## What every option is scored against

| Requirement | What passing means |
|---|---|
| **Custom hostname** | The public name is literally `kino.acronym.sk`. Not a redirect, not a frame, not a vendor subdomain. |
| **Websupport stays authoritative** | `acronym.sk` NS records remain `ns1/2/3.websupport.sk`. Only records *inside* the zone change. |
| **HTTPS** | A publicly trusted certificate for `kino.acronym.sk`, renewed without a human. |
| **SSE intact** | `text/event-stream` is neither buffered nor compressed anywhere in the path. The guest feed (`GET /api/rolls/:slug/events`) and the host feed (`/api/host/rolls/:id/events`) send `retry: 3000`, an `id:` on every event, a `: heartbeat` comment every 25 s (`SSE_HEARTBEAT_MS = 25_000`), `cache-control: no-cache, no-store, no-transform` and `x-accel-buffering: no`. An ingress that batches events is a broken product, not a slow one. |
| **Private services stay private** | Postgres, Redis, MinIO, the API and the worker are reachable only on the Compose network. Nothing but the site is exposed. |
| **On-demand** | The origin runs on event days only. Either the ingress can be stopped and started, or it costs nothing while idle. |
| **Exit cost** | What it takes to stop using it, including whether anyone else's cooperation is needed. |

## Comparison

`kino` = `kino.acronym.sk`. Prices are 2026-09-07 list price.

| Option | Custom hostname | Websupport authoritative | HTTPS | SSE intact | Private services | On-demand | Cost / month | Exit cost |
|---|---|---|---|---|---|---|---|---|
| **A. Relay VPS, repo's frp + Caddy** (`infra/relay/`) | Yes — one `A` record at Websupport | Yes | Yes, Caddy ACME on the VPS | **Yes, by construction** — frp carries raw TCP, and all three Caddyfiles omit `text/event-stream` from `encode` and set `flush_interval -1` | Yes — with the relay overlay the PC publishes **zero** host ports; `frps` binds the tunnelled port on `127.0.0.1` only | Partly. Stack starts/stops freely; the VPS should stay up to hold the address and the certificate. ~€4.49–5.00/mo runs whether or not there is an event | Hetzner CX22 class: **€4.49/mo** per third-party trackers after the April 2026 increase (Hetzner's own launch page still lists €3.79); 20 TB traffic, 1 IPv4 included. Hourly billing, invoice is the lower of hourly and monthly | Delete the server, delete the Primary IP with it (an orphaned Primary IPv4 keeps billing at **€0.50/mo**), point the `A` record elsewhere. No vendor lock, no account to argue with |
| **B. Cloudflare Tunnel, full setup** | Yes | **No — disqualified.** Full setup means Cloudflare's nameservers are authoritative for `acronym.sk` | Yes | See D | Yes — `cloudflared` dials out | Yes, tunnel is free and idle-free | $0 | Move the zone back |
| **C. Cloudflare Tunnel over a partial (CNAME) zone** | Yes | **Yes** — partial setup is exactly "Cloudflare proxy, your DNS provider stays authoritative" | Yes | See D | Yes | Yes | **Disqualified on price: partial (CNAME) setup is Business or Enterprise only. Business is $250/mo per zone monthly, $200/mo billed annually** | Cancel the plan |
| **D. Cloudflare Tunnel behind a Cloudflare for SaaS custom hostname** | Yes — `kino` is added as a *custom hostname* on a **second** domain the operator puts on Cloudflare; `acronym.sk` never moves | **Yes** | Yes, Cloudflare issues and renews the custom-hostname certificate | **Unproven, and the risk is real.** Cloudflare documents a 125 s proxy read timeout (Enterprise-only to change) — fine against a 25 s heartbeat — and a **400 s client keep-alive after which the TCP connection is closed**, so every feed reconnects roughly every 6.7 minutes (lossless here: `Last-Event-ID` replays the gap). The unresolved part is buffering: there are 2026 community reports of Cloudflare holding `text/event-stream` until ~100 KB accumulates, and `response_buffering` is not a free-plan control. Must be measured before an event | Yes — `cloudflared` dials out, nothing on the PC listens | **$0/mo**: Cloudflare Tunnel is free, and Free/Pro/Business plans each include **100 custom hostnames**, $0.10/mo per hostname beyond that. Plus a second domain to own, roughly **€10–15/year** | Free to leave, but it is a bigger unwind: a Cloudflare account, a second zone, a SaaS configuration, and validation records at Websupport |
| **E. ngrok, Pay-as-you-go** | Yes, subdomain custom domains via CNAME. Apex is not supported on any plan — irrelevant, `kino` is a subdomain | Yes, CNAME at Websupport | Yes | **Doubtful.** Third-party reports describe ngrok buffering whole responses and a 30–60 s request-forwarding timeout. ngrok publishes no SSE guarantee I could find | Yes | Yes — stop the agent, but the subscription bills anyway | Custom domains start at the **Pay-as-you-go plan, $20/mo** including $20 of usage and 5 GB transfer, then **$0.10/GB**. A party that serves 100 GB of photographs is $20 + ~$9.50 | Cancel; DNS points elsewhere |
| **F. Pinggy Pro / LocalXpose** | Yes, custom domains on the paid tier | Yes, CNAME | Yes | Not documented either way. Not verified | Yes | Yes, subscription bills anyway | Pinggy Pro **≈$3/mo**, LocalXpose **≈$5–8/mo** — both from third-party pricing pages, **not confirmed on the vendors' own pages** | Cancel |
| **G. Tailscale Funnel** | **No — disqualified.** Funnel serves only names in the tailnet's `*.ts.net` domain; the certificate is valid only for `*.ts.net`, and a CNAME from a custom name fails the handshake. Open feature request, no ship date | n/a | n/a | n/a | n/a | n/a | Free tier exists | n/a |
| **H. Self-hosted alternatives on a VPS** — Pangolin (Traefik + Newt/WireGuard), rathole, sish, zrok, or plain WireGuard + Caddy | Yes | Yes | Yes, ACME on the VPS | Yes, same reasoning as A when the edge is configured as this repo already configures Caddy | Yes | Same as A | Same VPS bill as A. **No cost advantage and more software to own** — Pangolin adds Traefik, a database and an auth layer this product does not need, and its route config is not the Caddyfile the repo has already gated for SSE | Same as A |
| **I. Direct router port-forward to the PC** | Yes | Yes | Yes | Yes | Yes | Yes | €0 | **Not viable.** Carrier NAT, no IPv6, and Apache holds 80/443 so `docker compose up` would fail on port allocation |

### Note on the VPS host, and on "free"

Option A does not require Hetzner. Any provider with a static IPv4 works; the
repo's relay is two containers and no data. Two variants worth naming:

- **Oracle Cloud Always Free** would make option A cost €0/mo with a static
  public IPv4. Against it: Oracle documents that it **may stop or reclaim idle
  Always Free instances** — under 10% CPU *and* under 10% network over a
  7-day period — which describes a relay that is idle between events precisely.
  Oracle also halved the Always Free Arm allowance in June 2026 (4 OCPU/24 GB
  to 2 OCPU/12 GB) and Ampere capacity is regionally unavailable at times. A
  free machine that may be stopped between events is the wrong machine to hang
  a permanent hostname on.
- **Destroying the VPS between events** to save money does not work cleanly.
  Hetzner bills hourly, but the public address is the thing the DNS record
  names: keeping the Primary IPv4 while the server is gone still costs
  €0.50/mo, and releasing it means a new `A` record and a fresh ACME issuance
  every event. €4.49/mo of continuous uptime buys a stable address, a warm
  certificate, and one fewer thing to get wrong on an event morning.

### The Cloudflare finding, stated plainly

`infra/README.md` and `production-relay-deploy.md` currently say Cloudflare
Tunnel is unavailable for this hostname because Websupport is authoritative.
That is true only of the **full setup**. Two mechanisms let Cloudflare serve
`kino.acronym.sk` while `acronym.sk` stays on Websupport:

1. **Partial (CNAME) setup** — Cloudflare's documented availability table is
   Free: no, Pro: no, Business: yes, Enterprise: yes. At $250/mo it is not a
   candidate for this product, but the repo's claim should not be read as "it
   is technically impossible".
2. **Cloudflare for SaaS** — the mechanism built for serving *someone else's*
   domain. The operator's own `acronym.sk` is the "customer" domain. It needs a
   second domain on Cloudflare to act as the platform zone, and 100 custom
   hostnames are included at no charge on the Free plan.

Neither changes the recommendation, and the reason is SSE, not price.

## Recommendation

**First choice: option A, the relay VPS already implemented at
`infra/relay/`.**

The reasoning, in order of weight:

1. **SSE is safe by construction, not by vendor behaviour.** frp forwards raw
   TCP; it has no concept of a content type and nothing to buffer. The only
   HTTP-aware hop is Caddy, and both Caddy hops in this repo already carry
   `flush_interval -1` plus an explicit eight-entry `encode` allow list that
   omits `text/event-stream` — verified by adapting each Caddyfile with the
   pinned `caddy:2.10.2-alpine` image. Every hosted ingress puts an HTTP proxy
   the operator does not control in front of the product's headline feature.
   That is the whole decision.
2. **It is written, reviewed and gated.** `deploy.ps1 -Relay`,
   `infra/relay/`, the VPS compose, the pre-deploy checklist and a
   step-by-step deployment runbook exist. Nothing has to be invented.
3. **Nothing on the PC listens on the internet.** With the relay overlay the
   stack publishes zero host ports — the checklist proves it by grepping the
   *rendered* compose config, not the source. `frps` binds the tunnelled port
   on `127.0.0.1`, so the PC's Caddy is unreachable except through the VPS
   Caddy. Postgres, Redis and MinIO never leave the Compose network.
4. **Apache keeps 80 and 443.** No service has to be evicted.
5. **It is the machine the stack moves to later.** When the origin stops being
   a personal PC, the relay is switched off and the VPS Caddy points at a local
   stack. The DNS record, the URL, the camera firmware and the Roll codes do
   not change. No other option ends in a machine you already own.
6. **Exit is a DNS edit and a delete button.** No account holds the hostname.

Its honest cost: about €4.49–5.00/month that runs on non-event days, and one
more machine to patch.

**Second choice: option D, Cloudflare Tunnel behind a Cloudflare for SaaS
custom hostname.** Zero monthly cost, nothing on the PC listening, and the
zone stays at Websupport. It is second, not first, for three reasons: the SSE
buffering behaviour is unresolved and would have to be measured with a real
25-second-heartbeat stream through a real custom hostname before an event; it
needs a second domain and a Cloudflare account that then own the product's
front door; and the 400 s client keep-alive means the feed reconnects every
~6.7 minutes forever, which this app survives (`retry: 3000` plus
`Last-Event-ID` gap replay) but which is a permanent small tax the relay does
not charge.

### What would change this answer

- **The router's WAN status page shows `46.34.228.61`.** Then the line is not
  behind CGNAT, and a direct path exists. It is still worse — a residential
  address is dynamic, so a Websupport-API updater becomes necessary, and
  `wordpressApache-1` has to be stopped and disabled. It becomes a fallback
  that exists, not the recommendation.
- **A measured Cloudflare run shows `text/event-stream` passing through
  unbuffered**, event by event, over a custom hostname on a free plan, for the
  length of a party. Then option D's zero monthly cost becomes hard to argue
  with and it moves to first.
- **Event traffic turns out to be large.** 20 TB on the Hetzner plan is not a
  constraint; ngrok at $0.10/GB after 5 GB is. This kills E, not A.
- **The operator changes the DNS decision.** If `acronym.sk` could move to
  Cloudflare, option B is free, needs no second domain, and the whole
  comparison collapses to "is Cloudflare's SSE behaviour good enough".
- **Someone needs the origin reachable while the PC is off.** No ingress fixes
  that. It is a hosting change.

## The DNS change — for the recommended option only

> **DO NOT DO THIS YET.** This is written out so that, if and when the
> operator chooses option A, it can be followed without interpretation. It must
> not be executed before that decision, and not before a VPS exists and its
> relay is answering. Changing the record early takes `kino.acronym.sk` down
> and leaves it down.

Preconditions, all of them, before touching DNS:

1. A VPS exists with a static IPv4. Write the address down; call it
   `<VPS-IPV4>`. If it also has a static IPv6, write that down as
   `<VPS-IPV6>`.
2. `infra/relay/vps/` is running there: `docker compose up -d` with `.env`
   holding `RELAY_TOKEN` and `KINO_SITE_ADDRESS=kino.acronym.sk`. Firewall open
   on 80, 443 and 7000 only.
3. The PC is running the relay deployment: `deploy.ps1 up -Relay`, and the
   `relay` container's log shows the `kino-web` proxy started.
4. `curl -H 'Host: kino.acronym.sk' http://<VPS-IPV4>/api/healthz` from
   anywhere returns `ok`. The path works before DNS knows about it.

Then, at Websupport: log in to webadmin, open `acronym.sk` in the services
list, choose **DNS** in the left menu.

**Add** — on the **A** tab:

| Field | Value |
|---|---|
| Name / subdomain | `kino` |
| Type | `A` |
| Value / IP address | `<VPS-IPV4>` |
| TTL | `600` |

**Remove** — the two records that currently point at Websupport parking, and
nothing else:

| Tab | Name | Type | Current value | Action |
|---|---|---|---|---|
| A | `kino` | `A` | `37.9.175.156` | delete |
| AAAA | `kino` | `AAAA` | `2a00:4b40:aaaa:2004::7` | delete, **unless** the VPS has a static IPv6, in which case change the value to `<VPS-IPV6>` instead |

The `AAAA` record is not optional housekeeping. A dual-stack phone prefers
IPv6; if `kino.acronym.sk` still has an `AAAA` pointing at parking, that phone
reaches parking and the operator sees an intermittent, device-dependent
outage that looks like a broken stack.

**Do not touch anything else in the zone.** Leave the `acronym.sk` apex, `www`,
every `MX`, every `TXT`, and the `NS` records exactly as they are. Websupport
stays authoritative — this is a record edit inside the zone, not a delegation
change.

After saving:

1. Wait for the old TTL to expire. It is 600 s today, so roughly ten minutes;
   Websupport's own guidance says a change can take up to 24 hours to reach
   every resolver.
2. Check propagation: `Resolve-DnsName kino.acronym.sk -Type A -Server 8.8.8.8`
   returns `<VPS-IPV4>` and the `AAAA` query returns either nothing or
   `<VPS-IPV6>`.
3. Only now does Caddy on the VPS obtain the certificate — ACME HTTP-01 needs
   the name to already resolve to it. Watch the VPS Caddy log for the issuance
   and expect it within a minute or two of propagation.
4. Verify from a phone on mobile data, off the LAN: `https://kino.acronym.sk/`
   is the Roll PWA, `/studio/` is Studio, `/api/healthz` is 200 with `db`,
   `redis` and `storage` all true, and the certificate names
   `kino.acronym.sk`.
5. On the PC, `netstat -an | findstr :443` must **not** show the Docker stack.
   Apache on 0.0.0.0:443 is expected and correct; it is not serving KINO.

## Event-day failure modes, and how to tell them from a dead stack

The general test, before any option-specific one. From a phone on mobile data:

```
https://kino.acronym.sk/api/healthz
```

- **TLS fails, or nothing connects at all** → the ingress edge is gone. Not
  the stack.
- **TLS succeeds and something answers with an error** → the edge is alive and
  cannot reach the origin. Ingress-to-PC link, or the PC.
- **200 with one of `db`, `redis`, `storage` false** → the stack. The ingress
  is doing its job; a container is not.
- **200, everything true, but the gallery does not update** → the *feed*, not
  the stack. That is the SSE-specific ladder below.

### Option A — relay VPS

| Failure | What the operator sees | How it is distinguishable |
|---|---|---|
| `frpc` on the PC is down, or `RELAY_TOKEN` mismatched | Valid certificate, then **502 on every path**, `/api/healthz` included | A valid TLS handshake proves the VPS is up; a 502 on *every* path including the static PWA proves the tunnel, not the app — the PC's Caddy serves `/` from a container that does not depend on the API. `docker logs frps` on the VPS shows no client; `docker logs <project>-relay-1` on the PC shows the dial failing |
| Relay overlay forgotten (`deploy.ps1 up` without `-Relay`) | `docker compose up` **fails on port allocation** against Apache's 80/443, so nothing starts | The stack never comes up, and the error names the port. `deploy.ps1 check` warns about this before it happens |
| VPS rebooted, out of disk, or the provider suspended it | **Connection refused or timeout, no TLS at all** | No handshake means no Caddy. Nothing on the PC can produce that symptom, because nothing on the PC is addressable |
| Certificate renewal failed (port 80 closed on the VPS, or ACME rate limit) | Browser TLS warning; the PWA will not load at all and service-worker updates fail silently | It is a certificate error, not an HTTP status. The VPS Caddy log names the ACME failure. Renewal happens ~30 days before expiry, so this is a slow failure with warning, not an event-day surprise — unless the firewall was changed |
| Domestic uplink saturated by upstream photographs | Site loads, feed and thumbnails crawl | `/api/healthz` still 200 and fast; it is a bandwidth symptom. The cameras' queues drain on their own afterwards |
| VPS traffic allowance exceeded | Provider-specific: throttle or bill | Watch the provider console, not the app. 20 TB is not a realistic party |

### Option D — Cloudflare Tunnel behind a custom hostname

| Failure | What the operator sees | How it is distinguishable |
|---|---|---|
| `cloudflared` is down | **Cloudflare-branded error 1033** ("tunnel not found") or 502 with the orange interstitial | The error page is *Cloudflare's*, with a Ray ID. A dead stack behind a live tunnel gives a plain 502 from the origin instead. That branding is the tell |
| Custom-hostname certificate not `active` | TLS failure on `kino.acronym.sk` while the platform zone's own hostname works fine | Test the Cloudflare-zone hostname directly. If it serves and `kino` does not, it is the custom hostname's certificate or validation record, not the tunnel |
| **SSE batched by the edge** | The stack is healthy, capture pages load, and the live feed sits still for a minute and then jumps several photographs at once | This is the dangerous one, because it looks like a slow party. Distinguish it: open the same Roll on the LAN, straight at the PC's Caddy. If the LAN feed updates event-by-event and the public one arrives in bursts, the edge is buffering and no amount of restarting the stack will help |
| 400 s client keep-alive | The browser reconnects the EventSource roughly every 6.7 minutes | Visible in devtools as a periodic reconnect with a `Last-Event-ID` header. **Expected, not a fault** — the gap is replayed from the Redis stream, so nothing is lost |
| Origin takes over 125 s to respond | Cloudflare **524** | Only reachable by a genuinely stuck request. The 25 s heartbeat keeps every feed well inside it |

### Option E — ngrok

| Failure | What the operator sees | How it is distinguishable |
|---|---|---|
| Usage credit or transfer exhausted mid-party | The endpoint stops, or the agent refuses to start next time | An **`ERR_NGROK_…` coded error page**, and the dashboard shows the balance. Nothing in the stack logs will mention it |
| Request-forwarding timeout | 504 after 30–60 s | Coded ngrok error again, not an origin status |
| Response buffering | Same "feed sits still then jumps" signature as option D, with the same LAN-versus-public comparison to prove it | |

### Shared with every option, because the origin is a personal PC

None of these are ingress faults, and all of them present as "the site is
down". Rule them out first on an event morning.

- The PC is asleep or hibernating. `powercfg /change standby-timeout-ac 0` and
  `powercfg /change hibernate-timeout-ac 0`, on mains.
- The PC rebooted and nobody signed in. Docker Desktop runs in the user
  session; until someone logs on, the stack is down whatever the ingress does.
- Docker Desktop did not start at logon.
- The `migrate` container failed, so the API and worker never started. The site
  serves, `/api/healthz` does not.
- The house internet is down. Photography is unaffected: the shutter works,
  the capture is on the SD card with its UUID and Roll, and uploads resume by
  themselves when the stack returns — proven on the bench 2026-09-05 with a
  40-capture outage and a 105-capture backlog.

## What could not be confirmed

Stated rather than guessed:

- **Hetzner's current CX22 price.** The live pricing page would not render for
  me. Hetzner's own launch press release lists CX22 at €3.79/month with 20 TB
  traffic and one IPv4 included; several third-party trackers report an
  April 2026 increase to €4.49/month. Treat the monthly figure as €4–5 and
  read it at checkout. The same sources disagree about whether the Primary
  IPv4 is included in that price or adds €0.50/month; the €0.50/month figure
  for an IP that outlives its server is consistent across them.
- **Whether Cloudflare buffers `text/event-stream` today.** Cloudflare
  publishes the timeouts (125 s proxy read, 400 s client keep-alive) but I
  found no vendor statement either way on buffering event streams. The
  evidence against is community reports, including one from 2026 describing a
  ~100 KB buffer with `response_buffering` off. `response_buffering` is not a
  free-plan control. This is measurable in an afternoon and should be measured
  before option D is trusted with a party.
- **Whether a Cloudflare for SaaS fallback origin may be a Cloudflare Tunnel
  hostname.** The documentation requires the fallback origin to be a proxied
  `A`/`AAAA`/`CNAME` record in the platform zone; a tunnel-backed hostname is
  such a record, but Cloudflare does not say so explicitly. Unverified.
- **ngrok's SSE behaviour.** ngrok publishes no statement I could find. The
  buffering and 30–60 s forwarding-timeout claims are third-party.
- **Pinggy and LocalXpose prices and SSE behaviour.** Both figures come from
  third-party pricing aggregators, not the vendors' own pages. Do not quote
  them at anyone.
- **Whether the line is definitely CGNAT.** The traceroute cannot see the
  router's own WAN interface. Everything measured is consistent with CGNAT and
  nothing contradicts it, but the router status page is the thing that closes
  it. The relay path works in every case, which is why this is not blocking.
- **Websupport's exact webadmin wording and minimum TTL.** The record-editing
  path above follows Websupport's own knowledge-base articles for A and CNAME
  records; the current `kino` records answer with TTL 600, so 600 is
  accepted. Whether the panel permits lower was not checked.

## Sources checked, 2026-09-07

Cloudflare: [CNAME setup
(partial)](https://developers.cloudflare.com/dns/zone-setups/partial-setup/) ·
[Tunnels
FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)
· [Tunnel DNS
records](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)
· [Cloudflare for SaaS
plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)
· [Cloudflare for SaaS getting
started](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)
· [Connection
limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)
· [Error
524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524)
· [SSE buffering report,
2026](https://community.cloudflare.com/t/sse-endpoint-breaks-after-recent-update-cloudflare-buffers-text-event-stream-desp/810790)
· [cloudflared issue 199, SSE
buffered](https://github.com/cloudflare/cloudflared/issues/199) · [Goodbye
section 2.8](https://blog.cloudflare.com/updated-tos) — the old ban on serving
non-HTML content through the CDN was removed in 2023, so serving photographs is
no longer a terms problem. Business-plan price from
[third-party](https://blog.blazingcdn.com/en-us/cloudflare-pricing-2026-free-pro-business-enterprise-explained)
[trackers](https://costbench.com/software/cdn-edge/cloudflare/), not a
Cloudflare page.

ngrok: [pricing](https://ngrok.com/pricing) (plan names, prices, which tier
carries custom domains) · [ngrok
alternatives](https://localxpose.io/blog/best-ngrok-alternatives) for the apex
limitation.

Tailscale: [Tailscale
Funnel](https://tailscale.com/docs/features/tailscale-funnel) ·
[FR: custom domains for
Funnel](https://github.com/tailscale/tailscale/issues/11563) · [Funnel custom
domain CNAME failure](https://github.com/tailscale/tailscale/issues/16478).

VPS: [Hetzner new CX plans](https://www.hetzner.com/pressroom/new-cx-plans/) ·
[Hetzner 2026 price
increase](https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/) ·
[orphaned Primary IP
billing](https://cloudtally.eu/blog/hetzner-cloud-costs-youre-probably-missing)
· [Oracle Always Free
resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
and [the 2026 Arm allowance
halving](https://webhosting.today/2026/05/29/hetzner-has-now-raised-prices-three-times-in-2026-this-one-is-different/).

Self-hosted: [Pangolin
deployment](https://ramnode.com/guides/pangolin) · [Pangolin as a Cloudflare
Tunnel
alternative](https://leewc.com/articles/self-hosted-cloudflared-tailscale-alternative-pangolin/).

Websupport: [A
records](https://www.websupport.sk/podpora/kb/a-zaznamy/) · [CNAME
records](https://www.websupport.sk/podpora/kb/cname-zaznamy/) · [how long a DNS
change takes](https://www.websupport.sk/podpora/kb/kolko-trva-zmena-dns-zaznamu/).

Measured locally, not from the web: `Resolve-DnsName` for the current `kino`
`A`/`AAAA`/TTL and the `acronym.sk` NS set; the SSE headers and 25 s heartbeat
read out of `apps/api/src/routes/guest-events.ts` and `host-events.ts`; the
relay design read out of `infra/relay/`.
