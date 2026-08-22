import { useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import type { LedState } from '../../components/Led';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDeviceStore } from '../../state/deviceStore';
import { useConnectionStore } from '../../state/connectionStore';
import { useUpdateStore, setUpdateState, TARGET_STATUS_LABEL } from '../../state/updateStore';
import type { TargetProgress } from '../../state/updateStore';
import { loadPackageFromFiles, checkCompatibility, isDowngrade } from '../../firmware/manifest';
import { buildDemoPackage } from '../../firmware/demoPackage';
import {
  downloadFirmwarePackage,
  listFirmwareReleases,
  type CatalogRelease,
} from '../../firmware/catalog';
import { startUpdate, retryTarget, abortUpdate } from '../../firmware/updater';
import { rebootAndReconnect, factoryResetAndReconnect } from '../../app/session';
import { usePrefs } from '../../state/prefs';
import { FirmwareBuildPanel } from './FirmwareBuildPanel';

function statusLed(t: TargetProgress): LedState {
  switch (t.status) {
    case 'updated':
      return 'ok';
    case 'failed':
      return 'err';
    case 'sending':
    case 'verifying':
    case 'applying':
    case 'rebooting':
    case 'checking':
      return 'busy';
    case 'waiting':
      return 'warn';
    default:
      return 'off';
  }
}

