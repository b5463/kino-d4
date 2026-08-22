import { useState } from 'react';
import { Cmd } from '@kino/kdp';
import type {
  CameraLinkStats,
  CameraTestResult,
  HwValidationReport,
  SoakTestSummary,
  StorageBenchResult,
  StorageSelfTestResult,
} from '@kino/kdp';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Unsupported } from '../../components/Unsupported';
import { useDeviceStore } from '../../state/deviceStore';
import { getDevice } from '../../app/session';
import { benchStamp, putBenchResult, useBenchResult } from '../../state/benchResults';
import type { BenchEntry } from '../../state/benchResults';
import { downloadText } from '../../utils/download';

/**
 * Milestone 1B bench diagnostics (issue #66): storage self-test, CAM1 link
 * counters, one measured test capture, and the CAM1 soak loop. Everything
 * here is device-reported; the timing buckets are wall-clock stage times,
 * never exposure or sync figures. Gated on `benchDiagnostics === true` — the
 * flag is optional, so its absence means pre-1B firmware, not "assume yes".
 */
/**
 * One STORAGE_BENCH result. Prop-driven so the readout can be asserted
 * without a device or a store, and because the rule it encodes is worth
 * pinning: **the worst block leads the line**. A four-frame burst stalls on
 * its slowest block, so an average is the one figure that cannot tell you
 * whether the burst drops a frame.
 */
export function StorageBenchReadout({ entry }: { entry: BenchEntry<StorageBenchResult> | null }) {
  if (!entry) return null;
  const stamp = benchStamp(entry);
  const r = entry.result;
  return (
    <p className="dim" style={{ marginTop: 6 }}>
      <strong>WORST BLOCK {r.worstBlockMs} ms</strong> · p95 {r.p95BlockMs} ms · write {r.writeMBs} MB/s ·
      read {r.readMBs} MB/s · {r.bytes} B written
      {stamp ? <span className={stamp.stale ? 'warn' : 'dim'}> · {stamp.text}</span> : null}
    </p>
  );
}

