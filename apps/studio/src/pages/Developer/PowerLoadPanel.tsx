// Power-load bench: drive a ladder of real device activity and read the
// battery back through GET_POWER_STATUS at every rung, against what the Twin's
// power model predicts for the same activity.
//
// The point of the panel is the divergence column. An estimate that has never
// been held against a measurement is a guess with a table around it, so every
// row prints ESTIMATED, MEASURED and the gap, and a rung the device did not
// answer for prints NOT MEASURED instead of a zero.

import { useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Sparkline } from '../../components/Sparkline';
import { Unsupported } from '../../components/Unsupported';
import { getDevice } from '../../app/session';
import { useDeviceStore, supports } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import {
  benchStamp,
  clearBenchResult,
  putBenchResult,
  useBenchResult,
} from '../../state/benchResults';
import { D4_V1 } from '@kino/hardware-profiles';
import type { FlashLevel } from '@kino/kdp';
import type { KinoDevice } from '../../device/KinoDevice';
import {
  buildPowerLoadSeries,
  powerLoadRungs,
  worstDivergence,
  type PowerRung,
  type PowerRungSamples,
} from '../../developer/powerLoad';
import { downloadJson } from '../../utils/download';

const OWNER = 'power';
const LABEL = 'POWER LOAD';

/** How often the poll loop asks for a new battery reading while a rung runs. */
const POLL_MS = 150;

/** The idle rung has no drive command, so it is sampled for a fixed window. */
const IDLE_WINDOW_MS = 1200;

/** Flash rungs fire at the mid distance band — the ladder is about current, not exposure. */
const FLASH_DISTANCE = '1-2' as const;

const FLASH_LEVELS: FlashLevel[] = ['low', 'medium', 'high'];

// The real 1S Li-ion working range, the same fixed axis BURN-IN uses. An
// autoscaled voltage chart turns a 0.05 V step into a cliff.
const CELL_MIN_V = 3.3;
const CELL_MAX_V = 4.2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run one rung's drive command while polling GET_POWER_STATUS.
 *
 * The link is a single request/response channel with one outstanding command,
 * so these polls do not overlap the drive command on the wire — they land in
 * whatever gaps it leaves. That is why a short rung can come back with one
 * sample and why the reported figure is the deepest sag rather than an
 * average: the samples are opportunistic, not a regular timebase.
 */
async function driveRung(
  dev: KinoDevice,
  id: PowerRungSamples['id'],
  drive: () => Promise<unknown>,
): Promise<PowerRungSamples> {
  const batteryV: number[] = [];
  const busV: number[] = [];
  let error: string | null = null;
  let done = false;

  const activity = drive()
    .catch((err) => {
      error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      done = true;
    });

  const poll = (async () => {
    while (!done) {
      try {
        const status = await dev.getPowerStatus();
        batteryV.push(status.batteryV);
        if (typeof status.busV === 'number') busV.push(status.busV);
      } catch {
        // A refused power read is not this rung's result. Stop polling and
        // let the row report however many samples did arrive.
        break;
      }
      await sleep(POLL_MS);
    }
  })();

  await activity;
  await poll;
  return { id, batteryV, busV, error };
}

