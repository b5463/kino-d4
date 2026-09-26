import { useEffect, useState } from 'react';
import type { BodyConfig } from '@kino/kdp';
import { applyConfigChecked } from '../../app/session';
import { supports, useDeviceStore } from '../../state/deviceStore';
import { useReadOnly } from '../useReadOnly';
import { useRowMarks } from '../shoot/useSaved';
import type { RowMark } from '../shoot/useSaved';
import { SettingMark } from './Setting';

/** Screen sleep, in the camera's own steps. */
export const SLEEP_OPTIONS = [
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
  { value: 0, label: 'Never' },
] as const;

/**
 * Camera: the few body settings a customer changes. Name, screen sleep,
 * button sounds; brightness only on a body that can dim. Time zone is not
 * here because Studio sets the clock from this computer on every connect.
 */
export function CameraSettings() {
  const state = useDeviceStore();
  const body = state.config?.body ?? null;
  const readOnly = useReadOnly();
  const { save, mark, retry } = useRowMarks();
  const canDim = supports(state, 'brightnessControl') && state.capabilities?.brightnessControl === true;
  if (!body) return null;
  const write = (row: string, patch: Partial<BodyConfig>, differs: (stored: BodyConfig) => boolean) =>
    void save(row, async () => differs((await applyConfigChecked({ body: { ...body, ...patch } })).config.body));
  return <CameraSettingsList body={body} placeholder={state.info?.serial ?? ''} canDim={canDim} readOnly={readOnly} write={write} mark={mark} retry={retry} />;
}

/** The list itself, prop-driven so a static render can assert what it prints. */
export function CameraSettingsList({
  body,
  placeholder,
  canDim,
  readOnly,
  write,
  mark,
  retry,
}: {
  body: BodyConfig;
  placeholder: string;
  canDim: boolean;
  readOnly: boolean;
  write: (row: string, patch: Partial<BodyConfig>, differs: (stored: BodyConfig) => boolean) => void;
  mark: (row: string) => RowMark;
  retry: (row: string) => void;
}) {
  const [name, setName] = useState(body.name ?? '');
  useEffect(() => {
    setName(body.name ?? '');
  }, [body.name]);

  const commitName = () => {
    const next = name.trim().slice(0, 24);
    if (next === (body.name ?? '')) return;
    write('name', { name: next }, (s) => (s.name ?? '') !== next);
  };

  return (
    <>
      <h2>Camera</h2>
      <div className="c-setting">
        <span className="c-setting-label">Name</span>
        <span className="c-setting-body">
          <input
            className="c-field"
            aria-label="Name"
            value={name}
            maxLength={24}
            placeholder={placeholder}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </span>
        <SettingMark mark={mark('name')} onRetry={() => retry('name')} />
      </div>
      <div className="c-setting" role="group" aria-label="Screen sleeps after">
        <span className="c-setting-label">Screen sleeps after</span>
        <span className="c-setting-body c-pair">
          {SLEEP_OPTIONS.map((o, i) => (
            <span key={o.value} className="c-pair">
              {i > 0 ? <span className="c-dot">·</span> : null}
              <button type="button" className={body.sleepS === o.value ? 'c-word' : 'c-word c-word--quiet'} aria-pressed={body.sleepS === o.value} disabled={readOnly} onClick={() => write('sleep', { sleepS: o.value }, (s) => s.sleepS !== o.value)}>
                {o.label}
              </button>
            </span>
          ))}
        </span>
        <SettingMark mark={mark('sleep')} onRetry={() => retry('sleep')} />
      </div>
      <div className="c-setting" role="group" aria-label="Button sounds">
        <span className="c-setting-label">Button sounds</span>
        <span className="c-setting-body c-pair">
          <button type="button" className={body.sounds.ui ? 'c-word c-word--quiet' : 'c-word'} aria-pressed={!body.sounds.ui} disabled={readOnly} onClick={() => write('ui', { sounds: { ...body.sounds, ui: false } }, (s) => s.sounds.ui)}>
            Off
          </button>
          <span className="c-dot">·</span>
          <button type="button" className={body.sounds.ui ? 'c-word' : 'c-word c-word--quiet'} aria-pressed={body.sounds.ui} disabled={readOnly} onClick={() => write('ui', { sounds: { ...body.sounds, ui: true } }, (s) => !s.sounds.ui)}>
            On
          </button>
        </span>
        <SettingMark mark={mark('ui')} onRetry={() => retry('ui')} />
      </div>
      {canDim ? (
        <div className="c-setting">
          <span className="c-setting-label">Brightness</span>
          <span className="c-setting-body">
            <span className="c-slider">
              <input type="range" min={1} max={10} step={1} defaultValue={body.brightness} aria-label="Brightness" disabled={readOnly} onChange={(e) => write('brightness', { brightness: Number(e.target.value) }, (s) => s.brightness !== Number(e.target.value))} />
            </span>
          </span>
          <SettingMark mark={mark('brightness')} onRetry={() => retry('brightness')} />
        </div>
      ) : null}
    </>
  );
}
