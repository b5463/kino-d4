# acronym.sk — pre-migration DNS record, 2026-09-09

The zone as the public internet saw it, captured before any nameserver change,
so a migration can be reversed and an omission can be proved rather than
argued about.

**This is a resolver-derived snapshot, not the authoritative zone.** Every
line below was read from Google Public DNS (8.8.8.8) against the Websupport
nameservers. That is enough to reconstruct what the world currently resolves,
and it is **not** the same thing as a complete zone export, for one reason
worth being blunt about: DNS answers questions, it does not list contents.
There is no zone transfer, so a record nobody thinks to ask for stays
invisible. Specifically at risk of being missed here:

- **TXT verification records at names not guessed.** One Google
  site-verification is present at the root; others (Microsoft, Atlassian,
  Facebook, an ACME account key) would sit at names this capture did not try.
- **DKIM selectors other than `mail`.** `mail._domainkey` is present. A
  second signing key at another selector would not appear.
- **SRV records** (`_autodiscover._tcp`, `_caldav`, `_submission`), which have
  no discoverable name pattern.
- Anything the panel holds but the nameservers do not currently serve.

**Before any nameserver change, export the zone from the Websupport panel and
diff it against this file.** The panel export is authoritative; this is the
cross-check that catches an import Cloudflare got wrong, not a substitute for
it.

## Authority

| Field | Value |
|---|---|
| Registrar / DNS host | Websupport |
| Authoritative nameservers | `ns1.websupport.sk`, `ns2.websupport.sk`, `ns3.websupport.sk` |
| SOA primary | `ns1.websupport.sk` |
| DNSSEC | not observed |
| CAA | none at the root — any CA may issue |

## The wildcard, which is the important one

```
*.acronym.sk.    A     37.9.175.156
*.acronym.sk.    AAAA  2a00:4b40:aaaa:2004::7
```

Confirmed by resolution: `zzq7x4-nonexistent`, `a1b2c3d4e5f6` and
`definitely-not-a-real-host-9911` all answer `37.9.175.156` rather than
NXDOMAIN.

Two consequences.

**`kino.acronym.sk` has no record of its own today.** It resolves only because
the wildcard catches it, and it currently points at Websupport's web server.
Nothing has to be deleted to introduce it — but nothing is reserving it
either.

**The wildcard has to be carried across deliberately.** Cloudflare imports
what it can read, and a wildcard is a record it can only guess at from a
resolver's answers. If it is not recreated, every name that is not explicitly
listed below stops resolving the moment authority moves — `dev`, `test`,
`staging`, `git`, `cloud`, `api`, `vpn`, `cpanel`, `m1`, `ns1`, `ns2`,
`_acme-challenge` and anything else anyone ever pointed at this domain. All of
those resolve today **only** through the wildcard.

Note for whoever recreates it: on Cloudflare, a **proxied** wildcard is an
Enterprise feature. This wildcard must be DNS-only (grey cloud), which is also
what it should be — it points at Websupport's server, not at KINO.

## Root

| Name | Type | Value |
|---|---|---|
| `acronym.sk` | A | `37.9.175.156` |
| `acronym.sk` | AAAA | `2a00:4b40:aaaa:2004::7` |
| `acronym.sk` | MX | `10 mailin1.acronym.sk` |
| `acronym.sk` | MX | `100 mailin2.acronym.sk` |
| `acronym.sk` | TXT | `v=spf1 a mx include:_spf.m1.websupport.sk ?all` |
| `acronym.sk` | TXT | `spf2.0/pra a mx include:_sid.m1.websupport.sk ?all` |
| `acronym.sk` | TXT | `google-site-verification=QlcnKpkeccANSqg1ANIAh9Oz0a3fPJ-tbCs66abbO20` |

## Mail

