import { useEffect, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Unsupported } from '../../components/Unsupported';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CalibrationTransfer } from './CalibrationTransfer';
import { OrderPanel, SpacingPanel, FlashPanel } from './procedures';
import { SkewBench } from './SkewBench';
import { useDeviceStore } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import { invalidateBench } from '../../state/benchResults';
import { clearNavRequest, useNavRequest } from '../../state/navRequest';
import { getDevice, onCalibrationEvent, refreshCalibration } from '../../app/session';
import type { CamCalibration, CamId, CalibrationEvent } from '@kino/kdp';
import { CAM_IDS, NEUTRAL_CAL } from '@kino/kdp';
import { formatSigned } from '../../utils/format';

type Phase = 'idle' | 'capturing' | 'analyzing' | 'review' | 'error';

/**
 * Two jobs on one page. Calibration corrects what the sensors *see*; the Skew
 * Bench measures *when* they saw it. Neither number belongs in the other's
 * table, and both are long link-claiming runs, so they get a tab each rather
 * than a single scroll that can have two things running at the bottom of it.
 */
type Tab = 'calibration' | 'skew';

const TABS: { id: Tab; label: string }[] = [
  { id: 'calibration', label: 'CALIBRATION' },
  { id: 'skew', label: 'SKEW BENCH' },
];

const OWNER = 'calibration';
const LABEL = 'CALIBRATION';

/**
 * One column, one unit, in the header. Cells carry bare tabular numbers so
 * a column of offsets can be scanned for the outlier.
 */
const CAL_COLUMNS: {
  head: string;
  unit?: string;
  read: (c: CamCalibration) => number;
  digits: number;
  signed: boolean;
}[] = [
  { head: 'EXPOSURE', unit: 'EV', read: (c) => c.ev, digits: 2, signed: true },
  { head: 'R MULT', read: (c) => c.r, digits: 3, signed: false },
  { head: 'G MULT', read: (c) => c.g, digits: 3, signed: false },
  { head: 'B MULT', read: (c) => c.b, digits: 3, signed: false },
  { head: 'X', unit: 'px', read: (c) => c.x, digits: 0, signed: true },
  { head: 'Y', unit: 'px', read: (c) => c.y, digits: 0, signed: true },
  { head: 'ROT', unit: '°', read: (c) => c.rot, digits: 2, signed: true },
];

function cell(value: number, digits: number, signed: boolean): string {
  return signed ? formatSigned(value, digits) : value.toFixed(digits);
}

