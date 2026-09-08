# Pinggy paid plan: what KINO Roll would be buying

Research only. No account was created, no trial started, no payment detail
entered, no DNS record changed. Nothing in this document has been done.

Retrieval dates are given per figure. Items marked 2026-09-07 were read on that
date; items marked 2026-09-08 were read or re-read on that date. Every figure
comes from Pinggy's own pages — pricing card source, docs, help page, terms,
privacy policy, engineering blog — unless a line is explicitly labelled as
third-party corroboration.

Scope: what a Pinggy subscription would give `kino.acronym.sk` with the origin a
Windows PC behind carrier NAT, up on event days only, Websupport authoritative
for `acronym.sk`, and a CNAME on the `kino` label.

Sibling document: [`public-ingress-options.md`](public-ingress-options.md),
which records the relay-VPS decision. This file does not re-open that decision.
It fills in the Pinggy column with primary-source facts so the comparison can be
audited.

What the free tier has already proven here, for context and not from Pinggy:
the live event stream carried without buffering, a real phone over cellular
passed acceptance, the session expired at 60 minutes as documented, and the
interstitial was bypassed for testing with an `X-Pinggy-No-Screen` request
header.

## Summary

| # | Question | Answer | Primary source | Retrieved |
|---|---|---|---|---|
| 1 | Cheapest plan allowing a customer-owned custom domain | **Pinggy Pro**. The only paid tier below Enterprise. | `pinggy.io/docs/custom_domain/` | 2026-09-07 |
| 2 | Price | **USD 3.00 per seat per month** billed monthly. **USD 2.50 per seat per month** billed annually. Per seat. Annual charged total not printed on the site. | `pinggy.io/` pricing card source | 2026-09-07 |
| 3 | Paid tier removes the visitor warning page | **Yes. Stated plainly, twice.** "Note that for Pro tunnels, no screening page is shown." | `pinggy.io/docs/http_tunnels/screening/` | 2026-09-08 |
| 4 | How the domain is pointed | One **CNAME** on host `kino` → dashboard-issued target of the form `<7 chars>.a.pinggy.link.` **No TXT** for a subdomain. TLS from Let's Encrypt, issued by a dashboard button, auto-renewed when no tunnel is active. | `pinggy.io/docs/custom_domain/`, `pinggy.io/docs/relays/` | 2026-09-07 |
| 5 | Bandwidth | "Unlimited Data Transfer" on Free and Pro. No published cap, quota or overage. No fair-use clause in the Terms. | `pinggy.io/` pricing card, `pinggy.io/terms_of_service/` | 2026-09-07 |
| 6 | Duration and concurrency | 60-minute timeout is stated as a **free-plan** property; no Pro timeout is published anywhere. **One active tunnel per token**, and a token is a seat. Client disconnect simply ends the tunnel; reconnect is the client's job. | `pinggy.io/help/`, `pinggy.io/docs/advanced/advanced_options/`, `pinggy.io/docs/guides/long_running_tunnels/` | 2026-09-07 |
| 7 | Endpoint stability between event sessions | **Yes, by design, and Pinggy's engineering blog explains the mechanism.** The customer CNAME points at a token-bound persistent subdomain; Pinggy's own DNS re-points that subdomain to whichever edge the tunnel comes up on, synchronously, at each tunnel creation. **DNS is edited once.** Caveat: the parent domain itself has been migrated before, with about 7 days' notice. | `pinggy.io/blog/scaling_across_multiple_regions/`, `pinggy.io/docs/persistent_subdomain/`, `pinggy.io/blog/fixed_deceptive_website_warning/` | 2026-09-08 |
| 8 | Terms that bite a photo party | Perpetual sublicensable licence over "Your Content"; operator warrants guest consent; Pinggy reads HTTP tunnel traffic for the Web Debugger; adult-content ban on content you cannot pre-screen; Indian entity and jurisdiction, no DPA; 7-day refund window only; liability capped near USD 18. | `pinggy.io/terms_of_service/`, `pinggy.io/privacy_policy/`, `pinggy.io/help/` | 2026-09-07 |

