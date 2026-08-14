import { describe, it, expect } from 'vitest';
import {
  parseVersioned,
  SchemaTooNewError,
  deviceInfo,
  deviceCapabilities,
  deviceConfig,
  capture,
  asset,
  roll,
  firmwareManifest,
  ASSET_ROLES,
  CAPTURE_MODES,
  ROLL_STATUSES,
  CAPTURE_STATUSES,
  type SchemaDef,
} from '../src/index';

// ---------------------------------------------------------------------------
// Enum contents (01§2, 03§12, 03§22, 05§8, 05§19)
// ---------------------------------------------------------------------------

describe('enumerations', () => {
  it('lists the asset roles from 05§19 in spec order', () => {
    expect(ASSET_ROLES).toEqual([
      'thumb',
      'kino-still',
      'original-frame',
      'wiggle-preview',
      'wiggle-webp',
      'wiggle-mp4',
      'gif',
      'contact-sheet',
      'enhanced-still',
      'enhanced-wiggle',
      'metadata',
    ]);
  });

  it('lists the initial capture modes from 03§12', () => {
    expect(CAPTURE_MODES).toEqual(['wiggle', 'quad', 'single']);
  });

  it('lists the roll states from 03§22', () => {
    expect(ROLL_STATUSES).toEqual(['draft', 'live', 'closed', 'archived', 'trash']);
  });

  it('lists the capture states from 05§8', () => {
    expect(CAPTURE_STATUSES).toEqual([
      'created',
      'preview-ready',
      'originals-uploading',
      'complete',
      'processing',
      'ready',
      'partial',
      'failed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Spec example documents (the exact JSON from the spec pack)
// ---------------------------------------------------------------------------

const deviceInfoExample = {
  // 05§19 "Device". The schema NAME is kino.device-info per 01§3; 05§19 prints
  // "kino.device", a spec inconsistency recorded in the Task 5 report.
  schema: 'kino.device-info',
  version: 1,
  id: 'dev_01',
  serial: 'KD4-00001',
  product: 'KINO D4',
  hardwareRevision: 'D4-V1',
  name: 'House Camera',
};

const capabilitiesExample = {
  // 05§19 "Device capabilities"
  schema: 'kino.device-capabilities',
  version: 1,
  cameraCount: 4,
  cameraSensor: 'OV3660',
  maxResolution: '2048x1536',
  syncMethod: 'vsync-assisted',
  features: {
    wiggle: true,
    quad: true,
    rollUpload: true,
    vsyncTelemetry: true,
  },
};

const deviceConfigExample = {
  // 02§28 config versioning
  schema: 'kino.device-config',
  version: 1,
  revision: 7,
  config: {
    mode: 'wiggle',
    resolution: '1600x1200',
    flash: 'auto',
  },
};

const rollExample = {
  // 05§19 "Roll"
  schema: 'kino.roll',
  version: 1,
  id: 'roll_01',
  slug: '7F3K9Q',
  title: 'Friday House Party',
  status: 'live',
  privacy: 'unlisted',
  downloadsEnabled: true,
};

const captureExample = {
  // 05§19 "Capture" (captureUuid expanded to a full UUID)
  schema: 'kino.capture',
  version: 1,
  id: 'cap_0042',
  captureUuid: 'b96c1111-0000-4000-8000-000000000000',
  rollId: 'roll_01',
  deviceId: 'dev_01',
  mode: 'wiggle',
  look: 'party-neg',
  capturedAt: '2026-08-14T23:42:18+02:00',
  frameCount: 4,
  resolution: '1600x1200',
  timing: {
    gpioTriggerSkewUs: 140,
    vsyncPhaseSkewUs: 1200,
    effectiveExposureSkewUs: null,
  },
  status: 'ready',
  visible: true,
};

const assetExample = {
  // 05§19 "Asset" (sha256 expanded to a real 64-hex digest)
  schema: 'kino.asset',
  version: 1,
  id: 'asset_01',
  captureId: 'cap_0042',
  role: 'wiggle-preview',
  mime: 'image/webp',
  width: 1280,
  height: 960,
  bytes: 412032,
  sha256: 'c'.repeat(64),
  status: 'ready',
};

const firmwareManifestExample = {
  // 04§12 firmware manifest (sha256 digests expanded)
  schema: 'kino.firmware-manifest',
  version: 1,
  release: '0.6.1',
  protocolMin: 1,
  protocolMax: 1,
  compatibleHardware: ['D4-V1'],
  targets: {
    main: { file: 'p4-app.bin', sha256: 'a'.repeat(64) },
    cameraNode: { file: 'xiao-app.bin', sha256: 'b'.repeat(64) },
  },
  updateOrder: ['cameraNode', 'main'],
};

// ---------------------------------------------------------------------------
// One `it` per schema, parsing the exact spec example
// ---------------------------------------------------------------------------

describe('kino.device-info', () => {
  it('parses the spec example device (05§19)', () => {
    const out = parseVersioned(deviceInfo, deviceInfoExample);
    expect(out.id).toBe('dev_01');
    expect(out.serial).toBe('KD4-00001');
    expect(out.hardwareRevision).toBe('D4-V1');
    expect(out.name).toBe('House Camera');
  });

  it('accepts a device with no user-assigned name', () => {
    const { name: _name, ...unnamed } = deviceInfoExample;
    expect(parseVersioned(deviceInfo, unnamed).name).toBeUndefined();
  });
});

describe('kino.device-capabilities', () => {
  it('parses the spec example capabilities (05§19)', () => {
    const out = parseVersioned(deviceCapabilities, capabilitiesExample);
    expect(out.cameraCount).toBe(4);
    expect(out.features.wiggle).toBe(true);
    expect(out.syncMethod).toBe('vsync-assisted');
  });

  it('parses the 01§2 D4 V1 capability report without a fixed camera count', () => {
    const out = parseVersioned(deviceCapabilities, {
      schema: 'kino.device-capabilities',
      version: 1,
      product: 'KINO D4',
      hardwareRevision: 'D4-V1',
      cameraCount: 4,
      cameraSensor: 'OV3660',
      maxResolution: '2048x1536',
      syncMethod: 'vsync-assisted',
      cameraTransport: 'uart',
      storage: ['microsd'],
      network: ['wifi'],
      display: true,
      speaker: true,
    });
    expect(out.cameraCount).toBe(4);
    expect(out.maxResolution).toBe('2048x1536');
  });

  it('accepts a future device reporting a different camera count and sync method (01§2)', () => {
    const out = parseVersioned(deviceCapabilities, {
      schema: 'kino.device-capabilities',
      version: 1,
      cameraCount: 12,
      cameraSensor: 'IMX999',
      maxResolution: '4056x3040',
      syncMethod: 'hardware',
      cameraTransport: 'mipi',
      features: { wiggle: true, burst: true },
    });
    expect(out.cameraCount).toBe(12);
    expect(out.syncMethod).toBe('hardware');
  });

  it('tolerates unknown future capability fields (07§14)', () => {
    const doc = {
      schema: 'kino.device-capabilities',
      version: 1,
      cameraCount: 4,
      features: { wiggle: true, futureThing: true },
      limits: { maxResolution: '2048x1536' },
      someFutureTopLevelField: 'x',
    };
    expect(parseVersioned(deviceCapabilities, doc).cameraCount).toBe(4);
  });

  it('tolerates non-boolean values inside features (07§14)', () => {
    const out = parseVersioned(deviceCapabilities, {
      schema: 'kino.device-capabilities',
      version: 1,
      cameraCount: 4,
      features: { wiggle: true, videoModes: ['1080p30', '720p60'], maxBurst: 8 },
    });
    expect(out.features.wiggle).toBe(true);
    expect(out.features.maxBurst).toBe(8);
  });

  it('tolerates unknown fields inside nested capability objects (07§14)', () => {
    const out = parseVersioned(deviceCapabilities, {
      schema: 'kino.device-capabilities',
      version: 1,
      cameraCount: 4,
      limits: { maxResolution: '2048x1536', maxFutureThing: 3 },
    });
    expect(out.limits?.maxFutureThing).toBe(3);
  });

  it('still rejects a document that is missing cameraCount', () => {
    expect(() =>
      parseVersioned(deviceCapabilities, { schema: 'kino.device-capabilities', version: 1 }),
    ).toThrow();
  });
});

describe('kino.device-config', () => {
  it('parses the spec example config (02§28)', () => {
    const out = parseVersioned(deviceConfig, deviceConfigExample);
    expect(out.revision).toBe(7);
    expect(out.config.mode).toBe('wiggle');
    expect(out.config.resolution).toBe('1600x1200');
    expect(out.config.flash).toBe('auto');
  });

  it('preserves nested config sections it does not model (04§8)', () => {
    const out = parseVersioned(deviceConfig, {
      schema: 'kino.device-config',
      version: 1,
      revision: 12,
      config: {
        mode: 'wiggle',
        resolution: '1600x1200',
        flash: 'auto',
        wiggle: { fps: 10, direction: 'ltr', loop: 'bounce' },
      },
    });
    expect(out.config.wiggle).toEqual({ fps: 10, direction: 'ltr', loop: 'bounce' });
  });

  it('rejects a malformed resolution', () => {
    expect(() =>
      parseVersioned(deviceConfig, {
        ...deviceConfigExample,
        config: { ...deviceConfigExample.config, resolution: '1600 by 1200' },
      }),
    ).toThrow();
  });
});

describe('kino.roll', () => {
  it('parses the spec example roll (05§19)', () => {
    const out = parseVersioned(roll, rollExample);
    expect(out.slug).toBe('7F3K9Q');
    expect(out.status).toBe('live');
    expect(out.privacy).toBe('unlisted');
    expect(out.downloadsEnabled).toBe(true);
  });

  it('accepts every roll state from 03§22', () => {
    for (const status of ROLL_STATUSES) {
      expect(parseVersioned(roll, { ...rollExample, status }).status).toBe(status);
    }
  });

  it('rejects an unknown roll state', () => {
    expect(() => parseVersioned(roll, { ...rollExample, status: 'exploded' })).toThrow();
  });
});

describe('kino.capture', () => {
  it('parses the spec example capture with null effective exposure skew (05§19, 04§13)', () => {
    const out = parseVersioned(capture, captureExample);
    expect(out.timing?.effectiveExposureSkewUs).toBeNull();
    expect(out.timing?.gpioTriggerSkewUs).toBe(140);
    expect(out.timing?.vsyncPhaseSkewUs).toBe(1200);
  });

  it('carries an unavailableReason when timing is not measurable (04§13)', () => {
    const out = parseVersioned(capture, {
      ...captureExample,
      timing: {
        gpioTriggerSkewUs: null,
        vsyncPhaseSkewUs: null,
        effectiveExposureSkewUs: null,
        unavailableReason: 'firmware does not report VSYNC telemetry',
      },
    });
    expect(out.timing?.unavailableReason).toBe('firmware does not report VSYNC telemetry');
    expect(out.timing?.gpioTriggerSkewUs).toBeNull();
  });

  it('omits timing entirely when the device reported none', () => {
    const { timing: _timing, ...noTiming } = captureExample;
    expect(parseVersioned(capture, noTiming).timing).toBeUndefined();
  });

  it('does not hard-code a 4-frame media model (03§12)', () => {
    expect(parseVersioned(capture, { ...captureExample, mode: 'single', frameCount: 1 }).frameCount).toBe(1);
    expect(parseVersioned(capture, { ...captureExample, frameCount: 12 }).frameCount).toBe(12);
  });

  it('rejects a non-positive or fractional frameCount', () => {
    expect(() => parseVersioned(capture, { ...captureExample, frameCount: 0 })).toThrow();
    expect(() => parseVersioned(capture, { ...captureExample, frameCount: 2.5 })).toThrow();
  });

  it('rejects a malformed resolution', () => {
    expect(() => parseVersioned(capture, { ...captureExample, resolution: '1600*1200' })).toThrow();
  });

  it('accepts every capture state from 05§8', () => {
    for (const status of CAPTURE_STATUSES) {
      expect(parseVersioned(capture, { ...captureExample, status }).status).toBe(status);
    }
  });

  it('defaults visible to true when the field is absent', () => {
    const { visible: _visible, ...noVisible } = captureExample;
    const out = parseVersioned(capture, noVisible);
    const visible: boolean = out.visible;
    expect(visible).toBe(true);
  });

  it('accepts a capture not yet assigned to a roll', () => {
    expect(parseVersioned(capture, { ...captureExample, rollId: null }).rollId).toBeNull();
  });
});

describe('kino.asset', () => {
  it('parses the spec example asset (05§19)', () => {
    const out = parseVersioned(asset, assetExample);
    expect(out.role).toBe('wiggle-preview');
    expect(out.bytes).toBe(412032);
    expect(out.mime).toBe('image/webp');
  });

  it('accepts every asset role from 05§19', () => {
    for (const role of ASSET_ROLES) {
      expect(parseVersioned(asset, { ...assetExample, role }).role).toBe(role);
    }
  });

  it('rejects an unknown asset role', () => {
    expect(() => parseVersioned(asset, { ...assetExample, role: 'hologram' })).toThrow();
  });

  it('rejects a sha256 that is not a 64-char lowercase hex digest', () => {
    expect(() => parseVersioned(asset, { ...assetExample, sha256: 'abc' })).toThrow();
    expect(() => parseVersioned(asset, { ...assetExample, sha256: 'C'.repeat(64) })).toThrow();
  });

  it('accepts a non-image asset with no pixel dimensions', () => {
    const { width: _w, height: _h, ...metadataAsset } = assetExample;
    const out = parseVersioned(asset, { ...metadataAsset, role: 'metadata', mime: 'application/json' });
    expect(out.width).toBeUndefined();
  });
});

describe('kino.firmware-manifest', () => {
  it('parses the firmware manifest example (04§12)', () => {
    const out = parseVersioned(firmwareManifest, firmwareManifestExample);
    expect(out.release).toBe('0.6.1');
    expect(out.targets.main?.file).toBe('p4-app.bin');
    expect(out.updateOrder).toEqual(['cameraNode', 'main']);
  });

  it('parses the catalog manifest example with channel and per-target versions (05§19)', () => {
    const out = parseVersioned(firmwareManifest, {
      schema: 'kino.firmware-manifest',
      version: 1,
      release: '0.6.1',
      channel: 'stable',
      compatibleHardware: ['D4-V1'],
      protocolMin: 1,
      protocolMax: 1,
      targets: {
        main: { version: '0.6.1', file: 'p4-app.bin', sha256: 'a'.repeat(64) },
        cameraNode: { version: '0.6.1', file: 'xiao-app.bin', sha256: 'b'.repeat(64) },
      },
    });
    expect(out.targets.cameraNode?.version).toBe('0.6.1');
    expect(out.updateOrder).toBeUndefined();
  });

  it('accepts an unknown future target name (targets is an open record)', () => {
    const out = parseVersioned(firmwareManifest, {
      ...firmwareManifestExample,
      targets: {
        ...firmwareManifestExample.targets,
        coprocessor: { file: 'copro.bin', sha256: 'd'.repeat(64) },
      },
      updateOrder: ['coprocessor', 'cameraNode', 'main'],
    });
    expect(out.targets.coprocessor?.file).toBe('copro.bin');
  });

  it('rejects a target with a malformed sha256', () => {
    expect(() =>
      parseVersioned(firmwareManifest, {
        ...firmwareManifestExample,
        targets: { main: { file: 'p4-app.bin', sha256: 'not-a-digest' } },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migration fixtures — one per schema. At v1 `migrations` is `{}` and a v1
// document migrates to itself; the fixture asserts the wiring exists so a
// future v2 has a proven path (01§3, 05§20).
// ---------------------------------------------------------------------------

const migrationFixtures: Array<[string, SchemaDef<{ schema: string; version: number }>, unknown]> = [
  ['kino.device-info', deviceInfo, deviceInfoExample],
  ['kino.device-capabilities', deviceCapabilities, capabilitiesExample],
  ['kino.device-config', deviceConfig, deviceConfigExample],
  ['kino.roll', roll, rollExample],
  ['kino.capture', capture, captureExample],
  ['kino.asset', asset, assetExample],
  ['kino.firmware-manifest', firmwareManifest, firmwareManifestExample],
];

describe('migration wiring', () => {
  for (const [name, def, example] of migrationFixtures) {
    it(`${name} is registered at version 1 with a migration table`, () => {
      expect(def.schema).toBe(name);
      expect(def.version).toBe(1);
      expect(def.migrations).toEqual({});
    });

    it(`${name} accepts a version 1 document through parseVersioned`, () => {
      const out = parseVersioned(def, example);
      expect(out.schema).toBe(name);
      expect(out.version).toBe(1);
    });

    it(`${name} rejects a document from a newer schema version`, () => {
      expect(() =>
        parseVersioned(def, { ...(example as Record<string, unknown>), version: 2 }),
      ).toThrow(SchemaTooNewError);
    });

    it(`${name} rejects a document carrying a different schema name`, () => {
      expect(() =>
        parseVersioned(def, { ...(example as Record<string, unknown>), schema: 'kino.something-else' }),
      ).toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// Unknown-future-field tolerance across portable documents (07§14)
// ---------------------------------------------------------------------------

describe('unknown future fields on portable documents (07§14)', () => {
  for (const [name, def, example] of migrationFixtures) {
    it(`${name} keeps parsing when a future field is added`, () => {
      const out = parseVersioned(def, {
        ...(example as Record<string, unknown>),
        someFutureTopLevelField: { added: 'in a later release' },
      });
      expect(out.version).toBe(1);
    });
  }
});