function CalHead({ lead }: { lead?: string }) {
  return (
    <thead>
      <tr>
        <th>CAMERA</th>
        {lead ? <th>{lead}</th> : null}
        {CAL_COLUMNS.map((col) => (
          <th key={col.head} className="num">
            {col.head}
            {col.unit ? (
              <>
                {' ('}
                <span style={{ textTransform: 'none' }}>{col.unit}</span>
                {')'}
              </>
            ) : null}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function CalTable({ cams, reference }: { cams: Record<CamId, CamCalibration>; reference: CamId }) {
  return (
    <div className="tablewrap">
      <table className="table">
        <CalHead />
        <tbody>
          {CAM_IDS.map((id) => {
            const c = cams[id];
            return (
              <tr key={id}>
                <td>
                  CAM {id.slice(-1)}
                  {id === reference ? <span className="tag" style={{ marginLeft: 8 }}>REF</span> : null}
                </td>
                {CAL_COLUMNS.map((col) => (
                  <td key={col.head} className="num">
                    {cell(col.read(c), col.digits, col.signed)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Review table. The measured numbers used to be shown alone, in a panel
 * with different column positions from STORED ON KINO, so accepting meant
 * subtracting seven values per camera in your head. Same pattern as the
 * restore preview: stored, proposed, delta, one table.
 */
function CalReviewTable({
  stored,
  proposed,
  reference,
}: {
  stored: Record<CamId, CamCalibration> | null;
  proposed: Record<CamId, CamCalibration>;
  reference: CamId;
}) {
  return (
    <div className="tablewrap">
      <table className="table">
        <CalHead lead="VALUE" />
        <tbody>
          {CAM_IDS.flatMap((id) => {
            const now = stored?.[id] ?? NEUTRAL_CAL;
            const next = proposed[id];
            const rows: ('stored' | 'proposed' | 'delta')[] = ['stored', 'proposed', 'delta'];
            return rows.map((kind, i) => (
              <tr key={`${id}-${kind}`}>
                {i === 0 ? (
                  <td rowSpan={3}>
                    CAM {id.slice(-1)}
                    {id === reference ? <span className="tag" style={{ marginLeft: 8 }}>REF</span> : null}
                  </td>
                ) : null}
                <td className={kind === 'delta' ? undefined : 'dim'}>
                  {kind === 'stored' ? 'STORED' : kind === 'proposed' ? 'PROPOSED' : 'Δ CHANGE'}
                </td>
                {CAL_COLUMNS.map((col) => {
                  if (kind === 'stored') {
                    return (
                      <td key={col.head} className="num dim">
                        {cell(col.read(now), col.digits, col.signed)}
                      </td>
                    );
                  }
                  if (kind === 'proposed') {
                    return (
                      <td key={col.head} className="num">
                        {cell(col.read(next), col.digits, col.signed)}
                      </td>
                    );
                  }
                  const d = col.read(next) - col.read(now);
                  const zero = Math.abs(d) < Math.pow(10, -col.digits) / 2;
                  return (
                    <td key={col.head} className={zero ? 'num faint' : 'num'} style={{ fontWeight: zero ? undefined : 700 }}>
                      {zero ? '—' : formatSigned(d, col.digits)}
                    </td>
                  );
                })}
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CalibrationPage() {
  const calibration = useDeviceStore((s) => s.calibration);
  const capabilitiesState = useDeviceStore((s) => s.capabilitiesState);
  const firmwareLabel = useDeviceStore((s) => s.firmwareLabel);
  const [tab, setTab] = useState<Tab>('calibration');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progressMsg, setProgressMsg] = useState('');
  const [proposed, setProposed] = useState<Record<CamId, CamCalibration> | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blockedBy = useBlockedBy(OWNER);

  // A link from another section (Overview's sync verdict) opens the tab it
  // was talking about, not the one this page happened to be left on. The
  // request is consumed here: it is an instruction for one navigation, not a
  // standing override of every later visit to this page.
  const navRequest = useNavRequest((s) => s.request);
  useEffect(() => {
    if (navRequest?.page !== 'calibration') return;
    if (TABS.some((t) => t.id === navRequest.tab)) setTab(navRequest.tab as Tab);
    clearNavRequest(navRequest.nonce);
  }, [navRequest]);

  useEffect(() => {
    return onCalibrationEvent((e: CalibrationEvent) => {
      if (e.step === 'capture' && e.cam) {
        setPhase('capturing');
        setProgressMsg(`Capturing ${e.cam.toUpperCase().replace('CAM', 'CAM ')} …`);
      } else if (e.step === 'analyze') {
        setPhase('analyzing');
        setProgressMsg(e.message ?? 'Analyzing…');
      } else if (e.step === 'result' && e.offsets) {
        setPhase('review');
        setProposed(e.offsets);
        setProgressMsg('');
        // The run owns the link until its result event lands.
        releaseDevice(OWNER);
      } else if (e.step === 'error') {
        setPhase('error');
        setError(e.message ?? 'Calibration failed');
        releaseDevice(OWNER);
      }
    });
  }, []);

  const start = async () => {
    const dev = getDevice();
    if (!dev) return;
    // A calibration run is a long sequence of captures on the same link the
    // developer benches use — it takes the claim like they do.
    if (!claimDevice(OWNER, LABEL)) return;
    setError(null);
    setProposed(null);
    setPhase('capturing');
    setProgressMsg('Arming cameras…');
    try {
      await dev.startCalibration();
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
      releaseDevice(OWNER);
    }
  };

  const accept = async () => {
    const dev = getDevice();
    if (!dev || !proposed) return;
    setBusy(true);
    try {
      await dev.applyCalibration(proposed);
      // The capture benches shot their frames through the old offsets.
      invalidateBench(['timing', 'burnin'], 'calibration offsets were written after this run');
      await refreshCalibration();
      setPhase('idle');
      setProposed(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const dev = getDevice();
    if (!dev) return;
    setResetOpen(false);
    setBusy(true);
    try {
      await dev.resetCalibration();
      invalidateBench(['timing', 'burnin'], 'calibration was reset after this run');
      await refreshCalibration();
    } catch (err) {
      // The user confirmed a destructive action — a refusal must not look
      // identical to success (issue #80).
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const running = phase === 'capturing' || phase === 'analyzing';

  // M1B firmware NACKs CAMERA_CALIBRATE and GET_CALIBRATION: the capability
  // report loaded and calibration stayed absent. Every control on this page
  // would only collect errors — say so once instead (issue #80). Legacy
  // firmware (no capability report) keeps the benefit of the doubt.
  if (capabilitiesState === 'loaded' && calibration === null) {
    return (
      <>
        <div className="pagehead">
          <h1>
            <Icon name="calibration" />
            Calibration
          </h1>
        </div>
        <Unsupported
          feature="Calibration"
          firmware={firmwareLabel}
          note="The camera reports no calibration store. Bench diagnostics on the Developer page work today; calibration arrives with a later firmware milestone."
        />
      </>
    );
  }

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="calibration" />
          Calibration
        </h1>
        {tab === 'calibration' ? (
          <span className="microlabel">
            {calibration?.capturedAt ? `LAST RUN ${new Date(calibration.capturedAt).toLocaleDateString()}` : 'NEVER CALIBRATED'}
          </span>
        ) : null}
      </div>

      {/* Same seg group the Gallery filters use — one stop per button, state
          on `aria-pressed`. A `role="tablist"` would owe the sections below
          matching `tabpanel` roles and arrow-key movement it does not have. */}
      <span className="seg pagetabs" role="group" aria-label="Calibration section">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="seg-opt"
            aria-pressed={t.id === tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </span>

      {tab === 'skew' ? <SkewBench /> : null}

      {tab === 'calibration' ? (
        <>
          <p className="notice">
            Measures brightness, color and alignment differences between the four sensors and stores
            per-camera correction offsets. CAM2 is the reference. Corrections are bounded.
          </p>

          <CalibrationTransfer />

          <div className="panel-grid">
            <Panel title="PROCEDURE">
              <ol className="calsteps">
                <li>Place a neutral target (white card, gray wall) in front of all four lenses</li>
                <li>Light it evenly — no hard shadows across the lens row</li>
                <li>Start calibration and hold the camera still</li>
                <li>Review the measured offsets, then save or discard</li>
              </ol>
              <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
                <Button
                  variant="primary"
                  busy={running}
                  disabled={!running && blockedBy !== null}
                  title={blockedBy ? `${blockedBy} is running` : undefined}
                  onClick={() => void start()}
                >
                  START CALIBRATION
                </Button>
                <Button
                  variant="danger"
                  disabled={running || busy || blockedBy !== null}
                  title={blockedBy ? `${blockedBy} is running` : undefined}
                  onClick={() => setResetOpen(true)}
                >
                  RESET CALIBRATION
                </Button>
              </div>
              <p className="dim mono" style={{ marginTop: 12, minHeight: 18 }} role="status">
                {running ? progressMsg : blockedBy ? `${blockedBy} is running.` : ''}
              </p>
              {error ? <p className="notice notice--err" style={{ marginTop: 12, marginBottom: 0 }}>{error}</p> : null}
            </Panel>

            <Panel title="STORED ON KINO">
              {calibration ? (
                <CalTable cams={calibration.cams} reference={calibration.reference} />
              ) : (
                <p className="faint">No calibration data reported.</p>
              )}
            </Panel>
          </div>

          {phase === 'review' && proposed ? (
            <Panel
              title="MEASURED OFFSETS — REVIEW"
              actions={
                <>
                  <Button variant="ghost" disabled={busy} onClick={() => { setPhase('idle'); setProposed(null); }}>
                    DISCARD
                  </Button>
                  <Button variant="primary" busy={busy} onClick={() => void accept()}>
                    SAVE TO KINO
                  </Button>
                </>
              }
            >
              <CalReviewTable
                stored={calibration?.cams ?? null}
                proposed={proposed}
                reference={calibration?.reference ?? 'cam2'}
              />
              <p className="dim" style={{ marginTop: 10 }}>
                Corrections relative to CAM2. Nothing is written to the camera until you save.
              </p>
            </Panel>
          ) : null}

          <div className="panel-grid">
            <OrderPanel />
            <SpacingPanel />
          </div>
          <FlashPanel />
        </>
      ) : null}

      <ConfirmDialog
        open={resetOpen}
        danger
        title="RESET CALIBRATION"
        confirmLabel="RESET"
        onCancel={() => setResetOpen(false)}
        onConfirm={() => void reset()}
      >
        <p>
          Clear all per-camera offsets? Wigglegrams will show brightness and color jumps until you
          calibrate again.
        </p>
      </ConfirmDialog>
    </>
  );
}