export function PowerLoadPanel() {
  const state = useDeviceStore();
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const blockedBy = useBlockedBy(OWNER);

  const entry = useBenchResult<PowerRungSamples[]>(OWNER);
  const collected = entry?.result ?? [];
  const stamp = benchStamp(entry);

  const hasQuad = supports(state, 'quad');
  const hasFlash = supports(state, 'flashControl');
  const hasLink = supports(state, 'linkBench');

  const rungs: PowerRung[] = powerLoadRungs({
    flash: hasFlash ? FLASH_LEVELS : [],
    uart: hasLink,
  });
  const rows = buildPowerLoadSeries(D4_V1.power, rungs, collected);
  const worst = worstDivergence(rows);
  const measuredCurve = collected.flatMap((s) => s.batteryV);

  const run = async () => {
    const dev = getDevice();
    if (!dev || running) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setRunning(true);
    setError(null);
    clearBenchResult(OWNER);

    const samples: PowerRungSamples[] = [];
    try {
      for (const rung of rungs) {
        setStage(rung.label);
        const drive = driveCommand(dev, rung, state.limits?.currentUartBaud ?? 921600);
        samples.push(await driveRung(dev, rung.id, drive));
        putBenchResult<PowerRungSamples[]>(OWNER, [...samples]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDevice(OWNER);
      setRunning(false);
      setStage('');
    }
  };

  if (!hasQuad) {
    return (
      <Panel title="POWER LOAD">
        <Unsupported
          feature="Power-load bench"
          firmware={state.firmwareLabel}
          note="The ladder is built on the synchronized quad capture. Without it there is no load to measure."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="POWER LOAD"
      actions={
        <>
          {rows.length > 0 && collected.length > 0 && !running && entry ? (
            <Button
              size="sm"
              onClick={() =>
                downloadJson(`kino-powerload-${state.info?.serial ?? 'unknown'}-${Date.now()}.json`, {
                  device: state.info?.serial,
                  p4Firmware: state.info?.p4Firmware,
                  ranAt: new Date(entry.ranAt).toISOString(),
                  staleReason: entry.staleReason,
                  model: 'computePower / @kino/simulator-engine against D4_V1.power',
                  rows,
                })
              }
            >
              EXPORT
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
            RUN LOAD LADDER
          </Button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 2 }}>
        Drives {rungs.length} rungs of real activity and polls GET_POWER_STATUS through each one.
        ESTIMATED is computePower against the D4 power profile; MEASURED is this device's ADC.
      </p>
      <p className="dim" style={{ marginBottom: 6 }}>
        The comparison is battery volts. GET_POWER_STATUS reports no current, so the estimated amps
        are shown as the model input behind the predicted voltage, not as something measured.
      </p>
      {!hasFlash ? (
        <p className="dim" style={{ marginBottom: 6 }}>
          No flash control on this firmware — the flash rungs are not in the ladder.
        </p>
      ) : null}
      {!hasLink ? (
        <p className="dim" style={{ marginBottom: 6 }}>
          No link benchmark on this firmware — the UART transfer rung is not in the ladder.
        </p>
      ) : null}
      <p className="val" role="status" style={{ padding: '2px 0 6px', minHeight: 18 }}>
        {running ? `RUNNING · ${stage}` : blockedBy ? `${blockedBy} is running.` : ''}
      </p>

      {collected.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>RUNG</th>
                <th>DRIVEN BY</th>
                <th className="num">
                  EST BUS (<span style={{ textTransform: 'none' }}>A</span>)
                </th>
                <th className="num">
                  EST BATTERY (<span style={{ textTransform: 'none' }}>A</span>)
                </th>
                <th className="num">
                  ESTIMATED (<span style={{ textTransform: 'none' }}>V</span>)
                </th>
                <th className="num">
                  MEASURED MIN (<span style={{ textTransform: 'none' }}>V</span>)
                </th>
                <th className="num">
                  DIVERGENCE (<span style={{ textTransform: 'none' }}>V</span>)
                </th>
                <th className="num">DIVERGENCE %</th>
                <th className="num">SAMPLES</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td className="dim">{row.command}</td>
                  <td className="num">{row.estimated.busA.toFixed(2)}</td>
                  <td className="num">{row.estimated.batteryA.toFixed(2)}</td>
                  <td className="num">{row.estimated.batteryV.toFixed(3)}</td>
                  {/* A rung the device never answered for gets no number in
                      any measured column. Zero would read as a dead rail. */}
                  <td className="num">
                    {row.measured ? row.measured.minBatteryV.toFixed(3) : 'NOT MEASURED'}
                  </td>
                  <td className={row.divergenceV === null ? 'num' : 'num val'}>
                    {row.divergenceV === null
                      ? '—'
                      : `${row.divergenceV >= 0 ? '+' : ''}${row.divergenceV.toFixed(3)}`}
                  </td>
                  <td className="num">
                    {row.divergencePct === null
                      ? '—'
                      : `${row.divergencePct >= 0 ? '+' : ''}${row.divergencePct.toFixed(1)}`}
                  </td>
                  <td className="num">{row.measured ? row.measured.samples : 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {measuredCurve.length > 1 ? (
        <div className="panel-grid" style={{ marginTop: 8 }}>
          <Sparkline
            label="MEASURED BATTERY OVER LADDER"
            unit="V"
            values={measuredCurve}
            format={(v) => v.toFixed(2)}
            color="#48a83e"
            yMin={CELL_MIN_V}
            yMax={CELL_MAX_V}
          />
        </div>
      ) : null}

      {rows.some((row) => row.error) ? (
        <p className="notice notice--warn" style={{ marginTop: 8 }}>
          {rows
            .filter((row) => row.error)
            .map((row) => `${row.label}: ${row.error}`)
            .join(' · ')}
        </p>
      ) : null}

      {worst ? (
        <p className="val" style={{ marginTop: 8 }}>
          WORST DIVERGENCE {worst.divergenceV !== null && worst.divergenceV >= 0 ? '+' : ''}
          {worst.divergenceV?.toFixed(3)} V AT {worst.label}
        </p>
      ) : null}
      {collected.length > 0 && !worst ? (
        <p className="notice notice--err" style={{ marginTop: 8, marginBottom: 0 }}>
          No rung was measured. The device answered no power reads during the run, so there is
          nothing to hold the model against.
        </p>
      ) : null}

      {collected.length > 0 ? (
        <>
          <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
            DIVERGENCE is MEASURED MIN minus ESTIMATED. Negative means the pack sagged deeper than
            the model predicted. The estimate assumes an 80 % state of charge and an ESTIMATED
            0.08 Ω internal resistance — until the bench measures that cell, part of every gap here
            belongs to the profile, not to the firmware.
          </p>
          {stamp ? (
            <p
              className={stamp.stale ? 'notice notice--warn' : 'spark-minmax'}
              style={{ display: 'block', marginTop: 6, marginBottom: 0 }}
            >
              {stamp.text}
            </p>
          ) : null}
        </>
      ) : null}
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}
    </Panel>
  );
}

/** The existing command each rung is driven with. No rung adds a new one. */
function driveCommand(dev: KinoDevice, rung: PowerRung, uartBaud: number): () => Promise<unknown> {
  switch (rung.id) {
    case 'idle':
      return () => sleep(IDLE_WINDOW_MS);
    case 'preview':
      return () => dev.previewFrame('cam2');
    case 'quad':
      return () => dev.timingTest();
    case 'flash-low':
      return () => dev.flashTest({ level: 'low', distance: FLASH_DISTANCE });
    case 'flash-medium':
      return () => dev.flashTest({ level: 'medium', distance: FLASH_DISTANCE });
    case 'flash-high':
      return () => dev.flashTest({ level: 'high', distance: FLASH_DISTANCE });
    case 'uart':
      // The live rate, not a ladder rung: this measures the load of a transfer
      // on the link as configured, not the cost of switching baud.
      return () => dev.linkBench(uartBaud);
  }
}
