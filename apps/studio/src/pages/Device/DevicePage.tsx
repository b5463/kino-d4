import { useEffect, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ApplyBar } from '../../components/ApplyBar';
import { SegField, SelectField, SliderField, TextField, ToggleField } from '../../components/fields';
import { useDeviceStore, supports } from '../../state/deviceStore';
import {
  getDevice,
  refreshCalibration,
  refreshConfig,
  refreshDeviceInfo,
  refreshRecipes,
  refreshSounds,
} from '../../app/session';
import { onUi } from '../../state/uiBus';
import { useDraft } from '../../hooks/useDraft';
import type { BodyConfig } from '@kino/kdp';
import { formatMB } from '../../utils/format';
import { diffConfigs } from '../../utils/diffConfig';
import { configLabel, configValue } from '../../utils/configLabels';
import { buildBackup, backupFilename, validateBackup, bytesToBase64, base64ToBytes } from '../../device/backup';
import type { BackupSound, KinoBackup } from '../../device/backup';
import { readSound, uploadSound } from '../../device/sounds';
import { downloadText } from '../../utils/download';
import { playBuiltin } from '../../utils/soundFx';

/** "1 look" / "2 looks" — never "1 look(s)". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Calibration leaves are single letters on the wire (`x`, `rot`, `ev`) and the
 * shared config map does not cover them — it only knows settings paths. The
 * restore diff is the last screen before the camera is overwritten, so it
 * names the calibration fields the way the calibration screens do.
 */
const CAL_FIELDS: Record<string, string> = {
  ev: 'Exposure offset (EV)',
  r: 'Red gain',
  g: 'Green gain',
  b: 'Blue gain',
  x: 'X offset (px)',
  y: 'Y offset (px)',
  rot: 'Rotation (°)',
  reference: 'Reference camera',
  capturedAt: 'Captured',
  orderVerifiedAt: 'Order verified',
  spacingMm: 'Lens spacing (mm)',
  spacingSource: 'Spacing source',
  order: 'Physical order',
  saved: 'Stored on device',
  level: 'Flash level',
  distance: 'Flash distance',
  calibratedAt: 'Flash calibrated',
};

/** Row label for one flattened restore-diff path. */
function diffLabel(path: string): string {
  if (!path.startsWith('calibration.')) return configLabel(path);
  const parts = path.split('.');
  const last = parts[parts.length - 1];
  const cam = parts.find((p) => /^cam[1-4]$/.test(p));
  const field = CAL_FIELDS[last] ?? configLabel(path);
  return ['Calibration', cam ? `CAM ${cam.slice(-1)}` : null, field].filter(Boolean).join(' · ');
}