## The prepared Websupport change — DO NOT EXECUTE

> Not to be made until the operator decides to buy, and not before the Pro
> dashboard has issued the real target. The target below is a shape, not a
> value: the seven-character label is assigned per token and only the
> dashboard knows it.

At Websupport, on the `acronym.sk` zone, touching the `kino` label and nothing
else:

| Action | Type | Host | Value | TTL |
|---|---|---|---|---|
| REMOVE | A | `kino` | `37.9.175.156` | — |
| REMOVE | AAAA | `kino` | `2a00:4b40:aaaa:2004::7` | — |
| ADD | CNAME | `kino` | `<7 chars>.a.pinggy.link.` | 600 |

The AAAA removal is not optional. A phone that prefers IPv6 would otherwise
keep reaching Websupport's parking page while every IPv4 client sees the roll,
which presents as "it works on my laptop and not on my phone" and wastes an
evening.

Do not touch `@`, `www`, `mail`, MX, SPF, DKIM, DMARC, or any other label. Order
matters only in that the CNAME cannot coexist with the A and AAAA on the same
label, so remove both first.

Then, in the Pinggy dashboard, press the button that issues the Let's Encrypt
certificate for `kino.acronym.sk` — it needs no tunnel running, takes up to a
minute to issue and up to seven to activate, and it renews itself only while no
tunnel is active. A first event started before activation completes will serve
a certificate error, so do this the day before, not at the venue.

Verification, in this order: `kino.acronym.sk` resolves to the Pinggy target;
HTTPS presents a certificate for `kino.acronym.sk` and not a Pinggy name; the
site answers with no tunnel running (expect an error page from Pinggy, which
proves DNS and TLS without the origin); then start the tunnel and re-check.

Rollback is the inverse and costs one TTL: delete the CNAME, restore the two
parking records. Keep their values recorded above, because a rollback under
pressure is not the moment to go looking for them.

## 1. Which plan

Three tiers on the homepage pricing card: **Free**, **Pro** (labelled "Most
Popular"), **Enterprise** (custom price, contact sales).

The custom-domain document opens: "With **Pinggy Pro** you can configure your
own domain name, such as `www.mysite.com` or `*.example.com`, to access your
tunnels."

The cheapest tier that permits `kino.acronym.sk` is therefore **Pinggy Pro**,
named exactly that. There is no cheaper paid step, and no add-on that buys a
custom domain without the tier. Source `https://pinggy.io/docs/custom_domain/`,
retrieved 2026-09-07.

## 2. Price

The pricing card renders Pro prices client-side, so the page text shows only
"/month". The numbers are literals in the page source, in Alpine `x-text`
bindings:

```
x-text="... currency === 'INR' ? (204.89 * seatVal).toFixed(2) : (2.50 * seatVal).toFixed(2)"   <- billed annually
x-text="... currency === 'INR' ? (245.87 * seatVal).toFixed(2) : (3.00 * seatVal).toFixed(2)"   <- billed monthly
```

The currency store defaults to `"$"` and switches to `INR` only when the
visitor's country resolves to India:

```
Alpine.store("location",{country:"Unknown",currency:"$",detectCountry(){ ... this.country==="India"?this.currency="INR":this.currency="$" ... }})
```

From Slovakia the card therefore shows US dollars.

- Monthly billing: **USD 3.00 per seat per month**.
- Annual billing: **USD 2.50 per seat per month**. The billing toggle is
  labelled "Save up to 17%", consistent with 2.50 against 3.00.
- Pricing **is per seat**. The card carries a seat spinner starting at 1, and
  the entitlements scale with it: "1 Persistent tunnel", "1 Custom subdomain",
  "1 Custom domain", "1 Persistent TCP/UDP port", "1 Team". Above 20 seats the
  card says to contact sales for volume discounts.
- One seat covers KINO Roll: one custom domain, one tunnel.

**The annual charged total is not printed anywhere on the site.** USD 2.50 × 12
= USD 30.00 per seat per year is arithmetic from the displayed rate, not a
quoted price. Whether that is charged once up front, in what currency it
settles, and what VAT a Slovak buyer pays on top of an Indian seller's invoice
are visible only at checkout. Checkout was not opened, so those figures are not
established here.

Sources: `https://pinggy.io/` page source and the linked
`bundle.min.a00d9e73….js`, retrieved 2026-09-07. Corroborated by Pinggy's own
comparison page `https://pinggy.io/compare/pinggy-vs-ngrok/`, which prints
`$3.00` for Pro, retrieved 2026-09-07. No aggregator figure was used.

## 3. The visitor warning page — answered plainly

This is the question that decides whether the plan is usable at a party, and it
is the clearest answer on the whole site. From
`https://pinggy.io/docs/http_tunnels/screening/`, re-read 2026-09-08 (page
metadata `dateModified` 2026-05-29):

> "When you open a **free** Pinggy tunnel URL (a `*.run.pinggy-free.link`
> address) in a web browser, Pinggy shows a one-time screening page before the
> site loads. **Note that for Pro tunnels, no screening page is shown.**"

