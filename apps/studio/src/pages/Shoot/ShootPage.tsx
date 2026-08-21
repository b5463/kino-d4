import { useEffect, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/Button';
import { ApplyBar } from '../../components/ApplyBar';
import { SegField, SelectField, SliderField } from '../../components/fields';
import { useDeviceStore, supports } from '../../state/deviceStore';
import { FocusPanel } from './FocusPanel';
import { useDraft } from '../../hooks/useDraft';
import { getDevice, refreshConfig, refreshDeviceInfo } from '../../app/session';
import type { CamId, ShootConfig, ShootMode } from '@kino/kdp';
import { BUILTIN_SHUTTER_SOUNDS } from '@kino/kdp';
import type { BuiltinSoundId } from '../../utils/soundFx';
import { playBuiltin, playWav } from '../../utils/soundFx';
import { readSound } from '../../device/sounds';
import { CustomSoundsPanel } from './CustomSoundsPanel';

// Live viewfinder. The P4 already receives the preview stream for its own
// display; Studio polls single frames over USB. Rate is UART-bound, not
// USB-bound, so ~4-5 fps is the realistic ceiling.
//
// The camera picker here is deliberately NOT the shoot.viewfinder setting:
// looking through CAM3 to check focus should not rewrite what the body's own
// screen shows. It starts on the body setting and stays local after that.
function ViewfinderPanel({ defaultCam }: { defaultCam: CamId }) {
  const [running, setRunning] = useState(false);
  const [cam, setCam] = useState<CamId>(defaultCam);
  const [fpsActual, setFpsActual] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let count = 0;
    let t0 = performance.now();
    void (async () => {
      while (alive) {
        const dev = getDevice();
        if (!dev) break;
        try {
          const bytes = await dev.previewFrame(cam);
          if (!alive) break;
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = url;
          if (imgRef.current) imgRef.current.src = url;
          count++;
          const dt = performance.now() - t0;
          if (dt > 1000) {
            setFpsActual(Math.round((count * 1000) / dt));
            count = 0;
            t0 = performance.now();
          }
          setErr(null);
        } catch (e) {
          if (alive) setErr(e instanceof Error ? e.message : String(e));
          await new Promise((r) => setTimeout(r, 800));
        }
        await new Promise((r) => setTimeout(r, 180));
      }
    })();
    return () => {
      alive = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      setFpsActual(0);
    };
  }, [running, cam]);

  return (
    <Panel
      title="VIEWFINDER"
      actions={
        <Button variant={running ? 'default' : 'primary'} size="sm" onClick={() => setRunning(!running)}>
          {running ? 'STOP' : 'START'}
        </Button>
      }
    >
      <div className="well well--dark" style={{ padding: 6, display: 'flex', justifyContent: 'center', minHeight: 180 }}>
        {running ? (
          <img ref={imgRef} alt={`Live view from ${cam.toUpperCase()}`} style={{ maxWidth: '100%', display: 'block' }} />
        ) : (
          <span className="faint mono" style={{ alignSelf: 'center', fontSize: 11 }}>
            VIEWFINDER STOPPED
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, gap: 12, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="microlabel">PREVIEW FROM</span>
          <span className="seg" role="group" aria-label="Preview camera for this window">
            {(['cam1', 'cam2', 'cam3', 'cam4'] as CamId[]).map((c) => (
              <button key={c} type="button" className="seg-opt" aria-pressed={cam === c} onClick={() => setCam(c)}>
                {c.toUpperCase()}
              </button>
            ))}
          </span>
        </span>
        <span className="microlabel">{running ? `~${fpsActual} FPS · UART LIMITED` : '320×240 PREVIEW'}</span>
      </div>
      <p className="dim" style={{ paddingTop: 6, marginBottom: 0 }}>
        This window only. The camera's own screen keeps using BODY VIEWFINDER below.
      </p>
      {err ? <p className="notice notice--err" style={{ marginTop: 8, marginBottom: 0 }}>{err}</p> : null}
    </Panel>
  );
}

// General shooting behavior — mode, flash policy, viewfinder, sounds and
// review. Wiggle- and Quad-specific settings live on their own pages.
export function ShootPage() {
  const state = useDeviceStore();
  const config = state.config;
  const storage = state.storage;
  const { draft, dirty, changes, changedFields, patch, discard } = useDraft<ShootConfig>(config?.shoot ?? null, {
    key: 'shoot',
    label: 'Shoot',
  });
  const [modeBusy, setModeBusy] = useState(false);
  const [playBusy, setPlayBusy] = useState(false);

  if (!config || !draft) return null;

  // Preview exactly what the draft would sound like on the body: the
  // selected sound at the selected volume. Custom clips come off the device
  // (cached after the first read).
  const playShutter = async () => {
    if (playBusy) return;
    const id = draft.shutterSound;
    if ((BUILTIN_SHUTTER_SOUNDS as readonly string[]).includes(id)) {
      playBuiltin(id as BuiltinSoundId, draft.volume);
      return;
    }
    const info = state.sounds.find((s) => s.id === id);
    const dev = getDevice();
    if (!info || !dev) return;
    setPlayBusy(true);
    try {
      await playWav(await readSound(dev, info), draft.volume);
    } finally {
      setPlayBusy(false);
    }
  };

  const shutterOptions = [
    { value: 'click', label: 'CLICK' },
    { value: 'cheap-digi', label: 'CHEAP DIGI' },
    { value: 'tiny-beep', label: 'TINY BEEP' },
    { value: 'mechanical', label: 'MECHANICAL-ISH' },
    { value: 'silent', label: 'SILENT' },
    ...state.sounds.map((s) => ({ value: s.id, label: s.name.toUpperCase() })),
  ];
  // A dirty draft can still point at a clip deleted below — keep it visible.
  if (!shutterOptions.some((o) => o.value === draft.shutterSound)) {
    shutterOptions.push({ value: draft.shutterSound, label: `${draft.shutterSound.toUpperCase()} (DELETED)` });
  }

  const setMode = async (mode: ShootMode) => {
    if (mode === config.mode || modeBusy) return;
    const dev = getDevice();
    if (!dev) return;
    setModeBusy(true);
    try {
      await dev.setMode(mode);
      await Promise.all([refreshConfig(), refreshDeviceInfo()]);
    } finally {
      setModeBusy(false);
    }
  };

  const apply = async () => {
    const dev = getDevice();
    if (!dev) throw new Error('Not connected');
    await dev.applyConfig({ shoot: draft });
    await refreshConfig();
  };

  // Rough shots-remaining estimate from free space and current resolution.
  const avgShotKB = (config.wiggle.resolution === '2048x1536' ? 560 : 420) * 4;
  const shotsLeft = storage?.present ? Math.floor((storage.freeMB * 1024) / avgShotKB) : 0;

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="shoot" />
          Shoot
        </h1>
        <span className="microlabel">
          {storage?.present ? `≈ ${shotsLeft.toLocaleString()} SHOTS REMAINING` : 'NO SD CARD'}
        </span>
      </div>

      <div className="modeselect" role="group" aria-label="Shooting mode">
        <button
          type="button"
          className="modecard"
          aria-pressed={config.mode === 'wiggle'}
          disabled={modeBusy}
          onClick={() => void setMode('wiggle')}
        >
          <div className="modecard-name">
            <Icon name="wiggle" />
            WIGGLE
          </div>
          <p className="modecard-desc">
            Same settings on all four cameras. Playback 1→2→3→4→3→2.
          </p>
        </button>
        <button
          type="button"
          className="modecard"
          aria-pressed={config.mode === 'quad'}
          disabled={modeBusy}
          onClick={() => void setMode('quad')}
        >
          <div className="modecard-name">
            <Icon name="quad" />
            QUAD
          </div>
          <p className="modecard-desc">
            Each camera uses its own look and exposure. One shutter press, four different photos.
          </p>
        </button>
      </div>

      <ViewfinderPanel defaultCam={config.shoot.viewfinder} />

      <Panel title="CAPTURE">
        <SegField
          label="FLASH POLICY"
          value={draft.flashMode}
          options={[
            { value: 'auto', label: 'AUTO' },
            { value: 'on', label: 'ON' },
            { value: 'off', label: 'OFF' },
          ]}
          hint="Top level. OFF here means nothing fires in either mode. AUTO fires when the meter says the scene is dark."
          onChange={(v) => patch((d) => ({ ...d, flashMode: v as ShootConfig['flashMode'] }))}
        />
        <SegField
          label="BODY VIEWFINDER"
          value={draft.viewfinder}
          options={[
            { value: 'cam1', label: 'CAM1' },
            { value: 'cam2', label: 'CAM2' },
            { value: 'cam3', label: 'CAM3' },
            { value: 'cam4', label: 'CAM4' },
          ]}
          hint="Which camera the KINO screen shows while composing. CAM2 is the metering camera."
          onChange={(v) => patch((d) => ({ ...d, viewfinder: v as CamId }))}
        />
        <SegField
          label="PREVIEW QUALITY"
          value={draft.previewQuality}
          options={[
            { value: 'low', label: 'LOW' },
            { value: 'normal', label: 'NORMAL' },
            { value: 'high', label: 'HIGH' },
          ]}
          onChange={(v) => patch((d) => ({ ...d, previewQuality: v as ShootConfig['previewQuality'] }))}
        />
        <SegField
          label="REVIEW AFTER SHOT"
          value={String(draft.displayAfterShotS)}
          options={[
            { value: '0', label: 'OFF' },
            { value: '1', label: '1 S' },
            { value: '2', label: '2 S' },
            { value: '3', label: '3 S' },
            { value: '-1', label: 'HOLD' },
          ]}
          onChange={(v) => patch((d) => ({ ...d, displayAfterShotS: Number(v) }))}
        />
      </Panel>

      <Panel
        title="CAMERA SOUNDS"
        actions={
          <Button
            size="sm"
            busy={playBusy}
            disabled={draft.shutterSound === 'silent' || draft.volume === 0}
            onClick={() => void playShutter()}
          >
            PLAY
          </Button>
        }
      >
        <SelectField
          label="SHUTTER SOUND"
          value={draft.shutterSound}
          options={shutterOptions}
          onChange={(v) => patch((d) => ({ ...d, shutterSound: v }))}
        />
        <SliderField
          label="VOLUME"
          value={draft.volume}
          min={0}
          max={10}
          format={(v) => (v === 0 ? 'MUTE' : String(v))}
          onChange={(volume) => patch((d) => ({ ...d, volume }))}
        />
      </Panel>

      {supports(state, 'autofocus') ? <FocusPanel /> : null}

      <CustomSoundsPanel />

      <ApplyBar dirty={dirty} changeCount={changes} changedFields={changedFields} onApply={apply} onDiscard={discard} />
    </>
  );
}