export function BenchDiagnosticsPanel() {
  const state = useDeviceStore();
  const hasBench = state.capabilities?.benchDiagnostics === true;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selfTest, setSelfTest] = useState<StorageSelfTestResult | null>(null);
  const [stats, setStats] = useState<CameraLinkStats | null>(null);
  const [capture, setCapture] = useState<CameraTestResult | null>(null);
  const [hw, setHw] = useState<HwValidationReport | null>(null);
  const [soakCaptures, setSoakCaptures] = useState(100);
  const [soakDelayMs, setSoakDelayMs] = useState(1000);
  const [soakProgress, setSoakProgress] = useState<string | null>(null);
  const [soak, setSoak] = useState<SoakTestSummary | null>(null);
  const [benchSizeMB, setBenchSizeMB] = useState(16);
  const [benchBlockKB, setBenchBlockKB] = useState(64);
  const [benchPasses, setBenchPasses] = useState(1);
  const storageBench = useBenchResult<StorageBenchResult>('storage');

  async function run(label: string, action: () => Promise<void>) {
    const dev = getDevice();
    if (!dev || busy) return;
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runSoak() {
    const dev = getDevice();
    if (!dev) return;
    setSoak(null);
    setSoakProgress('starting…');
    const handle = await dev.client.startJob<SoakTestSummary>(Cmd.CAMERA_SOAK_TEST, {
      cam: 'cam1',
      captures: soakCaptures,
      delayMs: soakDelayMs,
    });
    for await (const p of handle.progress) {
      setSoakProgress(p.message ?? `${Math.round((p.progress ?? 0) * 100)}%`);
    }
    setSoak(await handle.result);
    setSoakProgress(null);
  }

  function exportSoak() {
    if (!soak) return;
    downloadText(
      `cam1-soak-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`,
      JSON.stringify({ kind: 'kino-cam1-soak', summary: soak }, null, 2),
    );
  }

  if (!hasBench) {
    return (
      <Panel title="BENCH DIAGNOSTICS">
        <Unsupported
          feature="Bench diagnostics"
          firmware={state.firmwareLabel}
          note="Storage self-test, link stats, and the soak loop arrive with Milestone 1B firmware."
        />
      </Panel>
    );
  }

  const ms = (v: number) => `${v} ms`;

  return (
    <Panel
      title="BENCH DIAGNOSTICS"
      actions={
        <>
          <Button size="sm" busy={busy === 'selftest'} onClick={() => void run('selftest', async () => {
            setSelfTest(await getDevice()!.storageSelfTest());
          })}>
            SD SELF TEST
          </Button>
          <Button size="sm" busy={busy === 'stats'} onClick={() => void run('stats', async () => {
            setStats(await getDevice()!.cameraLinkStats('cam1'));
          })}>
            LINK STATS
          </Button>
          <Button size="sm" busy={busy === 'capture'} onClick={() => void run('capture', async () => {
            const result = await getDevice()!.cameraTest('cam1');
            setCapture(result.timing ? (result as CameraTestResult) : null);
            if (!result.timing) setError('Firmware answered the pre-1B CAMERA_TEST shape.');
          })}>
            CAM1 TEST CAPTURE
          </Button>
          <Button size="sm" busy={busy === 'hw'} onClick={() => void run('hw', async () => {
            setHw(await getDevice()!.getHwValidation());
          })}>
            HW VALIDATION
          </Button>
        </>
      }
    >
      {error ? <p className="warn">{error}</p> : null}

      {selfTest ? (
        <p className={selfTest.ok ? 'dim' : 'warn'}>
          SD SELF TEST {selfTest.ok ? 'PASS' : `FAIL — ${selfTest.failedPhase}`} ·{' '}
          {selfTest.bytesTested} bytes · {ms(selfTest.durationMs)}
        </p>
      ) : null}

      {stats ? (
        <p className="dim">
          CAM1 LINK {stats.connected ? 'UP' : 'DOWN'} @ {stats.baud} · rx {stats.rxFrames} frames /{' '}
          {stats.rxBytes} B · tx {stats.txFrames} frames · crc {stats.crcErrors} · resyncs{' '}
          {stats.decoderResyncs} · timeouts {stats.timeouts} · dup {stats.duplicateFrames} · node boot{' '}
          {stats.lastNodeBootReason ?? '—'} · last error {stats.lastError ?? '—'}{' '}
          <Button size="sm" onClick={() => void run('reset', async () => {
            await getDevice()!.resetCameraLinkStats('cam1');
            setStats(await getDevice()!.cameraLinkStats('cam1'));
          })}>
            RESET
          </Button>
        </p>
      ) : null}

      {capture ? (
        <p className="dim">
          CAPTURE {capture.captureId} · {capture.jpegBytes} B · node {ms(capture.timing.captureCommandToJpegReadyMs)} ·
          transfer {ms(capture.timing.jpegTransferMs)} · sd {ms(capture.timing.sdWriteMs)} · total{' '}
          {ms(capture.timing.totalMs)} · checksums {capture.checksums.match ? 'MATCH' : 'MISMATCH'} ({capture.checksums.storedFileCrc32}) ·
          node heap {capture.memory.nodeHeapKB ?? '—'} KB
        </p>
      ) : null}

      {hw ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr><th>ITEM</th><th>STATUS</th><th>EVIDENCE</th></tr>
            </thead>
            <tbody>
              {hw.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.id}</td>
                  <td className={item.status === 'validated' ? undefined : 'warn'}>{item.status.toUpperCase()}</td>
                  <td className="dim">{item.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim">P4 reset reason: {hw.p4ResetReason}. VALIDATED means this unit did it, not that a header file says so.</p>
        </div>
      ) : null}

      {/* STORAGE BENCH is the throughput question, separate from SD SELF TEST
          above, which only answers whether the card works at all. */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <span className="microlabel">STORAGE BENCH</span>
        <label>
          SIZE (MB){' '}
          <input type="number" min={1} max={512} value={benchSizeMB}
            onChange={(e) => setBenchSizeMB(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <label>
          BLOCK (KB){' '}
          <input type="number" min={4} max={4096} step={4} value={benchBlockKB}
            onChange={(e) => setBenchBlockKB(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <label>
          PASSES{' '}
          <input type="number" min={1} max={16} value={benchPasses}
            onChange={(e) => setBenchPasses(Number(e.target.value))} style={{ width: 60 }} />
        </label>
        <Button size="sm" busy={busy === 'storagebench'} onClick={() => void run('storagebench', async () => {
          const result = await getDevice()!.storageBench({
            sizeMB: benchSizeMB,
            blockKB: benchBlockKB,
            passes: benchPasses,
          });
          putBenchResult('storage', result);
        })}>
          RUN STORAGE BENCH
        </Button>
      </div>

      <StorageBenchReadout entry={storageBench} />

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <label>
          SOAK CAPTURES{' '}
          <input type="number" min={1} max={1000} value={soakCaptures}
            onChange={(e) => setSoakCaptures(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <label>
          DELAY (ms){' '}
          <input type="number" min={100} max={60000} step={100} value={soakDelayMs}
            onChange={(e) => setSoakDelayMs(Number(e.target.value))} style={{ width: 80 }} />
        </label>
        <Button size="sm" busy={soakProgress !== null} onClick={() => void run('soak', runSoak)}>
          RUN CAM1 SOAK
        </Button>
        {soak ? (
          <Button size="sm" onClick={exportSoak}>EXPORT</Button>
        ) : null}
        {soakProgress ? <span className="dim">{soakProgress}</span> : null}
      </div>

      {soak ? (
        <p className={soak.failed === 0 ? 'dim' : 'warn'} style={{ marginTop: 6 }}>
          SOAK {soak.successful}/{soak.attempted} OK · {soak.failed} failed · crc {soak.crcErrors} · timeouts{' '}
          {soak.timeouts} · node resets {soak.nodeResets} · sd {soak.sdErrors} · jpeg{' '}
          {soak.minJpegBytes ?? '—'}–{soak.maxJpegBytes ?? '—'} B (avg {soak.avgJpegBytes ?? '—'}) · ready avg{' '}
          {soak.avgCaptureReadyMs ?? '—'} ms · transfer avg {soak.avgTransferMs ?? '—'} ms · sd avg{' '}
          {soak.avgSdWriteMs ?? '—'} ms · heap Δ {soak.heapDeltaKB} KB · psram Δ {soak.psramDeltaKB} KB
          {soak.heapDeltaKB < -8 ? ' — HEAP TRENDING DOWN, investigate before Milestone 2' : ''}
        </p>
      ) : null}
    </Panel>
  );
}
