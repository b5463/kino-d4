import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { useDeviceStore } from '../../state/deviceStore';
import { useUpdateStore, setUpdateState } from '../../state/updateStore';
import { checkCompatibility } from '../../firmware/manifest';
import {
  FirmwareDaemonClient,
  loadDaemonPackage,
  type DaemonBuild,
  type DaemonStatus,
  type DaemonTarget,
} from '../../firmware/daemonClient';

const PROBE_INTERVAL_MS = 5000;
const POLL_INTERVAL_MS = 800;
const LOG_TAIL = 14;

/**
 * FIRMWARE BUILDER (issue #72, brief §24-§32): drives the local build daemon
 * that wraps the canonical espressif/idf:v5.5.1 Docker build of firmware/.
 * Everything shown is what actually happened — real step results, real log
 * tail, real SHA-256 — and a build refuses on version drift or failing KDP
 * host tests unless the developer explicitly overrides.
 */
export function FirmwareBuildPanel() {
  const info = useDeviceStore((s) => s.info);
  const running = useUpdateStore((s) => s.running);
  const clientRef = useRef(new FirmwareDaemonClient());
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [build, setBuild] = useState<DaemonBuild | null>(null);
  const [logTail, setLogTail] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingPkg, setLoadingPkg] = useState(false);
  const [skipChecks, setSkipChecks] = useState(false);

  const probe = useCallback(async () => {
    try {
      setStatus(await clientRef.current.status());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void probe();
    const timer = setInterval(() => void probe(), PROBE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [probe]);

  // Poll the active build, appending only the new log lines.
  useEffect(() => {
    if (!build || build.status !== 'running') return;
    const timer = setInterval(() => {
      void clientRef.current
        .build(build.id, build.logOffset)
        .then((next) => {
          setBuild(next);
          if (next.log.length > 0) setLogTail((tail) => [...tail, ...next.log].slice(-LOG_TAIL));
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [build]);

  async function startBuild(target: DaemonTarget) {
    setError(null);
    setLogTail([]);
    try {
      const { id } = await clientRef.current.startBuild(target, skipChecks);
      setBuild(await clientRef.current.build(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadIntoUpdater() {
    if (!info) return;
    setLoadingPkg(true);
    setError(null);
    const result = await loadDaemonPackage(clientRef.current);
    setLoadingPkg(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setUpdateState({
      pkg: result.pkg,
      compat: checkCompatibility(result.pkg.manifest, info),
      pkgError: null,
      targets: [],
      finished: false,
      halted: false,
    });
  }

  const manifest = build?.status === 'ready' ? build.manifest : null;
  const buildBusy = build?.status === 'running' || status?.running === true;

  return (
    <Panel
      title="FIRMWARE BUILDER"
      actions={
        status ? (
          <>
            <Button size="sm" busy={buildBusy} disabled={running} onClick={() => void startBuild('p4')}>
              BUILD P4
            </Button>
            <Button size="sm" busy={buildBusy} disabled={running} onClick={() => void startBuild('camnode')}>
              BUILD CAMNODE
            </Button>
            <Button size="sm" busy={loadingPkg} disabled={running || buildBusy} onClick={() => void loadIntoUpdater()}>
              LOAD BUILT PACKAGE
            </Button>
          </>
        ) : undefined
      }
    >
      {!status ? (
        <p className="dim">
          Build daemon offline. Start it in the repository with <code>npm run firmware:daemon</code> — it wraps the
          canonical <code>espressif/idf:v5.5.1</code> Docker build, the same environment CI uses.
        </p>
      ) : (
        <>
          <dl>
            <div className="datarow"><dt>Daemon</dt><dd><Led state="ok" label="CONNECTED" /></dd></div>
            <div className="datarow"><dt>Environment</dt><dd>{status.image}</dd></div>
            <div className="datarow"><dt>Docker</dt><dd>{status.dockerAvailable ? status.dockerVersion : 'NOT AVAILABLE'}</dd></div>
            <div className="datarow"><dt>firmware/VERSION</dt><dd>{status.firmwareVersion}</dd></div>
            <div className="datarow"><dt>Tree</dt><dd>{status.gitCommit.slice(0, 7)}{status.dirty ? ' · DIRTY' : ''}</dd></div>
          </dl>
          <label className="dim" style={{ display: 'block', marginTop: 6 }}>
            <input type="checkbox" checked={skipChecks} onChange={(e) => setSkipChecks(e.target.checked)} /> Skip
            version + host-test gate (explicit developer override — the build output will say CHECKS SKIPPED)
          </label>
        </>
      )}

      {error ? <p className="warn">{error}</p> : null}

      {build ? (
        <div style={{ marginTop: 8 }}>
          <p className={build.status === 'failed' ? 'warn' : 'dim'}>
            {build.id} · {build.target.toUpperCase()} · {build.status.toUpperCase()}
            {build.error ? ` — ${build.error}` : ''} · {build.warnings} warnings · {build.errors} errors
          </p>
          <ul className="dim" style={{ margin: '4px 0', paddingLeft: 18 }}>
            {build.steps.map((step) => (
              <li key={step.name} className={step.status === 'fail' ? 'warn' : undefined}>
                {step.name}: {step.status.toUpperCase()}
                {step.ms !== null ? ` (${(step.ms / 1000).toFixed(1)} s)` : ''}
              </li>
            ))}
          </ul>
          {logTail.length > 0 ? (
            <pre style={{ maxHeight: 180, overflow: 'auto', fontSize: 11, margin: 0 }}>{logTail.join('\n')}</pre>
          ) : null}
          {manifest ? (
            <dl style={{ marginTop: 6 }}>
              <div className="datarow"><dt>Artifact</dt><dd>{Object.values(manifest.targets)[0]?.file}</dd></div>
              <div className="datarow"><dt>Release</dt><dd>{manifest.release} ({manifest.channel})</dd></div>
              <div className="datarow"><dt>SHA-256</dt><dd>{Object.values(manifest.targets)[0]?.sha256.slice(0, 16)}…</dd></div>
              <div className="datarow"><dt>Size</dt><dd>{manifest.sizeBytes} bytes</dd></div>
              {manifest.partitionUsage ? <div className="datarow"><dt>Partition</dt><dd>{manifest.partitionUsage}</dd></div> : null}
              <div className="datarow"><dt>Provenance</dt><dd>{manifest.espIdfVersion} · {manifest.gitCommit?.slice(0, 7)}{manifest.gitDirty ? ' · DIRTY' : ''} · {manifest.builtAt}</dd></div>
              {manifest.checksRun === false ? <div className="datarow"><dt>Gate</dt><dd className="warn">CHECKS SKIPPED</dd></div> : null}
            </dl>
          ) : null}
        </div>
      ) : null}

      <p className="dim" style={{ marginTop: 8 }}>
        LOAD BUILT PACKAGE assembles the latest P4 + camnode artifacts (SHA-256 re-verified) into the update
        package below — the same FW_BEGIN/CHUNK/END path then flashes KINO Twin or, later, physical hardware.
      </p>
    </Panel>
  );
}