export function UpdatesPage() {
  const info = useDeviceStore((s) => s.info);
  const phase = useConnectionStore((s) => s.phase);
  const update = useUpdateStore();
  const developerMode = usePrefs((s) => s.developerMode);
  const dirRef = useRef<HTMLInputElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirm2, setConfirm2] = useState<'reboot' | 'factory-reset' | 'recovery' | null>(null);
  const [loadingPkg, setLoadingPkg] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReleases, setCatalogReleases] = useState<CatalogRelease[] | null>(null);
  const [recoveryArmed, setRecoveryArmed] = useState(false);

  if (!info) return null;

  const pkg = update.pkg;
  const compat = update.compat;
  const busy = update.running || phase === 'reconnecting';

  const loadFiles = async (files: File[]) => {
    setLoadingPkg(true);
    setUpdateState({ pkgError: null });
    const result = await loadPackageFromFiles(files);
    setLoadingPkg(false);
    if (!result.ok) {
      setUpdateState({ pkg: null, compat: null, pkgError: result.error });
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
  };

  const loadDemo = async () => {
    setLoadingPkg(true);
    const demo = await buildDemoPackage();
    setUpdateState({
      pkg: demo,
      compat: checkCompatibility(demo.manifest, info),
      pkgError: null,
      targets: [],
      finished: false,
      halted: false,
    });
    setLoadingPkg(false);
  };

  const checkCatalog = async () => {
    setCatalogBusy(true);
    setCatalogError(null);
    const result = await listFirmwareReleases(info.hardware, info.protocol);
    setCatalogBusy(false);
    if (!result.ok) {
      // An online check is additive. In particular, do not clear update.pkg:
      // a technician may already have a verified package loaded while offline.
      setCatalogError(result.error);
      return;
    }
    setCatalogReleases(result.value);
  };

  const downloadCatalogRelease = async (release: CatalogRelease) => {
    setCatalogBusy(true);
    setCatalogError(null);
    setUpdateState({ pkgError: null });
    const result = await downloadFirmwarePackage(release.release, release.channel);
    setCatalogBusy(false);
    if (!result.ok) {
      // Keep any previously verified package usable if the network or a new
      // download fails.
      setUpdateState({ pkgError: result.error });
      return;
    }
    setUpdateState({
      pkg: result.value,
      compat: checkCompatibility(result.value.manifest, info),
      pkgError: null,
      targets: [],
      finished: false,
      halted: false,
    });
  };

  const installedRows: { label: string; version: string }[] = [
    { label: 'P4', version: info.p4Firmware },
    ...info.cameraFirmware.map((v, i) => ({ label: `CAM${i + 1}`, version: v })),
  ];

  const failedTarget = update.targets.find((t) => t.status === 'failed');

  // Five per-target bars and no total: "how far along is this, and can I walk
  // away" was unanswerable. Progress is the mean of the five, which matches
  // how the updater actually spends its time.
  // A target's own bar hits 100% when the bytes are sent, but it is not done
  // until it reports `updated` — so the total holds just short until then.
  // "4/5 COMPONENTS · 100%" while the P4 is still rebooting is a lie.
  const doneCount = update.targets.filter((t) => t.status === 'updated').length;
  const overallPct = update.targets.length
    ? Math.round(
        (update.targets.reduce(
          (sum, t) => sum + (t.status === 'updated' ? 1 : Math.min(t.progress, 0.95)),
          0,
        ) /
          update.targets.length) *
          100,
      )
    : 0;
  const activeTarget = update.targets.find(
    (t) => t.status !== 'not-started' && t.status !== 'updated' && t.status !== 'failed',
  );
  const activeLine = failedTarget
    ? `${failedTarget.label} FAILED — ${failedTarget.error ?? 'no reason reported'}`
    : activeTarget
      ? `${activeTarget.label} ${TARGET_STATUS_LABEL[activeTarget.status]}${
          activeTarget.status === 'sending' ? ` ${Math.round(activeTarget.progress * 100)}%` : ''
        }`
      : update.finished
        ? 'ALL COMPONENTS UPDATED'
        : '';

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="updates" />
          Updates
        </h1>
        <span className="microlabel">
          {pkg && compat?.ok && installedRows.every((r) => r.version === (r.label === 'P4' ? pkg.manifest.p4.version : pkg.manifest.xiao.version))
            ? 'YOUR KINO IS UP TO DATE'
            : `INSTALLED · P4 ${info.p4Firmware}`}
        </span>
      </div>

      <div className="panel-grid">
        <Panel title="INSTALLED">
          <dl>
            {installedRows.map((r) => (
              <div key={r.label} className="datarow">
                <dt>{r.label}</dt>
                <dd>
                  {r.version}
                  {pkg && r.version !== (r.label === 'P4' ? pkg.manifest.p4.version : pkg.manifest.xiao.version) ? (
                    <span className="tag tag--accent" style={{ marginLeft: 8 }}>
                      → {r.label === 'P4' ? pkg.manifest.p4.version : pkg.manifest.xiao.version}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel title="FIRMWARE CATALOG">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <Button busy={catalogBusy} disabled={busy} onClick={() => void checkCatalog()}>
              CHECK ONLINE
            </Button>
            <span className="dim">Stable channel · {info.hardware} · protocol {info.protocol}</span>
          </div>
          {catalogError ? <p className="notice notice--warn">{catalogError}</p> : null}
          {catalogReleases === null ? (
            <p className="faint">Check the Roll server for firmware compatible with this KINO.</p>
          ) : catalogReleases.length === 0 ? (
            <p className="faint">No stable firmware releases are published.</p>
          ) : (
            <dl>
              {catalogReleases.map((release) => (
                <div className="datarow" key={`${release.channel}:${release.release}`} style={{ maxWidth: 'none' }}>
                  <dt>{release.release}</dt>
                  <dd style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <span>
                      <Led state={release.compatible ? 'ok' : 'warn'} label={release.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE'} />
                      {release.reasons.length > 0 ? ` · ${release.reasons.join(' · ')}` : ''}
                    </span>
                    <Button
                      size="sm"
                      variant={release.compatible ? 'primary' : 'ghost'}
                      busy={catalogBusy}
                      disabled={busy || !release.compatible}
                      onClick={() => void downloadCatalogRelease(release)}
                    >
                      DOWNLOAD
                    </Button>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>

        {developerMode ? <FirmwareBuildPanel /> : null}

        <Panel title="UPDATE PACKAGE">
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <Button busy={loadingPkg} disabled={busy} onClick={() => dirRef.current?.click()}>
              SELECT PACKAGE…
            </Button>
            <Button variant="ghost" busy={loadingPkg} disabled={busy} onClick={() => void loadDemo()}>
              LOAD DEMO PACKAGE
            </Button>
            <input
              ref={dirRef}
              type="file"
              hidden
              multiple
              // @ts-expect-error non-standard attr, supported by Chromium targets
              webkitdirectory=""
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length > 0) void loadFiles(files);
                e.target.value = '';
              }}
            />
          </div>

          {update.pkgError ? <p className="notice notice--err">{update.pkgError}</p> : null}

          {pkg ? (
            <>
              {/* These rows carry a package name and two digests. The 46ch
                  default broke `demo package (in / memory)` across two lines
                  with a third of the panel sitting empty next to it. */}
              <dl>
                <div className="datarow" style={{ maxWidth: 'none' }}>
                  <dt>Package</dt>
                  <dd>{pkg.manifest.version} · {pkg.sourceName}</dd>
                </div>
                <div className="datarow" style={{ maxWidth: 'none' }}>
                  <dt>P4 image</dt>
                  <dd title={`SHA-256 ${pkg.manifest.p4.sha256}`}>
                    {pkg.manifest.p4.version} · {(pkg.p4Image.length / 1024).toFixed(0)} KB · SHA-256{' '}
                    {pkg.manifest.p4.sha256.slice(0, 12)}… matches manifest
                  </dd>
                </div>
                <div className="datarow" style={{ maxWidth: 'none' }}>
                  <dt>Camera image</dt>
                  <dd title={`SHA-256 ${pkg.manifest.xiao.sha256}`}>
                    {pkg.manifest.xiao.version} · {(pkg.xiaoImage.length / 1024).toFixed(0)} KB · SHA-256{' '}
                    {pkg.manifest.xiao.sha256.slice(0, 12)}… matches manifest
                  </dd>
                </div>
                <div className="datarow" style={{ maxWidth: 'none' }}>
                  <dt>Compatibility</dt>
                  <dd>{compat?.ok ? <Led state="ok" label="COMPATIBLE" /> : <Led state="err" label="BLOCKED" />}</dd>
                </div>
              </dl>
              {/* "SHA OK" said nothing about what was hashed, against what,
                  or when. */}
              <p className="dim" style={{ marginTop: 8, marginBottom: 0 }}>
                Both files were hashed when the package was loaded. Nothing has been sent to the
                camera yet.
              </p>
              {compat && !compat.ok
                ? compat.problems.map((p) => (
                    <p key={p} className="notice notice--err" style={{ marginTop: 10, marginBottom: 0 }}>{p}</p>
                  ))
                : null}
              {pkg.manifest.releaseNotes ? (
                <p className="dim" style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                  {pkg.manifest.releaseNotes}
                </p>
              ) : null}
            </>
          ) : (
            <p className="faint">
              A package is a folder with manifest.json, p4-app.bin and xiao-app.bin. Images are
              SHA-256 checked before transfer.
            </p>
          )}
        </Panel>
      </div>

      {pkg && compat?.ok ? (
        <Panel
          title="UPDATE"
          actions={
            update.targets.length === 0 || update.finished ? (
              <Button variant="primary" disabled={busy} onClick={() => setConfirmOpen(true)}>
                UPDATE KINO
              </Button>
            ) : null
          }
        >
          {update.targets.length === 0 ? (
            <p className="dim">
              Updates CAM1–4 first, then the P4. One reboot at the end. Keep USB connected.
            </p>
          ) : (
            <div>
              <div className="fwrow fwrow--overall">
                <span className="fwrow-target">OVERALL</span>
                <span className="fwrow-status">
                  {doneCount}/{update.targets.length} COMPONENTS
                </span>
                <span
                  className="meter"
                  role="progressbar"
                  aria-label="Overall firmware progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={overallPct}
                >
                  <span className="meter-fill" style={{ width: `${overallPct}%`, display: 'block' }} />
                </span>
                <span className="fwrow-status num" style={{ textAlign: 'right' }}>
                  {overallPct}%
                </span>
              </div>
              <p className="microlabel" role="status" style={{ padding: '2px 0 8px' }}>
                {activeLine}
              </p>
              {update.targets.map((t) => (
                <div key={t.id} className="fwrow">
                  <span className="fwrow-target">{t.label}</span>
                  <span className="fwrow-status">
                    <Led state={statusLed(t)} label={TARGET_STATUS_LABEL[t.status]} />
                  </span>
                  <span className="meter" aria-hidden={t.status === 'not-started'}>
                    <span
                      className={`meter-fill${t.status === 'failed' ? ' meter-fill--err' : t.status === 'updated' ? ' meter-fill--ok' : ''}`}
                      style={{ width: `${Math.round(t.progress * 100)}%`, display: 'block' }}
                    />
                  </span>
                  <span className="fwrow-status num" style={{ textAlign: 'right' }}>
                    {t.status === 'sending' ? `${Math.round(t.progress * 100)}%` : ''}
                    {t.status === 'failed' ? (
                      <Button size="sm" variant="primary" disabled={update.running} onClick={() => void retryTarget(t.id)}>
                        RETRY {t.label}
                      </Button>
                    ) : null}
                  </span>
                  {t.error ? <span className="fwrow-err">{t.error}</span> : null}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12 }}>
                {update.halted && failedTarget ? (
                  <Button variant="ghost" onClick={() => void abortUpdate()}>
                    ABORT UPDATE
                  </Button>
                ) : null}
                {update.finished ? <Led state="ok" label="ALL COMPONENTS UPDATED" /> : null}
              </div>
            </div>
          )}
        </Panel>
      ) : null}

      <Panel title="ADVANCED RECOVERY" className="recovery">
        <p className="dim" style={{ marginBottom: 12 }}>
          Normal updates never touch the bootloader. Recovery is for a board that no longer runs
          firmware at all, so KINO Studio cannot talk to it — the protocol needs firmware on the
          other end. Studio hands you the steps; the flashing happens with esptool.
        </p>
        {recoveryArmed ? (
          <div className="notice notice--warn">
            <strong>Recovery procedure</strong>
            <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              <li>Unplug USB.</li>
              <li>Hold BOOT on the board you are recovering (P4, or the XIAO in question).</li>
              <li>Plug USB back in, then release BOOT. The board is now in ROM download mode.</li>
              <li>
                Flash the image with esptool, e.g.{' '}
                <code className="val">
                  esptool.py --chip esp32p4 -b 460800 write_flash 0x10000 p4-app.bin
                </code>
                . Use <code className="val">--chip esp32s3</code> for a XIAO.
              </li>
              <li>Power-cycle, then connect from the start screen and run a self test.</li>
            </ol>
            <p style={{ margin: '10px 0 0' }}>
              Calibration lives in the P4 NVS partition. A full <code className="val">erase_flash</code>{' '}
              destroys it — back up first if the camera still answers.
            </p>
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="ghost" onClick={() => setRecoveryArmed(false)}>
                CLOSE
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button disabled={busy} onClick={() => setConfirm2('recovery')}>
              SHOW RECOVERY STEPS
            </Button>
            <Button disabled={busy} onClick={() => setConfirm2('reboot')}>
              REBOOT KINO
            </Button>
            {/* The most destructive action in the product read quieter than
                the blue UPDATE KINO above it. Solid red, not red text. */}
            <Button variant="danger-solid" disabled={busy} onClick={() => setConfirm2('factory-reset')}>
              FACTORY RESET
            </Button>
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={confirmOpen}
        focusCancel
        title="UPDATE KINO"
        confirmLabel="START UPDATE"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          if (pkg) void startUpdate(pkg);
        }}
      >
        {pkg && info && isDowngrade(pkg.manifest, info) ? (
          <p className="warn" style={{ fontWeight: 600 }}>
            DOWNGRADE: this package ({pkg.manifest.p4.version}) is older than the installed P4 firmware (
            {info.p4Firmware}). Newer configuration or calibration fields may not survive. Continue only for
            recovery or bisection.
          </p>
        ) : null}
        <p>
          Install <strong>{pkg?.manifest.version}</strong> on CAM1–4 and the P4? Takes about two
          minutes and reboots at the end. Settings, looks and calibration are preserved.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm2 === 'reboot'}
        focusCancel
        title="REBOOT KINO"
        confirmLabel="REBOOT"
        onCancel={() => setConfirm2(null)}
        onConfirm={() => {
          setConfirm2(null);
          void rebootAndReconnect();
        }}
      >
        <p>Restart the camera now? KINO Studio reconnects automatically after boot.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm2 === 'factory-reset'}
        danger
        title="FACTORY RESET"
        confirmLabel="ERASE EVERYTHING"
        onCancel={() => setConfirm2(null)}
        onConfirm={() => {
          setConfirm2(null);
          void factoryResetAndReconnect();
        }}
      >
        <p>
          Erase <strong>all settings, custom looks and calibration</strong> and return KINO to
          factory state? Photos on the SD card are not touched. This cannot be undone.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm2 === 'recovery'}
        title="RECOVERY STEPS"
        confirmLabel="SHOW STEPS"
        onCancel={() => setConfirm2(null)}
        onConfirm={() => {
          setConfirm2(null);
          setRecoveryArmed(true);
        }}
      >
        <p>
          Nothing is sent to the camera — this only shows the ROM-loader procedure. Following it
          with a wrong image can erase calibration and configuration.
        </p>
      </ConfirmDialog>
    </>
  );
}
