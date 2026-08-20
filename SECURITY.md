# Security policy

KINO touches local hardware, firmware updates, authentication, private photographs, and internet-facing uploads. Report security failures privately.

## Supported versions

There is no published release yet. Security fixes target the current `main` branch. Once releases exist, this table will name the supported versions and their end dates.

## Report a vulnerability

Use the repository's [private security advisory form](https://github.com/b5463/kino-d4/security/advisories/new). Do not open a public issue for an unpatched vulnerability.

Include:

- the affected commit or version;
- the component and entry point;
- steps or a small reproducer;
- the expected and observed result;
- the practical impact;
- any logs with secrets, tokens, roll PINs, device credentials, and private media removed.

If private reporting is unavailable, open a public issue that says only that you need a private security contact. Do not include exploit details.

## High-risk areas

Pay particular attention to:

- firmware package validation and downgrade behavior;
- Web Serial framing, payload limits, and malformed device responses;
- host, device, and guest authentication;
- roll PINs, cookies, tokens, and request logging;
- upload idempotency, object keys, and cross-roll access;
- archive, media, LUT, sound, and backup parsing;
- service-worker caching of private or stale data;
- secrets copied from `infra/.env.example` into production.

The development credentials committed under `infra/` are public placeholders. Production must set a fresh `COOKIE_SECRET`, real storage credentials, and an explicit environment.

## Private media

Do not attach real party photographs to issues or pull requests unless every person shown has agreed. Prefer the included simulator or a purpose-made test scene. Strip EXIF, network names, serial numbers, tokens, and location data from diagnostic assets.

## Disclosure

Give the maintainer time to reproduce and fix the issue before publishing details. No response-time promise exists yet. The advisory will record the fix, affected versions, and disclosure date when the first security release is made.
