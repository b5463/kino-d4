// Milestone 1B bench diagnostics (issue #66): STORAGE_SELF_TEST,
// CAMERA_LINK_STATS(_RESET), CAMERA_SOAK_TEST, GET_HW_VALIDATION, the
// extended CAMERA_TEST/GET_STORAGE_STATUS payloads, and the benchDiagnostics
// capability gate.
import { afterEach, describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type {
  CameraLinkStats,
  CameraTestResult,
  CapabilitiesResponse,
  HwValidationReport,
  SoakTestSummary,
  StorageSelfTestResult,
  StorageStatus,
} from '@kino/kdp';
import { MockKinoDevice } from '../src/index';

let transport: MockTransport | null = null;

async function connect(seed = 7) {
  const mock = new MockKinoDevice({ seed, ambientCaptures: false });
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  return { mock, client };
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

describe('capability gate', () => {
  it('advertises benchDiagnostics and answers the group', async () => {
    const { client } = await connect();
    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.benchDiagnostics).toBe(true);
    const report = await client.request<HwValidationReport>(Cmd.GET_HW_VALIDATION);
    expect(report.items).toHaveLength(16);
  });

  it('legacy firmware neither advertises nor answers', async () => {
    const { mock, client } = await connect();
    mock.setScenario('legacyFirmware', true);
    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.benchDiagnostics).toBe(false);
    await expect(client.request(Cmd.STORAGE_SELF_TEST)).rejects.toThrow(/not implemented/i);
    await expect(client.request(Cmd.GET_HW_VALIDATION)).rejects.toThrow(/not implemented/i);
  });
});

describe('storage diagnostics', () => {
  it('extends GET_STORAGE_STATUS with the 1B fields', async () => {
    const { client } = await connect();
    const status = await client.request<StorageStatus>(Cmd.GET_STORAGE_STATUS);
    expect(status.present).toBe(true);
    expect(status.mounted).toBe(true);
    expect(status.filesystem).toBe('FAT');
    expect(status.capacityBytes).toBeGreaterThan(0);
    expect(status.lastError).toBeNull();
    expect(status.mountAttempts).toBeGreaterThanOrEqual(1);
    expect(status.writeTestStatus).toBe('none');
  });

  it('self-test passes on a healthy card and updates writeTestStatus', async () => {
    const { client } = await connect();
    const result = await client.request<StorageSelfTestResult>(Cmd.STORAGE_SELF_TEST);
    expect(result.ok).toBe(true);
    expect(result.failedPhase).toBeNull();
    expect(result.bytesTested).toBe(65536);
    const status = await client.request<StorageStatus>(Cmd.GET_STORAGE_STATUS);
    expect(status.writeTestStatus).toBe('pass');
  });

  it('reports the exact failing phase', async () => {
    const { mock, client } = await connect();
    mock.setScenario('sdMissing', true);
    const result = await client.request<StorageSelfTestResult>(Cmd.STORAGE_SELF_TEST);
    expect(result.ok).toBe(false);
    expect(result.failedPhase).toBe('MOUNT_FAILED');
    mock.setScenario('sdMissing', false);
    mock.setScenario('sdFull', true);
    const full = await client.request<StorageSelfTestResult>(Cmd.STORAGE_SELF_TEST);
    expect(full.failedPhase).toBe('WRITE_FAILED');
  });
});

describe('camera link stats', () => {
  it('counts traffic from diagnostic captures and resets on request', async () => {
    const { client } = await connect();
    await client.request<CameraTestResult>(Cmd.CAMERA_TEST, { cam: 'cam1' }, 5000);
    const stats = await client.request<CameraLinkStats>(Cmd.CAMERA_LINK_STATS, { cam: 'cam1' });
    expect(stats.cam).toBe('cam1');
    expect(stats.baud).toBe(921600);
    expect(stats.connected).toBe(true);
    expect(stats.txFrames).toBeGreaterThan(0);
    expect(stats.rxBytes).toBeGreaterThan(100_000);
    expect(stats.crcErrors).toBe(0);
    expect(stats.lastNodeBootReason).toBe('power-on');

    await client.request(Cmd.CAMERA_LINK_STATS_RESET, { cam: 'cam1' });
    const after = await client.request<CameraLinkStats>(Cmd.CAMERA_LINK_STATS, { cam: 'cam1' });
    expect(after.rxBytes).toBe(0);
    expect(after.txFrames).toBe(0);
    expect(after.lastSequence).toBe(stats.lastSequence); // sequence survives a reset
  });

  it('accumulates crc errors under the crc-noise fault', async () => {
    const { mock, client } = await connect();
    mock.setCamFault('cam1', 'crc-noise');
    await expect(client.request(Cmd.CAMERA_TEST, { cam: 'cam1' }, 5000)).rejects.toThrow(/checksums/i);
    const stats = await client.request<CameraLinkStats>(Cmd.CAMERA_LINK_STATS, { cam: 'cam1' });
    expect(stats.crcErrors).toBeGreaterThan(0);
    expect(stats.lastError).toBe('TRANSFER_CRC_MISMATCH');
  });

  it('rejects an unknown camera id', async () => {
    const { client } = await connect();
    await expect(client.request(Cmd.CAMERA_LINK_STATS, { cam: 'cam9' })).rejects.toThrow(/cam1..cam4/);
  });
});

