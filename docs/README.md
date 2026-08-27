# KINO documentation

Start with the question you need answered. The repository contains working contracts, current product notes, design specifications, and old implementation plans. They do not carry equal authority.

## Find the answer

| Question | Read |
|---|---|
| What is KINO? | [Project README](../README.md) |
| What hardware is in D4 V1? | [Hardware reference](HARDWARE.md) |
| How do I wire, assemble, and accept a physical unit? | [Hardware build package](../hardware/README.md) |
| How do the applications and packages fit together? | [Architecture](ARCHITECTURE.md) |
| How do I install, run, test, or change it? | [Development guide](DEVELOPMENT.md) |
| Something failed. Where do I start? | [Troubleshooting](TROUBLESHOOTING.md) |
| How should I contribute a change? | [Contributing](../CONTRIBUTING.md) |
| What is being built next? | [Roadmap](../ROADMAP.md) |
| What is actively planned or in progress? | [GitHub Project workflow](PROJECT.md) |
| How is a version released? | [Release guide](RELEASING.md) |
| Which version changes when? | [Versioning](VERSIONING.md) |
| Which license applies to a path? | [Root license map](../LICENSE) and [`REUSE.toml`](../REUSE.toml) |
| How do I report a vulnerability? | [Security policy](../SECURITY.md) |
| What must camera firmware implement? | [Firmware contract](../firmware-contract/README.md) |
| How is the D4 firmware built and what exists? | [Firmware tree](../firmware/README.md) and [start plan](../firmware/FIRMWARE_START_PLAN.md) |
| How do Studio, Twin and the firmware work as one system? | [Integration audit](audit/STUDIO_TWIN_FIRMWARE_INTEGRATION_AUDIT.md), [device integration](STUDIO_DEVICE_INTEGRATION.md), [acceptance tests](STUDIO_TWIN_ACCEPTANCE_TESTS.md) |
| How does Studio build and flash firmware? | [Firmware builder](FIRMWARE_BUILDER.md) |
| How does Twin model firmware and photograph a scene? | [Twin firmware model](TWIN_FIRMWARE_MODEL.md), [Twin virtual camera](TWIN_VIRTUAL_CAMERA.md) |
| What should Studio and Roll become? | [Platform spec pack](../kino_dev_spec_pack/00_README.md) |
| How does a camera upload to Roll, and how does Twin stand in today? | [Device contract](roll/ROLL_DEVICE_CONTRACT.md), [Twin integration](roll/ROLL_TWIN_INTEGRATION.md), and the other guides in [`docs/roll/`](roll/) |
| What does the physical camera's Roll path look like, and where does it stop? | [Physical device flow](roll/PHYSICAL_DEVICE_FLOW.md) |
| Why has the ESP32-C6 radio not been brought up? | [C6 hardware map](../firmware/C6_HARDWARE_MAP.md) for the blocking evidence, [C6 bring-up](../firmware/C6_BRINGUP.md) for the procedure once it is unblocked |
| How should the digital twin behave? | [Twin simulator spec](../kino_twin_spec/KINO_TWIN_SIMULATOR_SPEC.md) |
| Which product voice and UI rules apply to Studio? | [Product register](../PRODUCT.md) |
| What remains out of line with the Studio specification? | [Studio spec audit](studio-spec-audit.md) |
| How compliant is the system with the master hardware/software spec? | [Master audit](audit/AUDIT.md) and the per-domain documents in [`docs/audit/`](audit/) |
| What must be measured on the physical D4? | [Hardware validation plan](audit/HARDWARE_VALIDATION_PLAN.md) |

## Authority order

When two documents disagree, use this order:

1. Tested source in `packages/kdp/src/protocol/` and `packages/schemas/src/` defines the current protocol and portable schemas.
2. `firmware-contract/` explains that source for firmware work and records known deviations from the original spec.
3. `apps/*/src` and committed database migrations define current application behavior.
4. `docs/HARDWARE.md` and `kino_twin_spec/SOURCES.md` hold the current hardware snapshot and source confidence.
5. `kino_dev_spec_pack/` defines product intent and acceptance goals.
6. `docs/superpowers/plans/` records implementation history. A plan can explain a decision. It cannot overrule shipped code.

`PRODUCT.md` began as the Studio product register. Its local-first rule still governs direct device work. Its sentence saying that no backend exists describes Studio's device path, not the whole repository. KINO Roll now has an API and storage stack.

## Document families

### Maintained guides

- `README.md`
- `docs/README.md`
- `docs/HARDWARE.md`
- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT.md`
- `docs/PROJECT.md`
- `docs/TROUBLESHOOTING.md`
- `docs/RELEASING.md`
- `docs/VERSIONING.md`
- `docs/FIRMWARE_BUILDER.md`
- `docs/TWIN_FIRMWARE_MODEL.md`
- `docs/TWIN_VIRTUAL_CAMERA.md`
- `docs/STUDIO_DEVICE_INTEGRATION.md`
- `docs/STUDIO_TWIN_ACCEPTANCE_TESTS.md`
- `CONTRIBUTING.md`
- `ROADMAP.md`
- `CHANGELOG.md`
- `SECURITY.md`
- `hardware/*`
- `LICENSE`, `LICENSES/*`, `REUSE.toml`, and `TRADEMARKS.md`
- `firmware-contract/*`
- `firmware/README.md`
- `apps/api/README.md`
- `docs/roll/*`

Update these when behavior changes.

### Product specifications

The files under `kino_dev_spec_pack/` describe the intended permanent platform. They include features that have not landed on the current branch. Preserve the distinction between a specified behavior and an implemented one.

### Twin specifications

The files under `kino_twin_spec/` contain the mechanical model, component manifest, source notes, and simulator handoff. Dimensions carry confidence labels. A provisional body size cannot become a measured fact through repetition.

### Historical plans

The files under `docs/superpowers/plans/` are dated work records. Keep them intact unless a link is broken. Write current instructions in a maintained guide instead of editing history into a new shape.

## Writing rules

Use the names KINO D4, KINO Studio, KINO Roll, KINO Twin, and KINO Device Protocol. Keep units attached to values. Use `µs`, `mm`, `V`, `A`, `mAh`, and `Wh` where they belong.

State whether a feature exists, is specified, or is provisional. Skip launch copy. Skip vague praise. A useful sentence names the part, the behavior, and the limit.
