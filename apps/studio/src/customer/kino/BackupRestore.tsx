import { useRef, useState } from 'react';
import { getDevice, refreshCalibration, refreshConfig, refreshDeviceInfo, refreshRecipes, refreshSounds } from '../../app/session';
import { blockedBy, claimDevice, releaseDevice } from '../../state/deviceBusy';
import { supports, useDeviceStore } from '../../state/deviceStore';
import { backupFilename, base64ToBytes, buildBackup, bytesToBase64, validateBackup } from '../../device/backup';
import type { BackupSound, KinoBackup } from '../../device/backup';
import { readSound, uploadSound } from '../../device/sounds';
import { downloadText } from '../../utils/download';
import { ConfirmSheet } from '../Dialog';
import { useReadOnly } from '../useReadOnly';
import { SettingRow } from './Setting';

const OWNER = 'restore';

/**
 * Back up: "Save KINO's settings and looks to a file." Restore: "Put settings
 * back from a backup file." A backup from another KINO asks once, in plain
 * words. The writes take the link's claim like every long operation.
 */
export function BackupRestore() {
  const state = useDeviceStore();
  const readOnly = useReadOnly();
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<KinoBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { info, config, calibration } = state;

  const backUp = async () => {
    setNote(null);
    if (!info || !config || !calibration) {
      setNote("KINO hasn't reported its settings yet. Try again in a moment.");
      return;
    }
    let sounds: BackupSound[] = [];
    const dev = getDevice();
    if (dev && state.sounds.length > 0) {
      try {
        sounds = await Promise.all(state.sounds.map(async (s) => ({ id: s.id, name: s.name, durationMs: s.durationMs, wavBase64: bytesToBase64(await readSound(dev, s)) })));
      } catch {
        setNote("KINO's sounds couldn't be read. Try again.");
        return;
      }
    }
    downloadText(backupFilename(info), JSON.stringify(buildBackup(info, config, calibration, state.customRecipes, sounds), null, 2), 'application/json');
    setNote('Saved. Photos stay on the card.');
  };

  const pick = (file: File) => {
    setNote(null);
    void file.text().then((text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setNote("That file isn't a KINO backup.");
        return;
      }
      const check = validateBackup(json);
      if (!check.ok || !check.backup) {
        setNote("That file isn't a KINO backup.");
        return;
      }
      setPending(check.backup);
    });
  };

  const restore = async () => {
    const dev = getDevice();
    const backup = pending;
    setPending(null);
    if (!dev || !backup) return;
    if (!claimDevice(OWNER, 'RESTORING KINO')) {
      setNote(`${blockedBy(OWNER) ?? 'Something else'} is using KINO. Try again in a moment.`);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      if (supports(state, 'customSounds')) {
        for (const snd of backup.customSounds) {
          const wav = base64ToBytes(snd.wavBase64);
          await uploadSound(dev, { id: snd.id, name: snd.name, sizeBytes: wav.length, durationMs: snd.durationMs }, wav);
        }
      }
      await dev.applyConfig(backup.config);
      await dev.applyCalibration(backup.calibration.cams);
      for (const recipe of backup.customRecipes) await dev.uploadRecipe({ ...recipe, factory: false });
    } catch {
      setNote('The restore stopped partway. Check the settings before shooting, then try again.');
      setBusy(false);
      releaseDevice(OWNER);
      return;
    }
    releaseDevice(OWNER);
    try {
      await Promise.all([refreshConfig(), refreshCalibration(), refreshRecipes(), refreshSounds().catch(() => undefined), refreshDeviceInfo()]);
    } catch {
      // The poll re-reads on its own tick.
    }
    setNote('Restored.');
    setBusy(false);
  };

  const otherKino = pending && info && pending.device.serial !== info.serial;

  return (
    <>
      <SettingRow label="Back up" action="Back up" disabled={readOnly} onAction={() => void backUp()}>
        Save KINO's settings and looks to a file.
      </SettingRow>
      <SettingRow label="Restore" action="Restore…" disabled={readOnly || busy} onAction={() => fileRef.current?.click()}>
        Put settings back from a backup file.
        {note ? <span className="c-quiet">{note}</span> : null}
      </SettingRow>
      <input
        ref={fileRef}
        type="file"
        accept=".kino,.json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) pick(f);
          e.target.value = '';
        }}
      />
      <ConfirmSheet open={pending !== null} confirmLabel={otherKino ? 'Restore anyway' : 'Restore'} warning={Boolean(otherKino)} onCancel={() => setPending(null)} onConfirm={() => void restore()}>
        {otherKino ? (
          <p>This backup is from a different KINO. Restore anyway? Its lens matching was measured on that KINO, not this one.</p>
        ) : (
          <p>Put settings and looks back from this backup? Photos on the card are not touched.</p>
        )}
      </ConfirmSheet>
    </>
  );
}