| Name | Type | Value |
|---|---|---|
| `mail` | A / AAAA | `45.13.137.4` / `2a00:4b40:aaaa:2101:45:13:137:5` |
| `smtp` | A / AAAA | `45.13.137.4` / `2a00:4b40:aaaa:2101:45:13:137:5` |
| `imap` | A / AAAA | `45.13.137.4` / `2a00:4b40:aaaa:2101:45:13:137:5` |
| `webmail` | A / AAAA | `45.13.137.4` / `2a00:4b40:aaaa:2101:45:13:137:5` |
| `mailin1` | A / AAAA | `45.13.137.7` / `2a00:4b40:aaaa:2101:45:13:137:8` |
| `mailin2` | A / AAAA | `45.13.137.8` / `2a00:4b40:aaaa:2101:45:13:137:9` |
| `autodiscover` | CNAME | `web.prod.bts.websupport.sk` |
| `autoconfig` | CNAME | `web.prod.bts.websupport.sk` |
| `mail._domainkey` | TXT | `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwkYJY0XmdOTvwXgkmz3aMni+EVkwaGz6NFd5MztW3ZvS0efoFdfeTo4cyrcrqEfblkpp6GRdizV5a7q/m9ehlKVwhWExrJT/qxlZpJkz212p7gKZPECby90nZtVmxCG47ODhlKXAURZAw9hwJjmPUj+d2ScNCdvFX6hcZGGPx66iewymIQ5To5Ox6SR7yWfBZSBJA8CUJAuCQQSUsCkRhP+tS/haZ1Hv5Dt+VyiPNQGbndMvP5gMHUhSoFWbmTByOo91kcT9b795N0WX4SGBvM18JrVgumGvhBs/o68DtoU5zTJXhcpAWBoo9pU9E8SEHFN/UfR8lAuKPpPeE6kB7QIDAQAB` |

**There is no `_dmarc.acronym.sk` record.** The domain publishes no DMARC
policy. That is the state to preserve — and worth knowing on its own, because
it means SPF and DKIM are advisory: nothing tells a receiver what to do when
they fail.

### The SPF trap, which is specific and easy to walk into

The SPF record is `v=spf1 a mx include:_spf.m1.websupport.sk ?all`. The `a`
mechanism authorises **whatever `acronym.sk` currently resolves to**, and `mx`
authorises whatever the MX names resolve to.

So if the root `A` record is ever set to **proxied** in Cloudflare, `a` stops
meaning "the Websupport web server" and starts meaning "Cloudflare's anycast
range". Mail sent from the real server then fails SPF's `a` mechanism, and the
only thing still passing it is the `include:`.

**The root A/AAAA must stay DNS-only, and so must every mail name.** Nothing
in this zone should be proxied except the one name KINO uses.

## Non-mail names with records of their own

| Name | Type | Value | Note |
|---|---|---|---|
| `www` | A | `37.9.175.156` | same A as root |
| `www` | AAAA | `2a00:4b40:aaaa:2004::5` | **differs from the root AAAA** (`::7`), so this is a real record and not the wildcard |
| `pop` | A / AAAA | `37.9.175.156` / `2a00:4b40:aaaa:2004::7` | identical to the wildcard; cannot tell from outside whether it is a record or a wildcard match. The panel export settles it |
| `ftp` | A / AAAA | `37.9.175.156` / `2a00:4b40:aaaa:2004::7` | same ambiguity as `pop` |

## What must be true before authority moves

- [ ] Websupport panel zone exported and diffed against this file
- [ ] every record above present in Cloudflare, values unchanged
- [ ] both `MX`, both SPF-family `TXT`, and `mail._domainkey` verified
      character for character
- [ ] no DMARC record invented — there is none today
- [ ] wildcard `*` recreated, **DNS-only**
- [ ] root, `www`, and every mail name **DNS-only** (see the SPF trap)
- [ ] only `kino` proxied, and only if the ingress decision requires it
- [ ] old nameservers recorded here for rollback:
      `ns1.websupport.sk`, `ns2.websupport.sk`, `ns3.websupport.sk`

## Rollback

Setting the registrar's nameservers back to the three Websupport names above
restores the zone as captured here, because Websupport keeps serving it until
the zone is deleted there. Propagation is bounded by the parent `.sk`
delegation TTL, not by anything in this file. Do not delete the Websupport
zone while Cloudflare is authoritative.