and again under its own heading, "Removing it entirely":

> "The screening page applies to free tunnels only. **Pinggy Pro** tunnels serve
> your site without it."

Two independent statements on the same page, no qualifier, no plan footnote, no
"on some regions". The same page confirms the behaviour already observed on the
free tier here: browser-only, once per browser, bypassed by an
`X-Pinggy-No-Screen` header of any value or by a non-standard `User-Agent`.

Why that bypass does not solve the party: it is a request header. A guest who
scans the QR code and lands in Safari or Chrome sends a standard browser
`User-Agent` and no custom header, so the guest meets the screen. The header
trick works for the test harness and for programmatic clients, not for people.
Pro removes the screen for everyone, which is the only form of the fix that
works at a party.

**Item 3 is confirmed. Buying Pro removes the interstitial.**

## 4. Pointing the domain

For a **subdomain** such as `kino.acronym.sk`, the flow is CNAME only. From
`https://pinggy.io/docs/custom_domain/`, retrieved 2026-09-07:

1. Dashboard → Domains, open the token's edit icon, "Custom Domain" tab, enter
   `kino.acronym.sk`, press Update.
2. The dashboard returns an instruction of the form: "Add a CNAME record to
   `app.example.com` with target `ahsu9ol.a.pinggy.link` and then Validate."
3. In Websupport: record type **CNAME**, host `kino`, value the dashboard's
   target including the trailing dot — the doc notes "[ The dot at the end might
   be necessary ]". Recommended TTL 600.
4. Press **Validate** in the dashboard.
5. Press **Issue Certificate**. "Make sure that **no tunnel is running** (with
   this token)." Issuance takes up to a minute; the certificate can take up to
   seven minutes to become active; tunnels must be restarted afterwards.

**No verification record is required for a subdomain.** A TXT record appears
only on the relay path, which exists for **base** domains (`example.com`) where
DNS will not accept a CNAME at the apex. That path uses a TXT value for
ownership proof and then A **and** AAAA records to a chosen regional relay
(`https://pinggy.io/docs/relays/`, retrieved 2026-09-07). `kino.acronym.sk` is a
subdomain, so the plain CNAME path applies, Websupport stays authoritative for
`acronym.sk`, and exactly one record changes.

Also from the relay document, worth recording: custom domains via relay work for
HTTP(S), TLS and TCP but **not** UDP. Irrelevant to KINO Roll, which is HTTP.

