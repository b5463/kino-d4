// UART link benchmark. Four channels stream concurrently — the V1 design
// transfers all four JPEGs at once into P4 PSRAM, so wall clock is the
// slowest channel, not the sum. Walk the baud ladder and adopt the fastest
// rate where every channel is error-free.

import { useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { Unsupported } from '../../components/Unsupported';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { getDevice, refreshAll } from '../../app/session';
import { useDeviceStore, supports } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import {
  benchStamp,
  clearBenchResult,
  invalidateBench,
  putBenchResult,
  useBenchResult,
} from '../../state/benchResults';
import type { LinkBenchResult } from '../../protocol/types';
import { downloadJson } from '../../utils/download';

const LADDER = [921600, 1500000, 2000000, 3000000];

const OWNER = 'link';
const LABEL = 'UART LINK';

/**
 * Frame size used for the 4-FRAME SET estimate when nothing has been captured
 * yet. It is the V1 nominal JPEG, not a measurement, and the panel says so —
 * real captures on this device have measured 306–554 KB.
 */
const NOMINAL_FRAME_KB = 380;

function baudLabel(baud: number): string {
  return baud >= 1_000_000 ? `${(baud / 1_000_000).toFixed(baud % 1_000_000 ? 1 : 0)}M` : `${baud / 1000}k`;
}

export function LinkBenchPanel() {
  const state = useDeviceStore();
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [rung, setRung] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingAdopt, setPendingAdopt] = useState<number | null>(null);
  const [adoptingBaud, setAdoptingBaud] = useState<number | null>(null);
  const blockedBy = useBlockedBy(OWNER);

  // The ladder survives navigation, together with the EXPORT that saves it.
  const entry = useBenchResult<LinkBenchResult[]>(OWNER);
  const results = entry?.result ?? [];
  const stamp = benchStamp(entry);

  const hasBench = supports(state, 'linkBench');
  const maxBaud = state.limits?.maxUartBaud ?? 3_000_000;
  const rungs = LADDER.filter((b) => b <= maxBaud);
  const currentBaud = state.limits?.currentUartBaud ?? 921600;

  // The set time is an estimate sitting in a table of measurements, so the
  // frame size behind it is derived where possible and named either way.
  const measuredJpegKB = state.cameras
    .map((c) => c.lastCapture?.jpegKB)
    .filter((v): v is number => typeof v === 'number');
  const frameKB = measuredJpegKB.length ? Math.max(...measuredJpegKB) : NOMINAL_FRAME_KB;
  const frameSource = measuredJpegKB.length
    ? 'the largest of the four last-capture JPEGs'
    : 'the V1 nominal frame — nothing captured yet this session';
  const streamKB = results.length ? Math.round(results[0].channels[0].bytes / 1024) : 256;

  const runLadder = async () => {
    const dev = getDevice();
    if (!dev || running) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setRunning(true);
    setError(null);
    clearBenchResult(OWNER);
    const collected: LinkBenchResult[] = [];
    try {
      let i = 0;
      for (const baud of rungs) {
        i += 1;
        setRung(i);
        setCurrent(baud);
        const r = await dev.linkBench(baud);
        collected.push(r);
        putBenchResult<LinkBenchResult[]>(OWNER, [...collected]);
        // A dirty rate means everything above it is dirty too.
        if (!r.clean) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDevice(OWNER);
      setRunning(false);
      setCurrent(null);
      setRung(0);
    }
  };

  const adopt = async (baud: number) => {
    const dev = getDevice();
    if (!dev) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setAdoptingBaud(baud);
    setError(null);
    try {
      await dev.setLinkBaud(baud);
      // Every transfer rate and command latency measured before this was
      // measured on a different link.
      invalidateBench(
        ['burnin', 'conformance'],
        `the camera UART moved to ${baudLabel(baud)} after this run`,
      );
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDevice(OWNER);
      setAdoptingBaud(null);
    }
  };

  const fastestClean = [...results].reverse().find((r) => r.clean);

  if (!hasBench) {
    return (
      <Panel title="UART LINK">
        <Unsupported
          feature="Link benchmark"
          firmware={state.firmwareLabel}
          note="Camera UART stays at the compiled-in rate."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="UART LINK"
      actions={
        <>
          {results.length > 0 && !running && entry ? (
            <Button
              size="sm"
              onClick={() =>
                downloadJson(`kino-linkbench-${state.info?.serial ?? 'unknown'}-${Date.now()}.json`, {
                  device: state.info?.serial,
                  ranAt: new Date(entry.ranAt).toISOString(),
                  staleReason: entry.staleReason,
                  frameKB,
                  frameSource,
                  results,
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
            onClick={() => void runLadder()}
          >
            RUN BAUD LADDER
          </Button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 2 }}>
        Streams {streamKB} KB per channel concurrently at each rate. Stops at the first rate with
        CRC or framing errors.
      </p>
      <p className="dim" style={{ marginBottom: 6 }}>
        Current link: <span className="val">{baudLabel(currentBaud)}</span>.
      </p>
      {/* Which rung is on the wire belongs in a status line, not in the
          button's label. */}
      <p className="val" role="status" style={{ padding: '2px 0 6px', minHeight: 18 }}>
        {running
          ? `RUNNING ${rung}/${rungs.length} · ${baudLabel(current ?? 0)}`
          : adoptingBaud !== null
            ? `SWITCHING LINK TO ${baudLabel(adoptingBaud)}…`
            : blockedBy
              ? `${blockedBy} is running.`
              : ''}
      </p>

      {results.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>BAUD</th>
                <th>RESULT</th>
                {/* This column is the slowest of the four channels, not a
                    per-channel average. It printed Math.min unlabelled. */}
                <th className="num">
                  SLOWEST CHANNEL (<span style={{ textTransform: 'none' }}>KB/s</span>)
                </th>
                <th className="num">
                  4-FRAME SET (<span style={{ textTransform: 'none' }}>s</span>)
                </th>
                <th className="num">CRC ERR</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const slowest = Math.min(...r.channels.map((c) => c.kbytesPerSec));
                const crc = r.channels.reduce((a, c) => a + c.crcErrors + c.framingErrors, 0);
                // Concurrent: a 4-frame set lands in the time of one channel.
                const setSeconds = frameKB / slowest;
                return (
                  <tr key={r.baud}>
                    <td>{baudLabel(r.baud)}</td>
                    <td>
                      <Led state={r.clean ? 'ok' : 'err'} label={r.clean ? 'CLEAN' : 'ERRORS'} />
                    </td>
                    {/* A rung with errors gets no throughput and no set time.
                        The bytes did not arrive intact, so the derived numbers
                        were the most attractive figures in the table and they
                        belonged to the rate you must not adopt. */}
                    <td className="num">{r.clean ? slowest : '—'}</td>
                    <td className="num">{r.clean ? setSeconds.toFixed(1) : '—'}</td>
                    <td className="num">{crc}</td>
                    <td className="num">
                      {r.clean && r.baud !== currentBaud ? (
                        <Button
                          size="sm"
                          busy={adoptingBaud === r.baud}
                          disabled={running || blockedBy !== null}
                          title={blockedBy ? `${blockedBy} is running` : undefined}
                          onClick={() => setPendingAdopt(r.baud)}
                        >
                          ADOPT
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {results.length > 0 ? (
        <>
          <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
            4-FRAME SET = {frameKB} KB ÷ the slowest channel. {frameKB} KB is {frameSource}.
          </p>
          <p className="spark-minmax" style={{ display: 'block' }}>
            Throughput here is a {streamKB} KB continuous stream per channel. BURN-IN reads 3 × 8 KB
            media chunks with a round-trip each and reports a lower rate at the same baud.
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

      {fastestClean ? (
        <p className="notice notice--ok" style={{ marginTop: 8, marginBottom: 0 }}>
          Fastest clean rate: <strong>{baudLabel(fastestClean.baud)}</strong>
          {/* Device truth, not a local flag: coming back to the page used to
              lose the "adopted" state while the link was already switched. */}
          {currentBaud === fastestClean.baud
            ? ' — adopted.'
            : ' — adopt it to shorten the shot cycle.'}
        </p>
      ) : null}
      {results.length > 0 && !fastestClean ? (
        <p className="notice notice--err" style={{ marginTop: 8, marginBottom: 0 }}>
          No clean rate found. Check harness length, grounding and routing before raising baud.
        </p>
      ) : null}
      {error ? <p className="notice notice--err" style={{ marginTop: 8 }}>{error}</p> : null}

      <ConfirmDialog
        open={pendingAdopt !== null}
        danger
        title="ADOPT UART BAUD"
        confirmLabel={pendingAdopt !== null ? `ADOPT ${baudLabel(pendingAdopt)}` : 'ADOPT'}
        onCancel={() => setPendingAdopt(null)}
        onConfirm={() => {
          const baud = pendingAdopt;
          setPendingAdopt(null);
          if (baud !== null) void adopt(baud);
        }}
      >
        <p>
          Switches the live camera UART from {baudLabel(currentBaud)} to{' '}
          {pendingAdopt !== null ? baudLabel(pendingAdopt) : ''} on all four channels.
        </p>
        <p>
          There is no automatic rollback. If the link does not come back at the new rate, the
          cameras stop answering until you power-cycle KINO, which restores{' '}
          {baudLabel(currentBaud)}.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