describe('CAMERA_TEST (1B shape)', () => {
  it('returns timing buckets, agreeing checksums, and memory stats', async () => {
    const { client } = await connect();
    const result = await client.request<CameraTestResult>(Cmd.CAMERA_TEST, { cam: 'cam1' }, 5000);
    expect(result.ok).toBe(true);
    expect(result.captureUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.jpegBytes).toBeGreaterThan(200_000);
    expect(result.timing.totalMs).toBe(
      result.timing.requestToNodeMs +
        result.timing.captureCommandToJpegReadyMs +
        result.timing.jpegTransferMs +
        result.timing.sdWriteMs,
    );
    expect(result.durationMs).toBe(result.timing.totalMs);
    expect(result.checksums.match).toBe(true);
    expect(result.checksums.nodeJpegCrc32).toBe(result.checksums.storedFileCrc32);
    expect(result.memory.nodeHeapKB).toBeGreaterThan(0);
  });

  it('NACKs SD_NOT_MOUNTED instead of pretending a capture landed', async () => {
    const { mock, client } = await connect();
    mock.setScenario('sdMissing', true);
    await expect(client.request(Cmd.CAMERA_TEST, { cam: 'cam1' }, 5000)).rejects.toThrow(/storage/i);
  });
});

describe('CAMERA_SOAK_TEST job', () => {
  it('runs N captures and reports a full summary', async () => {
    const { client } = await connect();
    const handle = await client.startJob<SoakTestSummary>(Cmd.CAMERA_SOAK_TEST, {
      cam: 'cam1',
      captures: 5,
      delayMs: 100,
    });
    let progressEvents = 0;
    for await (const p of handle.progress) {
      expect(p.progress).toBeGreaterThan(0);
      progressEvents++;
    }
    const summary = await handle.result;
    expect(progressEvents).toBeGreaterThanOrEqual(1);
    expect(summary.attempted).toBe(5);
    expect(summary.successful).toBe(5);
    expect(summary.failed).toBe(0);
    expect(summary.p4Resets).toBe(0);
    expect(summary.minJpegBytes).toBeGreaterThan(0);
    expect(summary.avgTransferMs).toBeGreaterThan(0);
    expect(summary.firstCaptureUuid).not.toBeNull();
    expect(summary.errors).toHaveLength(0);
  }, 10000);

  it('counts failures by code under a fault', async () => {
    const { mock, client } = await connect();
    mock.setCamFault('cam1', 'crc-noise');
    const handle = await client.startJob<SoakTestSummary>(Cmd.CAMERA_SOAK_TEST, {
      cam: 'cam1',
      captures: 3,
      delayMs: 100,
    });
    for await (const p of handle.progress) void p;
    const summary = await handle.result;
    expect(summary.successful).toBe(0);
    expect(summary.failed).toBe(3);
    expect(summary.crcErrors).toBe(3);
    expect(summary.errors).toEqual([{ code: 'TRANSFER_CRC_MISMATCH', count: 3 }]);
  }, 10000);

  it('surfaces the memory-leak scenario as a negative heap delta', async () => {
    const { mock, client } = await connect();
    mock.setScenario('memoryLeak', true);
    const handle = await client.startJob<SoakTestSummary>(Cmd.CAMERA_SOAK_TEST, {
      cam: 'cam1',
      captures: 4,
      delayMs: 100,
    });
    for await (const p of handle.progress) void p;
    const summary = await handle.result;
    expect(summary.heapDeltaKB).toBeLessThan(0);
  }, 10000);

  it('refuses to start while offline or without storage', async () => {
    const { mock, client } = await connect();
    mock.setCamFault('cam1', 'offline');
    await expect(client.startJob(Cmd.CAMERA_SOAK_TEST, { cam: 'cam1', captures: 2 })).rejects.toThrow(
      /did not answer/i,
    );
    mock.setCamFault('cam1', null);
    mock.setScenario('sdMissing', true);
    await expect(client.startJob(Cmd.CAMERA_SOAK_TEST, { cam: 'cam1', captures: 2 })).rejects.toThrow(
      /storage/i,
    );
  });
});

describe('hardware validation report', () => {
  it('reflects what the simulated unit has actually proven', async () => {
    const { client } = await connect();
    const before = await client.request<HwValidationReport>(Cmd.GET_HW_VALIDATION);
    const capture = (r: HwValidationReport) => r.items.find((i) => i.id === 'CAM1_CAPTURE')!;
    expect(capture(before).status).toBe('unvalidated');

    await client.request<CameraTestResult>(Cmd.CAMERA_TEST, { cam: 'cam1' }, 5000);
    const after = await client.request<HwValidationReport>(Cmd.GET_HW_VALIDATION);
    expect(capture(after).status).toBe('validated');
    expect(after.p4ResetReason).toBe('power-on');
  });

  it('marks SD items unvalidated with the card missing', async () => {
    const { mock, client } = await connect();
    mock.setScenario('sdMissing', true);
    const report = await client.request<HwValidationReport>(Cmd.GET_HW_VALIDATION);
    const sd = report.items.find((i) => i.id === 'SD_CLK_GPIO43')!;
    expect(sd.status).toBe('unvalidated');
  });
});