**TLS for the custom hostname is automatic in substance but not silent.**
Pinggy obtains a Let's Encrypt certificate for the hostname, and renewal is
opportunistic: "Pinggy automatically renews certificates if it finds the
opportunity when the tunnel is not active." An expired certificate can be
renewed by hand from `dashboard.pinggy.io/domains`
(`https://pinggy.io/help/`, retrieved 2026-09-07). For a machine that is off
between events this is the clause to watch — renewal wants a window with the
tunnel down, which an event-day-only origin has in abundance, but the renewal
still has to happen against a live subscription.

Wildcards (`*.acronym.sk`) are supported on Pro. Not needed here.

## 5. Bandwidth

The homepage pricing card lists "Unlimited Data Transfer" under **both** Free and
Pro. Pinggy's comparison page `https://pinggy.io/compare/pinggy-vs-ngrok/`
(Pinggy's own page, marketing in tone) prints "Bandwidth (Data Transferred):
Unlimited" for Pinggy against "5 GB per month" for ngrok, and adds "Pinggy
offers unlimited bandwidth … Pinggy won't throttle or disconnect you." Both
retrieved 2026-09-07.

There is no published quota, no overage price, and **no fair-use clause anywhere
in the Terms of Service**. What the Terms do contain is an unconditional
suspension right: "We may terminate or suspend access to the Services
immediately, without prior notice or liability … for any reason whatsoever."

So the honest reading: a party pushing full-resolution originals violates no
published limit, and there is no metered bill to fear. There is also no
contractual floor — "unlimited" holds until Pinggy decides otherwise, with no
stated threshold and no notice period. Nothing about exceeding a limit is
documented, because no limit is documented.

## 6. Session, duration, concurrency

**Duration.** The 60-minute cut-off is described everywhere as a free-plan
property. `https://pinggy.io/help/`, retrieved 2026-09-07: "Pinggy's free plan
has a tunnel timeout of 60 minutes. If the tunnel is closed by you or reaches the
time limit, starting a new tunnel will generate a new URL. To obtain a permanent
or persistent URL, or to use your own domain, you must subscribe to Pinggy Pro."
The pricing card lists "60 minutes tunnel timeout" under Free and "Persistent
tunnel" under Pro. The July 2023 blog post confirms the origin of the number:
"Limiting the unregistered free tunnels to 60 minutes."

Pinggy never writes "Pro tunnels have no timeout." The absence of a Pro limit is
inferred from the two feature lists plus the word "persistent". That inference
is consistent but it is not a quotation.

**Concurrency.** One active tunnel per token. From
`https://pinggy.io/docs/advanced/advanced_options/`, retrieved 2026-09-07:
"trying to connect to establish a tunnel with a token which is already in use by
another active tunnel will produce the error 'Login is not allowed: A tunnel
with the same token (xxYYzzZ) is already active.'" A `force@` prefix
(`ssh -p 443 -R0:localhost:8000 force@free.pinggy.io`) kills the incumbent and
takes over; the dashboard has the same control under Active Tunnels. The
multi-region blog post confirms this is enforced in the core at setup: the edge
asks the core "to ensure that no tunnels with the same subdomain are active."

Seats equal tokens, so **one seat is one concurrent tunnel**. More concurrency
costs more seats. For KINO Roll one is enough, but note the operational
consequence: a stale tunnel from a previous session blocks the new one until it
is forced off. That is a foreseeable event-day failure, and `force@` is the fix.

**Disconnect.** Nothing special happens. The tunnel ends and the public hostname
stops answering until a client reconnects. Pinggy's guidance is client-side:
"Pinggy CLI has auto reconnection built in", plus documented `while` and
`FOR /L` retry loops with `ServerAliveInterval=60`
(`https://pinggy.io/docs/guides/long_running_tunnels/`, retrieved 2026-09-07).
The tunnel needs a supervisor on the origin, exactly as any other tunnel client
would.

## 7. Endpoint stability between event sessions — the operating-model question

**Answer: the DNS record is set once. Pinggy handles the moving part itself, and
its engineering blog documents the mechanism in detail.**

From `https://pinggy.io/blog/scaling_across_multiple_regions/`, retrieved
2026-09-08. The section is titled "Dynamic DNS updates" and opens: "The most
challenging part of this entire process of multi-region scaling is handling the
DNS."

The chain is two links, not one:

```
kino.acronym.sk  --CNAME-->  <token>.a.pinggy.link  --CNAME-->  eu.a.pinggy.link
   you own this            Pinggy owns this, and rewrites it per tunnel
```

Pinggy's own words: "Pinggy offers (i) persistent subdomains (e.g.
`androidblog.a.pinggy.io`) as well as (ii) custom domains (e.g. mydomain.com). A
custom domain simply points to a persistent subdomain through a CNAME record."
And: "When a tunnel is created, the persistent subdomain has to point to the
server where the tunnel is running."

