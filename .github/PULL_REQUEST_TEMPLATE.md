## What changed

Describe the concrete result and the reason for the change.

## How it was tested

List the commands, browsers, devices, service stack, and bench instruments used. State what was not tested.

## Contracts touched

- [ ] KDP command, event, framing, or wire payload
- [ ] Portable `kino.*` schema or migration
- [ ] Database migration
- [ ] Firmware contract
- [ ] Hardware BOM, wiring, dimensions, or GPIO map
- [ ] Public documentation or product media
- [ ] None of the above

## Compatibility and risk

Describe older Studio, firmware, schema, database, and hardware behavior where relevant. Name recovery or rollback limits.

## Checklist

- [ ] I kept this pull request to one job.
- [ ] I ran the relevant lint, tests, and build.
- [ ] I updated maintained contracts and guides.
- [ ] I labelled simulated output and uncertain hardware facts.
- [ ] I removed secrets, tokens, private media, serial numbers, and location metadata.
- [ ] I rebuilt Graphify with `graphify update . --force` when available.

## Evidence

Attach focused screenshots, traces, measurements, or test output. Use simulated or consented media only.
