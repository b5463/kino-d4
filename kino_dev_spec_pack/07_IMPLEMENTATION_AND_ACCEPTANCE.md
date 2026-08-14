# KINO Implementation + Acceptance Plan

## 1. Recommended monorepo

```text
kino/
├── apps/
│   ├── studio/
│   ├── roll-web/
│   ├── api/
│   └── worker/
├── packages/
│   ├── kdp/
│   ├── schemas/
│   ├── design-system/
│   ├── media/
│   └── test-fixtures/
├── firmware-contract/
├── infra/
└── docs/
```

Firmware may live elsewhere, but protocol/schema source must remain canonical/shared.

## 2. Phase 0 — contracts first

Before real firmware:
1. KDP framing;
2. HELLO retry/resync;
3. capability negotiation;
4. config schema version;
5. error model;
6. firmware manifest;
7. gallery pagination;
8. timing telemetry;
9. mock scenarios.

## 3. Phase 1 — Studio against mock

Build full Studio against a byte-faithful mock:
- connect;
- Overview;
- capabilities;
- config;
- Wiggle;
- Quad;
- Looks;
- Calibration;
- Skew Bench;
- Gallery;
- Updates;
- Build Mode;
- Developer;
- Roll provisioning.

Mock failure scenarios:
- boot garbage;
- unsupported command;
- corrupt frame;
- slow response;
- disconnect;
- failed update;
- node offline;
- 2,000+ captures.

## 4. Phase 2 — Roll backend

Build:
- host auth;
- device auth;
- Rolls;
- captures;
- assets;
- resumable upload;
- S3 storage;
- worker queue;
- SSE;
- host dashboard;
- guest PWA.

Use a test uploader before camera firmware exists.

## 5. Phase 3 — Studio ↔ backend

Add:
- device registration;
- firmware catalog;
- Wi-Fi/Roll config;
- Roll creation;
- host deep links.

USB device operations still work without backend login.

## 6. Phase 4 — real transport

When D4 hardware arrives:
- implement SerialDeviceTransport;
- use same KDP feature layer;
- firmware may implement only subset;
- capabilities prevent timeout storms.

## 7. Phase 5 — D4 bring-up

Order:
1. P4 connection;
2. one camera node;
3. four camera UARTs;
4. status;
5. one capture;
6. four capture;
7. parallel transfer;
8. SD;
9. common trigger;
10. VSYNC telemetry;
11. Skew Bench;
12. flash;
13. power tests;
14. Wi-Fi;
15. Roll queue.

## 8. Phase 6 — production updates

Implement:
- P4 OTA;
- camera-node OTA;
- P4 proxy update;
- checksum;
- compatibility;
- health check;
- rollback;
- recovery.

Do not make irreversible secure-boot choices until recovery is proven.

## 9. Phase 7 — production Roll

Implement:
- resumable device upload;
- preview-first queue;
- worker retries;
- live gallery;
- moderation;
- archive;
- export;
- backup;
- metrics.

## 10. Phase 8 — final visual pass

Apply KINO design system after IA/flows are stable.

## 11. Environments

```text
local
staging
production
```

Production:
- `kino.acronym.sk`.

Separate staging DB/object bucket/credentials.

## 12. CI

Every PR:
- TypeScript checks;
- lint;
- unit tests;
- KDP decoder tests;
- schema validation;
- API tests;
- upload tests;
- production builds.

## 13. Critical Studio transport acceptance

Decoder must pass:
- split frame;
- multiple frames/read;
- bad CRC;
- boot text;
- random bytes;
- wrong protocol;
- disconnect/reconnect;
- new session ID.

HELLO:
- retry;
- nonce;
- timeout;
- protocol negotiation.

## 14. Capability acceptance

Studio must:
- hide/disable unsupported feature;
- never long-timeout unsupported commands;
- tolerate unknown future capability fields;
- clearly show version mismatch.

## 15. Config acceptance

- schema version exists;
- revision exists;
- migration fixture exists;
- old backup imports;
- conflict handling defined.

## 16. Gallery acceptance

Test:
- 0;
- 60;
- 2,000;
- 10,000 metadata rows.

Require:
- pagination;
- virtualization;
- lazy assets;
- no browser lockup.

## 17. Firmware update acceptance

Test:
- normal P4;
- normal node;
- CAM3 failure;
- disconnect mid-update;
- bad checksum;
- wrong hardware package;
- reboot failure;
- rollback;
- reconnect.

## 18. D4 synchronization acceptance

Report separately:

```text
GPIO distribution skew
VSYNC phase skew
effective exposure skew
```

Bench over hundreds of triggers.
Report:
- mean;
- median;
- p95;
- max;
- distribution.

Bands:

```text
<0.5ms     excellent
0.5–1ms    very good
1–2ms      acceptable target
2–5ms      warning
5–10ms     poor
>10ms      fail intended synchronized use
```

Do not pass sync based only on GPIO ISR timing.

## 19. Moving-subject test

Use repeatable moving target.
Compare:
- unaligned sensor phase;
- re-phased sensor timing;
- flash/no flash.

Determine whether motion disparity overwhelms intended parallax.

## 20. Flash acceptance

Distances:
- 0.8m;
- 1m;
- 1.5m;
- 2m;
- 3m.

Check:
- clipping;
- rolling-shutter bands;
- cross-camera consistency;
- thermal;
- voltage sag;
- resets.

If power issue occurs, flash reduction is first mitigation.

## 21. Power acceptance

Measure:
- idle;
- display;
- 4 cameras awake;
- 4 capture;
- flash + capture;
- transfer;
- Wi-Fi upload.

Test SW6106 low-load shutdown behavior in sleep/idle.

## 22. UART acceptance

Stress:
- 921600;
- 1.5M;
- 2M;
- 3M;

All four concurrently.

Final baud = highest stable error-free rate on real harness.

## 23. Roll queue acceptance

Test:
- online;
- Wi-Fi loss;
- DNS failure;
- server down;
- camera reboot;
- duplicate retry;
- partial asset;
- closed Roll;
- token expiry.

Expected:
- capture never blocked;
- SD source of truth;
- queue resumes;
- no duplicates.

## 24. Roll live feed acceptance

Test:
- 1 viewer;
- 10 viewers;
- 50 viewers;
- reconnect;
- mobile sleep/wake;
- SSE retry;
- hide/delete;
- derivative appears later.

## 25. Permissions acceptance

Guest must not:
- delete;
- moderate;
- access host UI;
- bypass download restrictions.

Device token must not:
- host-moderate;
- enumerate unrelated Rolls.

## 26. Worker acceptance

Every derivative job:
- idempotent;
- retryable;
- independent.

MP4 failure must not destroy/disable originals/thumbs.
AI failure must not affect normal assets.

## 27. Backup acceptance

Perform actual restore drill:
- DB restore;
- object restore;
- captures/assets relink correctly.

## 28. Browser acceptance

Studio:
- current Chrome desktop;
- current Edge desktop.

Roll:
- current iOS Safari;
- current Android Chrome;
- major desktop browsers.

## 29. Accessibility acceptance

Require:
- keyboard;
- focus;
- labels;
- contrast;
- reduced motion;
- screen-reader status;
- no color-only status semantics.

## 30. Final definition of done

Do not call product done because happy path works.

Done includes:
- recovery;
- migrations;
- backups;
- resumable uploads;
- unsupported-command behavior;
- hardware mismatch;
- large gallery;
- flaky serial;
- flaky Wi-Fi;
- partial capture;
- failed derivative jobs;
- firmware rollback.
