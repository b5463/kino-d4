import { useEffect, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ApplyBar } from '../../components/ApplyBar';
import { SegField, SelectField, SliderField, TextField, ToggleField } from '../../components/fields';
import { useDeviceStore, allRecipes } from '../../state/deviceStore';
import { useDraft } from '../../hooks/useDraft';
import { getDevice, refreshConfig } from '../../app/session';
import type { CamId, GainStrategy, QuadConfig, SlotColorMode, SlotFlash } from '@kino/kdp';
import { CAM_IDS } from '@kino/kdp';
import { formatEv } from '../../utils/format';

const PARTY_DEFAULT: QuadConfig['slots'] = {
  cam1: { recipeId: 'party-neg', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
  cam2: { recipeId: 'motion', exposureBias: 0.3, gain: 'low', flash: 'skip', colorMode: 'recipe', note: 'blur' },
  cam3: { recipeId: 'raw-digi', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: 'raw' },
  cam4: { recipeId: 'mono', exposureBias: -0.3, gain: 'high', flash: 'fire', colorMode: 'mono', note: 'b/w' },
};

// Built-in Quad sets. All of them are just slot data — nothing is written
// to the camera until APPLY TO KINO.
const QUAD_PRESETS: { name: string; slots: QuadConfig['slots'] }[] = [
  {
    name: 'FILM FOUR',
    slots: {
      cam1: { recipeId: 'chrome', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
      cam2: { recipeId: 'superia', exposureBias: 0.3, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
      cam3: { recipeId: 'vivid', exposureBias: 0, gain: 'low', flash: 'fire', colorMode: 'recipe', note: '' },
      cam4: { recipeId: 'mono', exposureBias: -0.3, gain: 'high', flash: 'fire', colorMode: 'mono', note: 'b/w' },
    },
  },
  {
    name: 'CHAOS',
    slots: {
      cam1: { recipeId: 'disposable', exposureBias: 1, gain: 'high', flash: 'fire', colorMode: 'recipe', note: 'over +1' },
      cam2: { recipeId: 'motion', exposureBias: 0.6, gain: 'low', flash: 'skip', colorMode: 'recipe', note: 'blur, no flash' },
      cam3: { recipeId: 'vivid', exposureBias: -1.2, gain: 'high', flash: 'fire', colorMode: 'recipe', note: 'under -1.2' },
      cam4: { recipeId: 'cold-flash', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'mono', note: 'b/w cold' },
    },
  },
  {
    name: 'RAW FOUR',
    slots: {
      cam1: { recipeId: 'raw-digi', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: 'straight' },
      cam2: { recipeId: 'raw-digi', exposureBias: -0.7, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '-0.7' },
      cam3: { recipeId: 'raw-digi', exposureBias: 0.7, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '+0.7' },
      cam4: { recipeId: 'raw-digi', exposureBias: -0.3, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '-0.3' },
    },
  },
];

export function QuadPage() {
  const state = useDeviceStore();
  const { draft, dirty, changes, changedFields, patch, discard } = useDraft<QuadConfig>(state.config?.quad ?? null, {
    key: 'quad',
    label: 'Quad',
  });
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  if (!draft) return null;

  const policyOff = state.config?.shoot.flashMode === 'off';

  const recipeOptions = allRecipes(state).map((r) => ({ value: r.id, label: r.name.toUpperCase() }));

  const patchSlot = (cam: CamId, slotPatch: Partial<QuadConfig['slots'][CamId]>) =>
    patch((d) => ({ ...d, slots: { ...d.slots, [cam]: { ...d.slots[cam], ...slotPatch } } }));

  // COPY TO used to change four fields with no acknowledgement at all — on
  // two slots that already matched, nothing on screen moved.
  const copySlot = (from: CamId, to: CamId) => {
    patch((d) => ({ ...d, slots: { ...d.slots, [to]: { ...d.slots[from] } } }));
    setCopied(`COPIED CAM ${from.slice(-1)} → CAM ${to.slice(-1)}`);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 4000);
  };

  const apply = async () => {
    const dev = getDevice();
    if (!dev) throw new Error('Not connected');
    await dev.applyConfig({ quad: draft });
    await refreshConfig();
  };

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="quad" />
          Quad
        </h1>
        <span className="microlabel" role="status">
          {copied ?? 'PER-CAMERA SETUP'}
        </span>
      </div>

      <Panel
        title="QUAD SETUP"
        actions={
          <>
            <span className="microlabel">SETS</span>
            {QUAD_PRESETS.map((preset) => (
              <Button
                key={preset.name}
                size="sm"
                onClick={() => patch((d) => ({ ...d, slots: structuredClone(preset.slots) }))}
              >
                {preset.name}
              </Button>
            ))}
            <Button onClick={() => patch((d) => ({ ...d, slots: structuredClone(PARTY_DEFAULT) }))}>
              RESET TO PARTY DEFAULT
            </Button>
          </>
        }
      >
        <ToggleField
          label="FLASH IN QUAD"
          checked={draft.flash}
          hint={
            policyOff
              ? 'Shoot › FLASH POLICY is OFF, so nothing fires regardless of this.'
              : 'Uses the flash policy set on Shoot. Each camera below then decides whether it exposes on the pulse.'
          }
          hintWarn={policyOff && draft.flash}
          onChange={(flash) => patch((d) => ({ ...d, flash }))}
        />
      </Panel>

      <div className="quadgrid">
        {CAM_IDS.map((cam) => {
          const slot = draft.slots[cam];
          const others = CAM_IDS.filter((c) => c !== cam);
          return (
            <Panel
              key={cam}
              title={`CAM ${cam.slice(-1)}`}
              actions={
                <>
                  <span className="microlabel">COPY TO</span>
                  {others.map((to) => (
                    <Button key={to} size="sm" onClick={() => copySlot(cam, to)}>
                      {to.toUpperCase().replace('CAM', 'CAM ')}
                    </Button>
                  ))}
                </>
              }
            >
              <SelectField
                label="LOOK"
                value={slot.recipeId}
                options={recipeOptions}
                onChange={(recipeId) => patchSlot(cam, { recipeId })}
              />
              <SliderField
                label="EXPOSURE BIAS"
                value={slot.exposureBias}
                min={-2}
                max={2}
                step={0.1}
                format={formatEv}
                onChange={(exposureBias) => patchSlot(cam, { exposureBias: Math.round(exposureBias * 10) / 10 })}
              />
              <SegField
                label="GAIN"
                value={slot.gain}
                options={[
                  { value: 'auto', label: 'AUTO' },
                  { value: 'low', label: 'LOW' },
                  { value: 'high', label: 'HIGH' },
                ]}
                onChange={(v) => patchSlot(cam, { gain: v as GainStrategy })}
              />
              <SegField
                label="FLASH"
                value={slot.flash}
                disabled={!draft.flash}
                hint={!draft.flash ? 'FLASH IN QUAD is off — no slot exposes on a pulse.' : undefined}
                options={[
                  { value: 'fire', label: 'FIRE' },
                  { value: 'skip', label: 'SKIP' },
                ]}
                onChange={(v) => patchSlot(cam, { flash: v as SlotFlash })}
              />
              <SegField
                label="COLOR"
                value={slot.colorMode}
                options={[
                  { value: 'recipe', label: 'FROM LOOK' },
                  { value: 'mono', label: 'FORCE MONO' },
                ]}
                onChange={(v) => patchSlot(cam, { colorMode: v as SlotColorMode })}
              />
              <TextField
                label="NOTE"
                value={slot.note}
                maxLength={32}
                placeholder="note"
                onChange={(note) => patchSlot(cam, { note })}
              />
            </Panel>
          );
        })}
      </div>

      <ApplyBar dirty={dirty} changeCount={changes} changedFields={changedFields} onApply={apply} onDiscard={discard} />
    </>
  );
}
