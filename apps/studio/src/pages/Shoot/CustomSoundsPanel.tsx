import { useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Unsupported } from '../../components/Unsupported';
import { useDeviceStore, supports } from '../../state/deviceStore';
import { getDevice, refreshSounds, refreshConfig } from '../../app/session';
import { dropSound, readSound, uploadSound } from '../../device/sounds';
import { playWav, prepareSoundFile, soundIdFromName, soundNameFromFile } from '../../utils/soundFx';
import type { SoundInfo } from '../../protocol/types';

// Uploaded clips stored on the KINO. Unlike the shutter-sound selection
// above (draft + apply), everything here writes to the device immediately —
// same contract as the Looks page.
export function CustomSoundsPanel() {
  const state = useDeviceStore();
  const sounds = state.sounds;
  const limits = state.soundLimits;
  const volume = state.config?.shoot.volume ?? 6;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null); // sound id, or 'upload'
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SoundInfo | null>(null);

  if (!supports(state, 'customSounds')) {
    return (
      <Panel title="CUSTOM SOUNDS">
        <Unsupported feature="Custom sounds" firmware={state.firmwareLabel} />
      </Panel>
    );
  }

  const maxCustom = limits?.maxCustom ?? 8;
  const full = sounds.length >= maxCustom;

  const importFile = async (file: File) => {
    setNotice(null);
    setBusy('upload');
    setProgress(0);
    try {
      const dev = getDevice();
      if (!dev) throw new Error('Not connected');
      const prepared = await prepareSoundFile(file);
      const maxBytes = (limits?.maxSoundKB ?? 128) * 1024;
      if (prepared.wav.length > maxBytes) {
        throw new Error(`Converted sound is ${Math.ceil(prepared.wav.length / 1024)} KB — device limit is ${limits?.maxSoundKB ?? 128} KB`);
      }
      const name = soundNameFromFile(file.name);
      await uploadSound(
        dev,
        { id: soundIdFromName(file.name), name, sizeBytes: prepared.wav.length, durationMs: prepared.durationMs },
        prepared.wav,
        (done, total) => setProgress(Math.round((done / total) * 100)),
      );
      await refreshSounds();
      if (prepared.trimmed) setNotice(`${name}: longer than 2.0 s, end cut off.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setProgress(0);
    }
  };

  const play = async (s: SoundInfo) => {
    const dev = getDevice();
    if (!dev || busy) return;
    setBusy(s.id);
    try {
      await playWav(await readSound(dev, s), volume);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const del = async (s: SoundInfo) => {
    setDeleteTarget(null);
    const dev = getDevice();
    if (!dev) return;
    setBusy(s.id);
    try {
      await dev.soundDelete(s.id);
      dropSound(s.id);
      // The device resets the shutter sound if it pointed at the deleted clip.
      await Promise.all([refreshSounds(), refreshConfig()]);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="CUSTOM SOUNDS"
      actions={
        <Button size="sm" disabled={busy !== null || full} busy={busy === 'upload'} onClick={() => fileRef.current?.click()}>
          {busy === 'upload' ? `UPLOADING ${progress}%` : 'ADD SOUND'}
        </Button>
      }
    >
      {notice ? <p className="notice">{notice}</p> : null}

      {sounds.length === 0 ? (
        <p className="faint" style={{ padding: '4px 0' }}>No custom sounds on this KINO.</p>
      ) : (
        sounds.map((s) => (
          <div key={s.id} className="field" style={{ alignItems: 'center' }}>
            <span className="field-label" style={{ textTransform: 'none' }}>{s.name}</span>
            <div className="control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="microlabel">
                {(s.durationMs / 1000).toFixed(1)} S · {Math.max(1, Math.round(s.sizeBytes / 1024))} KB
              </span>
              <Button size="sm" disabled={busy !== null} onClick={() => void play(s)}>
                PLAY
              </Button>
              <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => setDeleteTarget(s)}>
                DELETE
              </Button>
            </div>
          </div>
        ))
      )}

      <p className="microlabel" style={{ paddingTop: 8, marginBottom: 0 }}>
        {sounds.length}/{maxCustom} SLOTS · MAX 2.0 S · STORED AS 16 KHZ MONO WAV · SAME FILE NAME REPLACES
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.target.value = '';
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="DELETE SOUND"
        danger
        confirmLabel="DELETE"
        onConfirm={() => deleteTarget && void del(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      >
        <p>
          Delete “{deleteTarget?.name}” from the KINO? If it is the shutter sound, the camera falls back to CLICK.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