export function DevicePage() {
  const state = useDeviceStore();
  const { draft, dirty, changes, changedFields, patch, discard } = useDraft<BodyConfig>(state.config?.body ?? null, {
    key: 'device',
    label: 'Device',
  });
  const [pendingRestore, setPendingRestore] = useState<{
    backup: KinoBackup;
    skipped: string[];
    skippedSounds: string[];
  } | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const restoreFileRef = useRef<HTMLInputElement>(null);

  const { info, power, storage, config } = state;

  const backUp = async () => {
    if (!info || !config || !state.calibration) {
      // Absence with a loaded capability report is permanent (M1B firmware
      // NACKs GET_CONFIG/GET_CALIBRATION) — "try again" would be a lie.
      setBackupNotice(
        info && state.capabilitiesState === 'loaded'
          ? 'This firmware does not expose settings or calibration to back up.'
          : 'Device state is still loading — try again in a moment.',
      );
      return;
    }
    // Custom sound bytes come off the device (cached after the first read).
    let sounds: BackupSound[] = [];
    const dev = getDevice();
    if (dev && state.sounds.length > 0) {
      try {
        sounds = await Promise.all(
          state.sounds.map(async (s) => ({
            id: s.id,
            name: s.name,
            durationMs: s.durationMs,
            wavBase64: bytesToBase64(await readSound(dev, s)),
          })),
        );
      } catch (err) {
        setBackupNotice(`Backup failed reading sounds: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const backup = buildBackup(info, config, state.calibration, state.customRecipes, sounds);
    downloadText(backupFilename(info), JSON.stringify(backup, null, 2), 'application/json');
    setBackupNotice(
      `Backed up settings, calibration, ${plural(state.customRecipes.length, 'custom look')} and ${plural(sounds.length, 'custom sound')}. Photos stay on the SD card.`,
    );
  };

  const pickRestoreFile = (file: File) => {
    setBackupNotice(null);
    void file.text().then((text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setBackupNotice('Restore failed: file is not valid JSON.');
        return;
      }
      const check = validateBackup(json);
      if (!check.ok || !check.backup) {
        setBackupNotice(`Restore failed: ${check.error}`);
        return;
      }
      setPendingRestore({
        backup: check.backup,
        skipped: check.skippedRecipes ?? [],
        skippedSounds: check.skippedSounds ?? [],
      });
    });
  };

  useEffect(() => onUi('backup', () => void backUp()), [info, config, state.calibration, state.customRecipes, state.sounds]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onUi('restore', () => restoreFileRef.current?.click()), []);

  const runRestore = async () => {
    const dev = getDevice();
    if (!dev || !pendingRestore) return;
    if (!config && state.capabilitiesState === 'loaded') {
      // The first write would NACK and the old catch blamed a "partially
      // restored" camera that in truth accepted nothing (issue #80).
      setPendingRestore(null);
      setBackupNotice('This firmware does not accept configuration writes — nothing was restored.');
      return;
    }
    const { backup, skipped, skippedSounds } = pendingRestore;
    setPendingRestore(null);
    setRestoreBusy(true);
    const soundsSupported = supports(state, 'customSounds');
    let soundsWritten = 0;
    try {
      // The writes. Only a failure in here can leave the camera half-restored.
      // Sounds first — the config may name a custom clip as shutter sound.
      if (soundsSupported) {
        for (const snd of backup.customSounds) {
          const wav = base64ToBytes(snd.wavBase64);
          await uploadSound(dev, { id: snd.id, name: snd.name, sizeBytes: wav.length, durationMs: snd.durationMs }, wav);
          soundsWritten++;
        }
      }
      await dev.applyConfig(backup.config);
      await dev.applyCalibration(backup.calibration.cams);
      for (const recipe of backup.customRecipes) {
        await dev.uploadRecipe({ ...recipe, factory: false });
      }
    } catch (err) {
      setBackupNotice(
        `Restore stopped: ${err instanceof Error ? err.message : String(err)}. The KINO may be partially restored — check settings before shooting.`,
      );
      setRestoreBusy(false);
      return;
    }

    // Every write was acknowledged. What follows is Studio catching up with a
    // camera that is already restored, and a slow read-back is not a partial
    // restore — reporting one sent people hunting for damage that was not
    // there.
    let readBack: string | null = null;
    try {
      await Promise.all([refreshConfig(), refreshCalibration(), refreshRecipes(), refreshSounds().catch(() => {}), refreshDeviceInfo()]);
    } catch (err) {
      readBack = err instanceof Error ? err.message : String(err);
    }

    const notes: string[] = [];
    if (skipped.length > 0) notes.push(`Skipped ${plural(skipped.length, 'invalid look')}: ${skipped.join(', ')}.`);
    if (skippedSounds.length > 0) notes.push(`Skipped ${plural(skippedSounds.length, 'invalid sound')}: ${skippedSounds.join(', ')}.`);
    if (!soundsSupported && backup.customSounds.length > 0) {
      notes.push(`${plural(backup.customSounds.length, 'sound')} not written — this firmware has no custom sounds.`);
    }
    if (readBack !== null) {
      notes.push(`Reading the camera back afterwards failed: ${readBack}. Press SYNC to refresh this screen.`);
    }
    setBackupNotice(
      `Restore complete — settings, calibration, ${plural(backup.customRecipes.length, 'look')} and ${plural(soundsWritten, 'sound')} written to KINO.${notes.length ? ' ' + notes.join(' ') : ''}`,
    );
    setRestoreBusy(false);
  };

  const applyBody = async () => {
    const dev = getDevice();
    if (!dev || !draft) throw new Error('Not connected');
    await dev.applyConfig({ body: draft });
    await refreshConfig();
  };

  if (!info) return null;

  const sdUsedPct =
    storage && storage.present && storage.totalMB > 0
      ? Math.round(((storage.totalMB - storage.freeMB) / storage.totalMB) * 100)
      : 0;
  const battMeasured = power != null && power.batteryPct !== null;
  const battPct = power?.batteryPct ?? 0;
  // `supports` reads a missing flag as "not a gate", so this is false only
  // when the camera said `brightnessControl: false` — firmware older than
  // 0.4.9 omits the flag and keeps the slider live rather than being greyed
  // out on a claim it never made.
  const canDim = supports(state, 'brightnessControl');

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="device" />
          Device
        </h1>
        <span className="microlabel">
          {info.product} {info.hardware} · {info.serial}
        </span>
      </div>

      <div className="panel-grid">
        <Panel title="MAIN CONTROLLER">
          <dl>
            <div className="datarow"><dt>Product</dt><dd>{info.product} {info.hardware}</dd></div>
            <div className="datarow"><dt>Serial</dt><dd>{info.serial}</dd></div>
            <div className="datarow"><dt>Protocol</dt><dd>{info.protocol}</dd></div>
            <div className="datarow"><dt>P4 firmware</dt><dd>{info.p4Firmware}</dd></div>
            <div className="datarow"><dt>Camera firmware</dt><dd>{info.cameraFirmware.join(' / ')}</dd></div>
          </dl>
          {/* The name belongs next to the serial it sits beside on the body's
              About screen, not in a settings panel three panels down. It is a
              draft field like the rest of `body`, so it only renders once
              GET_CONFIG has answered — firmware that has no name to give
              shows the identity rows and nothing else. */}
          {draft ? (
            <TextField
              label="CAMERA NAME"
              value={draft.name ?? ''}
              maxLength={24}
              placeholder={info.serial}
              onChange={(name) => patch((d) => ({ ...d, name }))}
            />
          ) : null}
        </Panel>

        <Panel title="STORAGE">
          {storage?.present ? (
            <>
              <dl>
                <div className="datarow"><dt>SD card</dt><dd><Led state={storage.mounted === false ? 'err' : 'ok'} label={storage.mounted === false ? 'NOT MOUNTED' : 'MOUNTED'} /></dd></div>
                <div className="datarow"><dt>Capacity</dt><dd>{formatMB(storage.totalMB)}</dd></div>
                <div className="datarow"><dt>Free</dt><dd>{formatMB(storage.freeMB)}</dd></div>
                {/* 1B diagnostics — device-reported only: pre-1B firmware
                    omits them and these rows say so instead of inventing. */}
                <div className="datarow"><dt>Filesystem</dt><dd>{storage.filesystem === undefined ? 'NOT REPORTED' : storage.filesystem ?? '—'}</dd></div>
                <div className="datarow"><dt>Mount attempts</dt><dd>{storage.mountAttempts ?? 'NOT REPORTED'}</dd></div>
                <div className="datarow"><dt>Write test</dt><dd>{storage.writeTestStatus === undefined ? 'NOT REPORTED' : storage.writeTestStatus.toUpperCase()}</dd></div>
                {storage.lastError ? (
                  <div className="datarow"><dt>Last error</dt><dd className="warn">{storage.lastError}</dd></div>
                ) : null}
              </dl>
              <div className="meter" style={{ marginTop: 6 }} role="img" aria-label={`Card ${sdUsedPct}% full`}>
                <div
                  className={`meter-fill ${sdUsedPct > 90 ? 'meter-fill--err' : sdUsedPct > 75 ? 'meter-fill--warn' : 'meter-fill--ok'}`}
                  style={{ width: `${sdUsedPct}%` }}
                />
              </div>
            </>
          ) : (
            <dl>
              <div className="datarow"><dt>SD card</dt><dd><Led state="err" label="NO CARD" /></dd></div>
              {storage?.lastError ? (
                <div className="datarow"><dt>Last error</dt><dd className="warn">{storage.lastError}</dd></div>
              ) : null}
            </dl>
          )}
        </Panel>

        <Panel title="POWER">
          <dl>
            {/* Null is the shipped answer on D4-V1, where nothing routes a
                sense divider or a gauge bus to the P4 (contract D10). It is
                not a number that is coming, and it is not 0.00 V. */}
            <div className="datarow"><dt>Battery</dt><dd>{power?.batteryV != null ? `${power.batteryV.toFixed(2)} V` : power ? 'NOT MEASURED' : '—'}</dd></div>
            <div className="datarow"><dt>Charge</dt><dd>{battMeasured ? `${battPct}%` : 'NOT MEASURED'}</dd></div>
            <div className="datarow">
              <dt>State</dt>
              <dd>
                {power?.charging ? (
                  <Led state="busy" label="CHARGING" />
                ) : battMeasured && battPct <= 15 ? (
                  <Led state="warn" label="LOW BATTERY" />
                ) : (
                  <Led state="ok" label={power?.state.toUpperCase() ?? '—'} />
                )}
              </dd>
            </div>
          </dl>
          {/* No gauge, no gauge drawing: an empty-looking meter is a reading. */}
          {battMeasured ? (
            <div className="meter" style={{ marginTop: 6 }} role="img" aria-label={`Battery ${battPct}%`}>
              <div
                className={`meter-fill ${battPct <= 15 ? 'meter-fill--err' : battPct <= 30 ? 'meter-fill--warn' : 'meter-fill--ok'}`}
                style={{ width: `${battPct}%` }}
              />
            </div>
          ) : null}
        </Panel>
      </div>

      {draft ? (
        <>
          <div className="panel-grid">
            <Panel title="REAR DISPLAY">
              <SliderField
                label="BRIGHTNESS"
                value={draft.brightness}
                min={1}
                max={10}
                disabled={!canDim}
                hint={canDim ? undefined : 'This camera drives its backlight from a plain on/off pin — it can only be lit or dark.'}
                onChange={(brightness) => patch((d) => ({ ...d, brightness }))}
              />
              <SegField
                label="AUTO-DIM"
                value={String(draft.autoDimS)}
                options={[
                  { value: '10', label: '10 S' },
                  { value: '20', label: '20 S' },
                  { value: '45', label: '45 S' },
                  { value: '0', label: 'NEVER' },
                ]}
                onChange={(v) => patch((d) => ({ ...d, autoDimS: Number(v) }))}
              />
              <SegField
                label="SLEEP"
                value={String(draft.sleepS)}
                options={[
                  { value: '60', label: '1 MIN' },
                  { value: '120', label: '2 MIN' },
                  { value: '300', label: '5 MIN' },
                  { value: '0', label: 'NEVER' },
                ]}
                onChange={(v) => patch((d) => ({ ...d, sleepS: Number(v) }))}
              />
              <SegField
                label="CAM BANK IDLE OFF"
                value={String(draft.camIdleTimeoutS)}
                options={[
                  { value: '120', label: '2 MIN' },
                  { value: '180', label: '3 MIN' },
                  { value: '300', label: '5 MIN' },
                  { value: '0', label: 'NEVER' },
                ]}
                onChange={(v) => patch((d) => ({ ...d, camIdleTimeoutS: Number(v) }))}
              />
            </Panel>

            <Panel title="BODY SOUNDS">
              <ToggleField
                label="STARTUP SOUND"
                checked={draft.sounds.startup}
                onChange={(startup) => patch((d) => ({ ...d, sounds: { ...d.sounds, startup } }))}
              />
              <ToggleField
                label="UI SOUNDS"
                checked={draft.sounds.ui}
                onChange={(ui) => patch((d) => ({ ...d, sounds: { ...d.sounds, ui } }))}
              />
              <ToggleField
                label="SAVE-COMPLETE SOUND"
                checked={draft.sounds.save}
                onChange={(save) => patch((d) => ({ ...d, sounds: { ...d.sounds, save } }))}
              />
              <ToggleField
                label="WARNING SOUND"
                checked={draft.sounds.warning}
                onChange={(warning) => patch((d) => ({ ...d, sounds: { ...d.sounds, warning } }))}
              />
              <div className="field">
                <span className="field-label">PREVIEW</span>
                <div className="control" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['startup', 'ui', 'save', 'warning'] as const).map((id) => (
                    <Button
                      key={id}
                      size="sm"
                      disabled={(config?.shoot.volume ?? 0) === 0}
                      onClick={() => playBuiltin(id, config?.shoot.volume ?? 6)}
                    >
                      {id.toUpperCase()}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="microlabel" style={{ marginBottom: 0 }}>
                {(config?.shoot.volume ?? 0) === 0 ? 'MASTER VOLUME IS MUTED — SET IT ON THE SHOOT PAGE' : 'PLAYS AT MASTER VOLUME FROM THE SHOOT PAGE'}
              </p>
            </Panel>
          </div>

          <Panel title="PHYSICAL CONTROLS">
            <SelectField
              label="FUNCTION BUTTON"
              value={draft.buttons.fn}
              options={[
                { value: 'flash', label: 'TOGGLE FLASH' },
                { value: 'mode', label: 'SWITCH WIGGLE / QUAD' },
                { value: 'next-look', label: 'NEXT LOOK' },
                { value: 'gallery', label: 'OPEN GALLERY' },
                { value: 'favorite', label: 'FAVORITE LAST SHOT' },
              ]}
              onChange={(v) => patch((d) => ({ ...d, buttons: { ...d.buttons, fn: v as BodyConfig['buttons']['fn'] } }))}
            />
            <SelectField
              label="SLIDE SWITCH"
              value={draft.buttons.slide}
              options={[
                { value: 'power-lock', label: 'POWER LOCK' },
                { value: 'mode', label: 'MODE SELECTOR' },
                { value: 'flash', label: 'FLASH SELECTOR' },
              ]}
              onChange={(v) =>
                patch((d) => ({ ...d, buttons: { ...d.buttons, slide: v as BodyConfig['buttons']['slide'] } }))
              }
            />
            <p className="dim" style={{ paddingTop: 6 }}>
              The shutter button is not remappable.
            </p>
          </Panel>
        </>
      ) : null}

      <Panel
        title="BACKUP"
        actions={
          <>
            <Button variant="primary" onClick={() => void backUp()}>
              BACK UP KINO
            </Button>
            <Button busy={restoreBusy} onClick={() => restoreFileRef.current?.click()}>
              RESTORE FROM FILE…
            </Button>
          </>
        }
      >
        <p className="dim">
          One .kino file with settings, calibration, custom looks and custom sounds. Photos are not included.
        </p>
        {backupNotice ? <p className="notice" style={{ marginTop: 8, marginBottom: 0 }}>{backupNotice}</p> : null}
        <input
          ref={restoreFileRef}
          type="file"
          accept=".kino,.json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickRestoreFile(f);
            e.target.value = '';
          }}
        />
      </Panel>

      <ApplyBar dirty={dirty} changeCount={changes} changedFields={changedFields} onApply={applyBody} onDiscard={discard} />

      {/* Restore overwrites every setting and every calibration value on the
          camera. It gets the red treatment and CANCEL keeps the focus. */}
      <ConfirmDialog
        open={pendingRestore !== null}
        danger
        title="RESTORE FROM BACKUP"
        confirmLabel="RESTORE"
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => void runRestore()}
      >
        {pendingRestore ? (
          (() => {
            const diffs = diffConfigs(
              { config: config ?? {}, calibration: state.calibration ?? {} },
              { config: pendingRestore.backup.config, calibration: pendingRestore.backup.calibration },
            );
            const shown = diffs.slice(0, 12);
            return (
              <>
                {info && pendingRestore.backup.device.serial !== info.serial ? (
                  <p className="warn" style={{ fontWeight: 600 }}>
                    This backup is from {pendingRestore.backup.device.serial}. The connected camera is {info.serial}
                    {pendingRestore.backup.device.hardware !== info.hardware
                      ? ` (hardware ${info.hardware}, backup is ${pendingRestore.backup.device.hardware})`
                      : ''}
                    . Per-camera calibration is measured on one physical unit — restoring it here applies another
                    camera's corrections.
                  </p>
                ) : null}
                <p>
                  Backup of <strong>{pendingRestore.backup.device.serial}</strong>,{' '}
                  {new Date(pendingRestore.backup.createdAt).toLocaleDateString()}. Writes{' '}
                  {plural(pendingRestore.backup.customRecipes.length, 'custom look')} and{' '}
                  {plural(pendingRestore.backup.customSounds.length, 'custom sound')}
                  {pendingRestore.skipped.length + pendingRestore.skippedSounds.length > 0
                    ? `, skips ${pendingRestore.skipped.length + pendingRestore.skippedSounds.length} invalid`
                    : ''}
                  . Photos are not touched.
                </p>
                {diffs.length === 0 ? (
                  <p className="dim" style={{ marginTop: 8 }}>
                    Settings and calibration are identical to the current state.
                  </p>
                ) : (
                  <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }} className="well">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>SETTING</th>
                          <th className="num">NOW</th>
                          <th className="num">AFTER</th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* Named the way the controls name themselves —
                            `config.body.sleepS 60 → 120` for a control whose
                            own options read 1 MIN / 2 MIN. The key path stays
                            available on hover. */}
                        {shown.map((d) => (
                          <tr key={d.path}>
                            <td title={d.path}>{diffLabel(d.path)}</td>
                            <td className="num">{configValue(d.path, d.from)}</td>
                            <td className="num">{configValue(d.path, d.to)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {diffs.length > shown.length ? (
                      <p className="microlabel" style={{ padding: '4px 8px' }}>
                        +{diffs.length - shown.length} MORE CHANGES
                      </p>
                    ) : null}
                  </div>
                )}
              </>
            );
          })()
        ) : (
          <p />
        )}
      </ConfirmDialog>
    </>
  );
}
