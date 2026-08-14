# KINO Backend + Data Specification

## 1. Hosting

Self-hosted under:

```text
https://kino.acronym.sk
```

Recommended service layout:

```text
reverse proxy / TLS
  │
  ├── web
  ├── API
  ├── worker
  ├── PostgreSQL
  ├── Redis
  └── S3-compatible object storage
```

Use object storage from day one, preferably MinIO or compatible self-hosted S3.

## 2. Suggested containers

```text
kino-web
kino-api
kino-worker
kino-postgres
kino-redis
kino-object-storage
kino-proxy
```

Optional later:
- AI worker;
- dedicated video worker;
- observability stack.

## 3. Routes

```text
/                  KINO entry
/studio            Studio
/r/:slug            Roll guest
/host              host dashboard
/api/...            API
```

## 4. API domains

### Device API
Camera upload, Roll assignment, queue status.

### Guest API
Read visible Roll/capture/asset metadata.

### Host API
Moderation, Roll management, exports.

### Studio/account API
Device registration, firmware catalog, optional profile sync.

### Internal worker API
Job state/processing.

## 5. PostgreSQL

Store:
- accounts/hosts;
- devices;
- registrations;
- Rolls;
- captures;
- assets metadata;
- upload sessions;
- reactions/favorites;
- processing jobs;
- firmware releases;
- moderation/audit events.

Do not store media blobs in Postgres.

## 6. Object storage

Store:
- originals;
- thumbnails;
- KINO stills;
- WebP wiggles;
- MP4;
- GIF;
- contact sheets;
- recap exports;
- optional AI derivatives;
- firmware packages.

Example object keys:

```text
rolls/<roll-id>/captures/<capture-id>/original/cam-01.jpg
rolls/<roll-id>/captures/<capture-id>/derived/thumb.webp
rolls/<roll-id>/captures/<capture-id>/derived/wiggle.webp
```

Object key is not authorization.

## 7. Redis

Use for:
- job queue;
- SSE fanout;
- short-lived caches;
- rate limits;
- dedupe locks.

## 8. Resumable upload

Large assets:
1. create upload session;
2. upload parts;
3. validate part/checksum;
4. finalize;
5. mark asset complete.

Capture state examples:

```text
created
preview-ready
originals-uploading
complete
processing
ready
partial
failed
```

## 9. Idempotency

Camera generates capture UUID.

Use idempotency keys to avoid duplicate retries.

Example:

```text
Idempotency-Key: <capture-uuid>:<asset-role>:<frame-index>
```

## 10. Real-time

Use SSE initially.

Flow:

```text
device upload complete
  ↓
API records asset
  ↓
publish capture.updated
  ↓
SSE subscribers
  ↓
PWA fetches new/updated capture
```

## 11. Workers

Jobs:
- thumbnail;
- gallery still;
- wiggle WebP;
- wiggle MP4;
- contact sheet;
- metadata;
- recap;
- AI enhancement.

Jobs must be:
- idempotent;
- retryable;
- independent.

## 12. Authentication

### Device
Per-device credential provisioned in Studio.

Device scope:
- upload as itself;
- operate on allowed Rolls;
- no host admin.

### Host
Secure account/session or equivalent host token.

### Guest
Anonymous default.

## 13. Security

- HTTPS;
- secure cookies;
- CSRF protection;
- rate limiting;
- MIME/type validation;
- checksum validation;
- no arbitrary storage paths from client;
- never log Wi-Fi password/token secrets;
- no Wi-Fi credentials sent to backend.

## 14. Roll slug

Random, unguessable public slug.

Example:

```text
7F3K9Q
```

Internal DB ID is separate.

## 15. Firmware catalog

Backend can host:
- stable/beta/dev release metadata;
- compatible hardware;
- protocol range;
- manifest;
- checksum;
- release notes.

## 16. Backups

Minimum:
- scheduled PostgreSQL dump;
- object storage snapshot/replication;
- off-host copy;
- actual restore drill.

## 17. Observability

Track:
- request latency;
- API errors;
- upload failures;
- queue depth;
- worker failures;
- object usage;
- disk usage;
- SSE connections;
- active devices.

Use structured logs and request/job IDs.

## 18. Scaling

Design for:
- many Rolls;
- thousands of captures per Roll;
- future 12 MP cameras;
- multiple cameras per Roll;
- multiple KINO models;
- simultaneous viewers.

## 19. Core schemas

### Device

```json
{
  "schema": "kino.device",
  "version": 1,
  "id": "dev_01",
  "serial": "KD4-00001",
  "product": "KINO D4",
  "hardwareRevision": "D4-V1",
  "name": "House Camera"
}
```

### Device capabilities

```json
{
  "schema": "kino.device-capabilities",
  "version": 1,
  "cameraCount": 4,
  "cameraSensor": "OV3660",
  "maxResolution": "2048x1536",
  "syncMethod": "vsync-assisted",
  "features": {
    "wiggle": true,
    "quad": true,
    "rollUpload": true,
    "vsyncTelemetry": true
  }
}
```

### Roll

```json
{
  "schema": "kino.roll",
  "version": 1,
  "id": "roll_01",
  "slug": "7F3K9Q",
  "title": "Friday House Party",
  "status": "live",
  "privacy": "unlisted",
  "downloadsEnabled": true
}
```

### Capture

```json
{
  "schema": "kino.capture",
  "version": 1,
  "id": "cap_0042",
  "captureUuid": "b96c...",
  "rollId": "roll_01",
  "deviceId": "dev_01",
  "mode": "wiggle",
  "look": "party-neg",
  "capturedAt": "2026-08-14T23:42:18+02:00",
  "frameCount": 4,
  "resolution": "1600x1200",
  "timing": {
    "gpioTriggerSkewUs": 140,
    "vsyncPhaseSkewUs": 1200,
    "effectiveExposureSkewUs": null
  },
  "status": "ready",
  "visible": true
}
```

### Asset

```json
{
  "schema": "kino.asset",
  "version": 1,
  "id": "asset_01",
  "captureId": "cap_0042",
  "role": "wiggle-preview",
  "mime": "image/webp",
  "width": 1280,
  "height": 960,
  "bytes": 412032,
  "sha256": "...",
  "status": "ready"
}
```

Asset roles:

```text
thumb
kino-still
original-frame
wiggle-preview
wiggle-webp
wiggle-mp4
gif
contact-sheet
enhanced-still
enhanced-wiggle
metadata
```

### Firmware manifest

```json
{
  "schema": "kino.firmware-manifest",
  "version": 1,
  "release": "0.6.1",
  "channel": "stable",
  "compatibleHardware": ["D4-V1"],
  "protocolMin": 1,
  "protocolMax": 1,
  "targets": {
    "main": {
      "version": "0.6.1",
      "file": "p4-app.bin",
      "sha256": "..."
    },
    "cameraNode": {
      "version": "0.6.1",
      "file": "xiao-app.bin",
      "sha256": "..."
    }
  }
}
```

## 20. Schema rules

Every breaking schema change increments version and includes migration logic.
Do not infer schema solely from app version.
