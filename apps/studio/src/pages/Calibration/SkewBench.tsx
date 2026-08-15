// Skew Bench — 02 §10's first-class surface.
//
// Three metrics, three sections, never one collapsed "sync score". A metric
// the device could not measure prints the device's reason and no numbers
// (04 §13); it does not print zero, and it does not blank the other two.
//
// The Developer page keeps its own raw timing views. This is the product one:
// it grades against 02 §10's band table wording, not kdp's `gradeSkew`.

import { useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { SegField } from '../../components/fields';
import { Unsupported } from '../../components/Unsupported';
import { Cmd, KinoUnsupportedError } from '@kino/kdp';
import { getDevice } from '../../app/session';
import { useDeviceStore } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import {
  benchStamp,
  clearBenchResult,
  putBenchResult,
  useBenchResult,
} from '../../state/benchResults';
import { openSection } from '../../state/navRequest';
import {
  consumeSkewBenchJob,
  formatDistribution,
  formatOffsetMs,
  formatSpreadMs,
  SKEW_BANDS,
  SKEW_BAND_ORDER,
} from '../../skew/skewReport';
import type { SkewMetricReport, SkewReport, SyncBenchJobResult } from '../../skew/skewReport';

const OWNER = 'skew';
const LABEL = 'SKEW BENCH';

/**
 * 07 §18 wants hundreds of triggers for a verdict, so 250 is the default.
 * 25 is a look before you commit two minutes; 1000 is the soak that finds the
 * one trigger in a thousand that misses a frame.
 */
const RUN_SIZES = [
  { value: '25', label: '25 QUICK' },
  { value: '250', label: '250 BENCH' },
  { value: '1000', label: '1000 SOAK' },
];

/** One metric section. Exported so the display can be tested without a device. */
export function SkewMetricCard({ metric, order }: { metric: SkewMetricReport; order?: number }) {
  const band = metric.band ? SKEW_BANDS[metric.band] : null;
  const worst = metric.worstBand ? SKEW_BANDS[metric.worstBand] : null;
  return (
    <section
      className={`skew-metric${band ? ` skew-metric--${band.state}` : ''}`}
      data-metric={metric.metric}
    >
      <span className="microlabel">
        {order ? `${order} · ` : ''}
        {metric.title}
      </span>

      {/* One test, not three. A metric is either fully measured or it prints
          its reason — there is no half-measured state where a `?? 0` could
          put an unmeasured 0.00ms on screen. */}
      {metric.unavailableReason !== null || metric.spreadUs === null || band === null ? (
        <p className="skew-none">
          NOT MEASURABLE — {metric.unavailableReason ?? 'the device reported no figures'}
        </p>
      ) : (
        <>
          <dl className="skew-rows">
            {metric.cameras.map((row) => (
              <div key={row.cam} className="skew-row">
                <dt>{row.label}</dt>
                <dd>{formatOffsetMs(row.offsetUs)}</dd>
              </div>
            ))}
            <div className="skew-row skew-row--spread">
              <dt>Spread</dt>
              <dd>{formatSpreadMs(metric.spreadUs)}</dd>
            </div>
          </dl>

          <p className={`skew-band skew-band--${band.state}`}>
            <span className="skew-lamp" aria-hidden="true">
              {band.lamp}
            </span>
            {band.label}
            <span className="dim" style={{ textTransform: 'none' }}>
              {' '}
              {band.range}
            </span>
          </p>

          {metric.distribution ? (
            <p className="spark-minmax skew-line">{formatDistribution(metric.distribution)}</p>
          ) : null}

          {/* The rows above are per-camera means, which cancel run-to-run
              jitter. When the worst 5 % of single triggers land in a worse
              band, that is the whole point of running 250 of them. */}
          {worst ? (
            <p className="spark-minmax skew-line skew-line--worst">
              worst 5% of triggers {worst.lamp} {worst.label}
            </p>
          ) : null}
        </>
      )}

      <p className="spark-minmax skew-line" style={{ textTransform: 'none' }}>
        {metric.note}
      </p>
    </section>
  );
}

/** Whole-run display. Exported for the same reason as the card above. */
export function SkewReportView({ report }: { report: SkewReport }) {
  const short = report.triggers > 0 && report.triggers < report.requestedTriggers;
  return (
    <>
      <p className="val" style={{ paddingTop: 4 }}>
        {report.triggers} TRIGGERS · {report.cameras.length} CAMERAS
        {report.frameIntervalUs !== null
          ? ` · FRAME INTERVAL ${formatSpreadMs(report.frameIntervalUs)}`
          : ''}
      </p>
      {short ? (
        <p className="spark-minmax" style={{ display: 'block' }}>
          Asked for {report.requestedTriggers}. The device returned {report.triggers} and everything
          below counts those.
        </p>
      ) : null}

      <div className="skew-metrics">
        {report.metrics.map((metric, i) => (
          <SkewMetricCard key={metric.metric} metric={metric} order={i + 1} />
        ))}
      </div>

      <p className="spark-minmax" style={{ display: 'block', textTransform: 'none' }}>
        Camera rows are that camera's mean over the run, relative to the earliest. The distribution
        line is each trigger's own spread.
      </p>
      <p className="spark-minmax" style={{ display: 'block', textTransform: 'none' }}>
        {SKEW_BAND_ORDER.map((b) => `${SKEW_BANDS[b].range} ${SKEW_BANDS[b].label}`).join(' · ')}
      </p>
    </>
  );
}

/**
 * The metric a one-line verdict should quote: effective exposure decides the
 * photograph, VSYNC phase decides which frame, GPIO decides nothing on its
 * own. Whichever is quoted, the readout names it.
 */
function verdictMetric(report: SkewReport): (SkewMetricReport & { spreadUs: number }) | null {
  for (const metric of ['exposure', 'vsync', 'gpio'] as const) {
    const found = report.metrics.find((m) => m.metric === metric);
    if (found && found.band && found.spreadUs !== null) {
      return found as SkewMetricReport & { spreadUs: number };
    }
  }
  return null;
}

/**
 * Latest verdict, for a status surface that did not measure it. Always names
 * the metric and when it was measured — two panels printing contradictory
 * verdicts with no timestamps is the failure this store exists to prevent.
 */
export function SkewVerdict() {
  const entry = useBenchResult<SkewReport>(OWNER);
  const stamp = benchStamp(entry);
  const report = entry?.result ?? null;
  const metric = report ? verdictMetric(report) : null;
  const band = metric?.band ? SKEW_BANDS[metric.band] : null;

  const open = (
    <Button size="sm" onClick={() => openSection('calibration', 'skew')}>
      {report ? 'OPEN SKEW BENCH' : 'RUN SKEW BENCH'}
    </Button>
  );

  if (!report) {
    return (
      <div className="skew-verdict">
        <p className="dim">
          Sensor sync has not been measured on this camera. GPIO skew in the camera strip is trigger
          distribution, not exposure alignment.
        </p>
        {open}
      </div>
    );
  }

  return (
    <div className="skew-verdict">
      {band && metric ? (
        <>
          <p className={`skew-band skew-band--${band.state}`}>
            <span className="skew-lamp" aria-hidden="true">
              {band.lamp}
            </span>
            {band.label}
          </p>
          <p className="val">
            {metric.title} SPREAD {formatSpreadMs(metric.spreadUs)}
          </p>
        </>
      ) : (
        <p className="skew-none">
          NOT MEASURABLE —{' '}
          {report.metrics.find((m) => m.unavailableReason !== null)?.unavailableReason ??
            'the run reported no timing metric'}
        </p>
      )}
      <p className="spark-minmax" style={{ display: 'block' }}>
        {report.triggers} TRIGGERS
        {stamp ? ` · ${stamp.text}` : ''}
      </p>
      {open}
    </div>
  );
}

export function SkewBench() {
  const firmwareLabel = useDeviceStore((s) => s.firmwareLabel);
  const [triggers, setTriggers] = useState(250);
  const [phase, setPhase] = useState<'idle' | 'running' | 'stopping'>('idle');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  // A ref, not state: `consumeSkewBenchJob` polls this from inside an await
  // loop that never re-renders, so a state value would stay at its captured
  // value forever and CANCEL would do nothing.
  const stopRef = useRef(false);
  const blockedBy = useBlockedBy(OWNER);

  const entry = useBenchResult<SkewReport>(OWNER);
  const report = entry?.result ?? null;
  const stamp = benchStamp(entry);
  const running = phase !== 'idle';

  const run = async () => {
    const client = getDevice()?.client;
    if (!client || running) return;
    if (!claimDevice(OWNER, LABEL)) return;
    stopRef.current = false;
    setError(null);
    setUnsupported(false);
    setCancelled(false);
    setPhase('running');
    setProgress({ done: 0, total: triggers });
    clearBenchResult(OWNER);
    try {
      const handle = await client.startJob<SyncBenchJobResult>(Cmd.SYNC_BENCH, { triggers });
      const result = await consumeSkewBenchJob(handle, {
        requestedTriggers: triggers,
        onProgress: (p) => setProgress({ done: p.done, total: p.total }),
        stopped: () => stopRef.current,
      });
      if (result) putBenchResult<SkewReport>(OWNER, result);
      else setCancelled(true);
    } catch (err) {
      if (err instanceof KinoUnsupportedError) setUnsupported(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDevice(OWNER);
      setPhase('idle');
      setProgress(null);
    }
  };

  const cancel = () => {
    if (phase !== 'running') return;
    stopRef.current = true;
    setPhase('stopping');
  };

  const status = () => {
    if (phase === 'stopping') return 'Stopping after current trigger…';
    if (phase === 'running' && progress) {
      return `RUNNING ${progress.done}/${progress.total} TRIGGERS`;
    }
    if (blockedBy) return `${blockedBy} is running.`;
    if (cancelled) return 'Run cancelled. Nothing was recorded.';
    return '';
  };

  return (
    <Panel
      title="SKEW BENCH"
      actions={
        <>
          {phase === 'running' ? (
            <Button size="sm" onClick={cancel}>
              CANCEL
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            busy={running}
            disabled={!running && blockedBy !== null}
            title={blockedBy ? `${blockedBy} is running` : undefined}
            onClick={() => void run()}
          >
            RUN {triggers} TRIGGERS
          </Button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 2 }}>
        Fires the trigger N times and reports where each sensor actually was. Three metrics, kept
        apart — the shared trigger edge is a reference, not proof of synchronized exposure.
      </p>

      <SegField
        label="RUN SIZE"
        value={String(triggers)}
        options={RUN_SIZES}
        disabled={running}
        onChange={(v) => setTriggers(Number(v))}
        hint="250 is the verdict run. 1000 finds the trigger in a thousand that misses a frame."
      />

      <p className="val" role="status" style={{ padding: '6px 0', minHeight: 18 }}>
        {status()}
      </p>

      {phase === 'stopping' ? (
        <p className="spark-minmax" style={{ display: 'block', textTransform: 'none' }}>
          The protocol has no cancel command. The camera finishes the triggers it started; Studio
          stops listening and records nothing.
        </p>
      ) : null}

      {unsupported ? (
        <Unsupported
          feature="Skew Bench"
          firmware={firmwareLabel}
          note="This build does not answer SYNC_BENCH, so sensor timing cannot be measured from Studio."
        />
      ) : null}

      {report ? <SkewReportView report={report} /> : null}

      {report && stamp ? (
        <p
          className={stamp.stale ? 'notice notice--warn' : 'spark-minmax'}
          style={{ display: 'block', marginTop: 6, marginBottom: 0 }}
        >
          {stamp.text}
        </p>
      ) : null}

      {error ? (
        <p className="notice notice--err" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