They then explain why the second link must be dynamic — a client connects to
whichever edge is nearest, so the same persistent subdomain must resolve to
`us.`, `eu.` or `ap.` depending on where the tunnel came up — and why they run
their own PowerDNS rather than Route 53: Route 53 takes up to 60 seconds to
propagate, which breaks a tunnel that must be reachable the instant its URL is
handed out. Their end-to-end flow lists the step explicitly: "Once the tunnel is
authenticated and ready to be activated, a DNS record is created in the PowerDNS
servers: `androidblog.a.pinggy.io -> ap.a.pinggy.io`. The tunnel becomes live."

The consequences for an event-day-only origin, which is exactly this
architecture's intended case:

- The **customer-facing CNAME target is the persistent subdomain**, which is
  bound to the token, not to a session and not to an edge.
- Stopping the tunnel and restarting it weeks later re-runs that PowerDNS write
  against the same subdomain. The Websupport record does not need to change.
- It survives even the origin moving between regions or networks — the whole
  point of the design is that the client may connect from anywhere.
- TTLs are deliberately low on Pinggy's side, including the SOA negative-caching
  TTL, so a first lookup after a cold start retries in seconds rather than
  caching a failure.

Pinggy still never writes the flat sentence "your CNAME target never changes."
But the mechanism they publish is stronger evidence than such a sentence would
be, because it explains *why* it cannot need to change per session. This is a
documented architecture, not an inference from a feature list.

**The real caveat, and it is a different risk than the one we were looking for.**
The per-session stability is sound. The **parent domain** has been migrated
before, and when it happened, custom-domain customers had to re-point their
CNAME by hand. From `https://pinggy.io/blog/fixed_deceptive_website_warning/`
(dated 2023-07-16, `dateModified` 2023-07-26), retrieved 2026-09-08, after
abuse of free tunnels got the shared domain flagged:

> "Moving all tunnels to the domain `pinggy.online`" … "Existing persistent
> subdomains will be moved to `pinggy.online`, effective immediately." …
> "Custom domains (e.g., `cooking.com`) will continue to work as usual, but you
> need to **update your CNAME and reissue your certificate preferably within 7
> days**."

And the parent domain has clearly moved again since: the 2023 post says
`pinggy.online`, the multi-region post says `a.pinggy.io`, and today's
custom-domain doc issues targets under `a.pinggy.link` while free tunnels sit on
`run.pinggy-free.link`.

So the correct statement of item 7 is two-part, and both parts matter:

- **Per event session: stable.** Set the Websupport record once. Stopping and
  restarting the tunnel weeks later needs no DNS work. This is the answer that
  determines the operating model, and it is the good one.
- **Across years: not guaranteed.** Pinggy has changed the parent domain at
  least twice in three years, once as an emergency response to blocklisting,
  and both times custom-domain customers had to edit their own DNS and reissue
  the certificate, with roughly a week's notice by email or blog post.

For KINO Roll that second part is tolerable — it is a scheduled maintenance task
with notice, not a per-event surprise — but it means the DNS record is not
genuinely set-and-forget, and someone has to be reading Pinggy's announcements.
Note also the reason the last migration happened: free-tier abuse poisoning a
shared parent domain. Pinggy now splits free and pro into separate DNS zones
specifically to stop that recurring — "abuse on the free zone stays on the free
zone" — which reduces but does not eliminate the risk for a paying customer.

