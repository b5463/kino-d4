import { useMemo, useState } from 'react';
import { D4_V1 } from '@kino/hardware-profiles';
import { ACTIVITY_PRESETS, computePower } from '@kino/simulator-engine';
import type { ActivityState, PowerSample, ThermalZone } from '@kino/simulator-engine';
import { useSimStore } from '../state/simStore';
import { tagLabel } from './SyncPanel';

type PresetKey = keyof typeof ACTIVITY_PRESETS;
const PRESET_LABELS: Record<PresetKey, string> = {
  idle: 'IDLE', preview: 'PREVIEW', quadCapture: 'QUAD CAPTURE', captureFlash: 'CAPTURE+FLASH',
  uartTransfer: 'UART TRANSFER', wifiUpload: 'WIFI UPLOAD', worstOverlap: 'WORST OVERLAP',
};
const THERMAL_ZONES: ThermalZone[] = ['battery', 'sw6106', 'led', 'heatsink', 'batteryConnector'];

function modeledSample(activity: ActivityState): PowerSample {
  return computePower(D4_V1.power, D4_V1.power.loads, activity, { overAsinceMs: null, nowMs: 0 });
}

export function PowerPanel() {
  const live = useSimStore((state) => state.power);
  const thermal = useSimStore((state) => state.thermal);
  const [preset, setPreset] = useState<PresetKey | null>(null);
  const [flashA, setFlashA] = useState<0.35 | 0.5 | 0.65>(0.35);
  const [chargeA, setChargeA] = useState(0);
  const sample = useMemo(() => {
    if (!preset) return live;
    return modeledSample({ ...ACTIVITY_PRESETS[preset], flashA, chargingA: chargeA });
  }, [chargeA, flashA, live, preset]);

  const chargeState = chargeA > D4_V1.power.battery.chargeMaxA ? 'critical' : chargeA > D4_V1.power.battery.chargePreferredA ? 'warn' : 'ok';

  return (
    <section className="twin-tool-panel" aria-label="Power analysis">
      <div className="twin-panel-heading"><span>POWER</span><span>{preset ? `${PRESET_LABELS[preset]} PINNED` : 'LIVE'}</span></div>
      {sample ? (
        <div className="twin-panel-section twin-power-grid">
          <span>BATTERY</span><strong>{sample.batteryV.toFixed(2)} V <small>{tagLabel(sample.tags.batteryV)}</small></strong>
          <span>BAT CURRENT</span><strong>{sample.batteryA.toFixed(2)} A <small>{tagLabel(sample.tags.batteryA)}</small></strong>
          <span>5 V BUS</span><strong>{sample.busV.toFixed(2)} V <small>{tagLabel(sample.tags.busV)}</small></strong>
          <span>BUS CURRENT</span><strong>{sample.busA.toFixed(2)} A <small>{tagLabel(sample.tags.busA)}</small></strong>
          <span>BOOST LOSS</span><strong>{sample.boostLossW.toFixed(2)} W <small>{tagLabel(sample.tags.boostLossW)}</small></strong>
          <span>FUSE</span><strong className={`twin-fuse twin-fuse--${sample.fuse}`}>{sample.fuse.toUpperCase()}</strong>
        </div>
      ) : <p className="twin-panel-empty">POWER ON for live samples, or pin a preset.</p>}

      <div className="twin-panel-section twin-button-grid">
        <button type="button" className={!preset ? 'twin-btn twin-btn--active' : 'twin-btn'} onClick={() => setPreset(null)}>LIVE</button>
        {(Object.keys(ACTIVITY_PRESETS) as PresetKey[]).map((key) => (
          <button type="button" className={preset === key ? 'twin-btn twin-btn--active' : 'twin-btn'} key={key} onClick={() => setPreset(key)}>
            {PRESET_LABELS[key]}
          </button>
        ))}
      </div>

      <div className="twin-panel-section">
        <span className="twin-field-label">FLASH CURRENT</span>
        {[0.35, 0.5, 0.65].map((value) => (
          <label className="twin-radio-row" key={value}>
            <input type="radio" checked={flashA === value} onChange={() => setFlashA(value as 0.35 | 0.5 | 0.65)} />
            {Math.round(value * 1_000)} mA {value === 0.35 ? '(DEFAULT)' : value === 0.5 ? '(EXPERIMENTAL)' : '(CONTROLLED TESTING)'}
          </label>
        ))}
        {flashA === 0.65 && <p className="twin-alert twin-alert--critical">650 mA — CONTROLLED TESTING ONLY</p>}
      </div>

      <div className="twin-panel-section">
        <label className="twin-control-row">
          <span>CHARGE A</span>
          <input className="twin-numeric" type="number" min={0} step={0.1} value={chargeA} onChange={(event) => setChargeA(Math.max(0, Number(event.target.value)))} />
        </label>
        {chargeState === 'warn' && <p className="twin-alert">ABOVE PREFERRED 600 mA</p>}
        {chargeState === 'critical' && <p className="twin-alert twin-alert--critical">OVER MAX 1.5 A</p>}
      </div>

      {sample && sample.warnings.length > 0 && <ul className="twin-warning-list">{sample.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      <div className="twin-panel-section twin-thermal-grid">
        {THERMAL_ZONES.map((zone) => <span key={zone} className={`twin-thermal twin-thermal--${thermal[zone].toLowerCase()}`}>{zone.toUpperCase()} {thermal[zone]}</span>)}
      </div>
    </section>
  );
}
