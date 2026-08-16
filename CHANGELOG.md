# Changelog

KINO has no published release yet. Changes intended for the first release collect under **Unreleased**. Git remains the record for work completed before this file existed.

## Unreleased

### Added

- KINO Studio with simulated and Web Serial device connections.
- KINO Device Protocol framing, CRC, commands, transports, jobs, and timing vocabulary.
- Portable `kino.*` schemas with versioned migrations and unknown-field preservation.
- Reference D4 device, media store, factory recipes, and injectable failure scenarios.
- Roll API foundation with authentication, roll lifecycle, resumable uploads, object storage, and live events.
- Maintained hardware, architecture, development, firmware-contract, troubleshooting, contribution, security, and release documentation.
- Split light and dark KINO D4 brand marks plus a real Studio demo capture.
- Path-scoped MIT software and CERN-OHL-S-2.0 hardware licensing with SPDX/REUSE metadata and reserved brand assets.
- Machine-readable software, protocol, schema, database, and hardware version control enforced by CI.
- D4 physical revision records, artifact versions, and numbered engineering change notices.

### Known incomplete work

- The public Roll client is under construction.
- KINO Twin is under construction.
- Physical D4 firmware and final hardware measurements are not shipped from this repository yet.
- Firmware signing and rollback are not implemented.

## Changelog rules

- Record user-visible changes, protocol compatibility changes, schema migrations, database migrations, hardware revisions, and security fixes.
- Keep refactors out unless they change a public contract or remove a supported path.
- Move Unreleased entries into a dated version section only when that version is published.
- Link the release section to its Git tag once tags exist.