## 8. Terms that bite a photo-sharing party

Terms of Service at `https://pinggy.io/terms_of_service/`, **last updated
January 1, 2023**, retrieved 2026-09-07. Operator: PINGGY TECHNOLOGY PRIVATE
LIMITED, Birbhum, West Bengal, India.

- **Content licence.** "You hereby grant to Pinggy a worldwide, irrevocable,
  perpetual, non-exclusive, transferable, royalty-free license, (with the right
  to sublicense), to use, copy, adapt, modify, distribute, license, sell,
  transfer, publicly display, publicly perform, transmit, stream, broadcast and
  otherwise exploit for any purpose Your Content." It further grants "the
  unconditional right to use and exploit your name, voice, persona and likeness
  included in any User Content." Read literally, guest photographs crossing the
  tunnel fall inside "Your Content". Whether the clause was drafted for tunnel
  traffic or for forum posts is arguable; it contains no carve-out either way.
- **You warrant guest consent.** "You shall ensure that all users have provided
  all necessary consents and permissions for you to make Customer Data available
  to Pinggy." For EU data subjects: "you shall ensure that Customer Data does
  not include sensitive personal data (as defined under the GDPR)." Party
  photographs of identifiable guests are personal data. Whether any given frame
  is *sensitive* under GDPR Art. 9 is a judgement the operator would be making
  on the venue's behalf, on the night, without review.
- **Pinggy reads the traffic.** `https://pinggy.io/help/`, retrieved 2026-09-07:
  "Pinggy does read tunnel traffic for providing the Web Debugger feature. Use
  TLS tunnels for Zero trust mode, where Pinggy cannot read your data." An HTTP
  tunnel — which is what a browser-facing site requires — is terminated and
  readable at Pinggy's edge. The zero-trust alternative is incompatible with
  serving a public site to guests' phones, so for this use case there is no
  configuration in which the photographs are opaque to Pinggy.
- **Adult content, on content you cannot pre-screen.** "Users are strictly
  prohibited from hosting, uploading, or distributing any adult content or
  pornographic materials through Pinggy", plus a general ban on "infringing,
  obscene, threatening, libelous, or otherwise unlawful material". A party feed
  is guest-submitted content arriving faster than anyone moderates it. Pinggy
  reserves the right to remove content and suspend the account "without notice
  for any reason, including … for no reason, at any time." A single guest
  submission could take the hostname down mid-party.
- **No development-only restriction.** Nothing in the Terms limits the service
  to development or testing traffic. The only usage bar of that shape is
  competitive: no use "in a fashion that could reasonably be deemed to compete
  with the business of Pinggy". Serving a party feed does not trip it. Note the
  site's own framing is developer tooling ("Made for developers, everywhere",
  "Ingress for dev/test"), but that is marketing, not a contractual limit.
- **Retention.** The Privacy Policy (`https://pinggy.io/privacy_policy/`,
  retrieved 2026-09-07) describes Usage Data — IP address, browser type and
  version, pages visited, timestamps, device identifiers, diagnostic data — and
  says it "is generally retained for a shorter period of time", with no number.
  Retention of tunnel payloads is not addressed at all. Free-tier tunnels also
  embed the origin's IP in the hostname; the Terms flag the GDPR consequence of
  that and put the controller obligation on the customer.
- **Refunds.** Within 7 days of original signup only, and only "citing how we
  are violating our terms of service". Cancellation stops renewal, immediate, no
  fee, "No refunds are applicable for the current subscription period." There is
  effectively no buyer's-remorse refund.
- **Liability cap.** The greater of INR 1000 or six months of fees. At USD 3 per
  month that is roughly USD 18.
- **Jurisdiction and data protection.** India. No DPA, no standard contractual
  clauses, no processor terms anywhere in the document. For a Slovak operator
  handling EU guests' images this is the substantive gap, larger than any of the
  content clauses.

