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
import type { LinkBenchResult } from '../../protocol/types';
import { downloadJson } from '../../utils/download';

const LADDER = [921600, 1500000, 2000000, 3000000];

const OWNER = 'link';
const LABEL = 'UART LINK';

function baudLabel(baud: number): string {
  return baud >= 1_000_000 ? `${(baud / 1_000_000).toFixed(baud % 1_000_000 ? 1 : 0)}M` : `${baud / 1000}k`;
}

export function LinkBenchPanel() {
  const state = useDeviceStore();
  const [results, setResults] = useState<LinkBenchResult[]>([]);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [rung, setRung] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const [pendingAdopt, setPendingAdopt] = useState<number | null>(null);
  const [adoptingBaud, setAdoptingBaud] = useState<number | null>(null);
  const blockedBy = useBlockedBy(OWNER);

  const hasBench = supports(state, 'linkBench');
  const maxBaud = state.limits?.maxUartBaud ?? 3_000_000;
  const rungs = LADDER.filter((b) => b <= maxBaud);
  const currentBaud = state.limits?.currentUartBaud ?? 921600;

  const runLadder = async () => {
    const dev = getDevice();
    if (!dev || running) return;
    if (!claimDevice(OWNER, LABEL)) return;
    setRunning(true);
    setError(null);
    setResults([]);
    try {
      let i = 0;
      for (const baud of rungs) {
        i += 1;
        setRung(i);
        setCurrent(baud);
        const r = await dev.linkBench(baud);
        setResults((prev) => [...prev, r]);
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
      setApplied(baud);
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
          {results.length > 0 && !running ? (
            <Button
              size="sm"
              onClick={() =>
                downloadJson(`kino-linkbench-${state.info?.serial ?? 'unknown'}-${Date.now()}.json`, {
                  device: state.info?.serial,
                  ranAt: new Date().toISOString(),
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
      <p className="dim" style={{ marginBottom: 6 }}>
        Streams 256 KB per channel concurrently at each rate and stops at the first rate with CRC or
        framing errors. Current link: <span className="val">{baudLabel(currentBaud)}</span>.
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
                <th className="num">PER CHANNEL</th>
                <th className="num">4-FRAME SET</th>
                <th className="num">CRC ERR</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const slowest = Math.min(...r.channels.map((c) => c.kbytesPerSec));
                const crc = r.channels.reduce((a, c) => a + c.crcErrors + c.framingErrors, 0);
                // Concurrent: a 4×380 KB set lands in the time of one channel.
                const setSeconds = 380 / slowest;
                return (
                  <tr key={r.baud}>
                    <td>{baudLabel(r.baud)}</td>
                    <td>
                      <Led state={r.clean ? 'ok' : 'err'} label={r.clean ? 'CLEAN' : 'ERRORS'} />
                    </td>
                    <td className="num">{slowest} KB/s</td>
                    <td className="num">{setSeconds.toFixed(1)} s</td>
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

      {fastestClean ? (
        <p className="notice notice--ok" style={{ marginTop: 8, marginBottom: 0 }}>
          Fastest clean rate: <strong>{baudLabel(fastestClean.baud)}</strong>
          {applied === fastestClean.baud ? ' — adopted.' : ' — adopt it to shorten the shot cycle.'}
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