## What could not be confirmed

1. **The annual charged total and the tax.** The card shows "USD 2.50 /month
   billed annually" and never prints a yearly figure, a settlement currency, or
   EU VAT. USD 30.00 per seat per year is arithmetic, not a quoted price. Only
   checkout shows the real number, and checkout was not opened. *Would confirm:
   reaching the Stripe checkout screen without completing it, or an invoice from
   an existing subscriber.*
2. **Whether Pro tunnels have any duration limit at all.** The 60-minute figure
   is attributed only to the free plan and Pro is described as "persistent", but
   no page states that Pro tunnels never time out. A five-hour party is the test
   case. *Would confirm: a written answer from `contact@pinggy.io`, or one
   observed Pro tunnel held past six hours.*
3. **Long-term stability of the parent domain.** Per-session stability is
   settled (item 7). What is not knowable is when Pinggy next moves the parent
   zone and requires a customer CNAME edit; it has happened at least twice since
   2023, once at 7 days' notice. *Would confirm: nothing can — this is a vendor
   risk to be monitored, not a fact to be established. Mitigation is subscribing
   to Pinggy's announcements and treating the DNS record as maintained, not
   permanent.*
4. **What happens on very large transfers.** "Unlimited" is published with no
   fair-use clause and no threshold, alongside an unconditional suspension
   right. There is no number to plan against and no documented overage
   behaviour. *Would confirm: a written fair-use answer from Pinggy.*
5. **Concurrent visitor limits and per-tunnel throughput.** Nothing published on
   simultaneous connections, request rate, or bandwidth per tunnel. A party is
   dozens of phones pulling a feed at once; no primary source addresses that
   load shape. The multi-region post describes the edge architecture but quotes
   no per-tunnel limits. *Would confirm: a load test against a Pro tunnel, or a
   written answer.*
6. **Server-Sent Events through the Pro path specifically.** Not documented
   either way, and the live feed depends on it. The free tier carried the stream
   without buffering here, which is real evidence, but free and pro are
   documented as different DNS zones and the screening layer differs, so it is
   not proof the Pro path behaves identically. *Would confirm: the existing
   latency harness run against a Pro tunnel during the trial.*
7. **Tunnel payload retention.** The Privacy Policy covers Usage Data only. It
   neither confirms nor denies storage of bytes crossing the tunnel, while the
   help page confirms Pinggy reads them for the Web Debugger. For guest
   photographs this is the unanswered question that matters most. *Would confirm:
   a written answer from Pinggy, ideally a DPA.*
8. **Terms currency.** The Terms of Service are dated 1 January 2023 and predate
   Teams, relays, the screening page, and the multi-region rebuild. Whether they
   have been reviewed against the current product is unknown, and the content
   licence reads as if drafted for a different kind of service.
9. **Dashboard-only facts.** Seat management, token administration, the Active
   Tunnels control, the exact custom-domain target string, and the checkout
   wording all sit behind a login. No account was created, so none of it was
   inspected. The target *shape* comes from the docs, not from a live dashboard.

## Recommendation

The two questions that were flagged as decisive are both answered from primary
sources and both answered favourably: Pro removes the interstitial, stated
plainly twice on Pinggy's own documentation page, and the custom-domain target is
stable across sessions because Pinggy's own DNS carries the per-session
rewrite — the Websupport record is edited once, not before every party. The
facts are sufficient to support a purchase decision on mechanism and price.

The one thing that should be settled before money moves is not technical: **get
Pinggy to answer, in writing, what happens to tunnel payloads** — whether guest
photographs are retained anywhere, and whether they will provide a DPA — because
the Terms grant a perpetual sublicensable licence over content, the help page
confirms Pinggy reads HTTP tunnel traffic, and the operator is handling EU
guests' faces under an Indian contract with no processor terms. At USD 3 a month
the financial exposure is trivial; the data-protection exposure is the only part
of this that is not.
