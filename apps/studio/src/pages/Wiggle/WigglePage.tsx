import { Panel } from '../../components/Panel';
import { Icon } from '../../components/Icon';
import { ApplyBar } from '../../components/ApplyBar';
import { WiggleViz } from '../../components/WiggleViz';
import { SegField, SelectField, SliderField, ToggleField } from '../../components/fields';
import { useDeviceStore, allRecipes, supports } from '../../state/deviceStore';
import { FlashNotFittedNote } from '../../components/FlashNote';
import { withNotReadHint } from '../../utils/firmwareHints';
import { useDraft } from '../../hooks/useDraft';
import { applyConfigChecked, getDevice, refreshDeviceInfo } from '../../app/session';
import type { CamId, Resolution, WiggleConfig, WiggleDirection, WiggleLoop } from '@kino/kdp';
import { allowedResolutions, RESOLUTIONS } from '../../utils/limits';

const RESOLUTION_LABEL: Record<Resolution, string> = {
  '1600x1200': '2M · 1600×1200',
  '2048x1536': '3M · 2048×1536',
};

const DENOISE_LABELS = [
  { value: '0', label: 'OFF' },
  { value: '1', label: 'LOW' },
  { value: '2', label: 'HIGH' },
];

const SHARPNESS_LABELS = [
  { value: '0', label: 'OFF' },
  { value: '1', label: 'MED' },
  { value: '2', label: 'HIGH' },
];

function speedLabel(fps: number): string {
  if (fps <= 6) return 'DREAMY';
  if (fps <= 8) return 'SLOW';
  if (fps <= 11) return 'NORMAL';
  if (fps <= 13) return 'FAST';
  return 'HYPER';
}

export function WigglePage() {
  const state = useDeviceStore();
  const config = state.config;
  const { draft, dirty, changes, changedFields, patch, discard, rebase } = useDraft<WiggleConfig>(
    config?.wiggle ?? null,
    { key: 'wiggle', label: 'Wiggle' },
  );

  if (!config || !draft) return null;

  // Flash reads top-down across the app: Shoot sets the policy, each mode
  // decides whether it uses it, Quad decides per slot.
  const policyOff = config.shoot.flashMode === 'off';

  const apply = async () => {
    const dev = getDevice();
    if (!dev) throw new Error('Not connected');
    // Fenced, and read back: `applyConfigChecked` takes the exclusive link
    // claim and reports which requested fields the camera did not keep.
    const { config: stored, refused } = await applyConfigChecked({ wiggle: draft });
    await dev.setActiveRecipe(draft.recipeId);
    await refreshDeviceInfo();
    // What the camera kept is now what the page shows. Leaving the refused
    // value in the draft is what made a successful save read as unsaved work.
    rebase(stored.wiggle);
    return { refused };
  };

  const recipeOptions = allRecipes(state).map((r) => ({ value: r.id, label: r.name.toUpperCase() }));

  const allowed = allowedResolutions(state.limits);
  const resolutionOptions = allowed.map((res) => ({ value: res, label: RESOLUTION_LABEL[res] }));
  // A draft holding a resolution the camera has since said it cannot do still
  // has to be visible — greying it out of the row would leave the field
  // showing a value with no selected option.
  if (!allowed.includes(draft.resolution)) {
    resolutionOptions.push({
      value: draft.resolution,
      label: `${RESOLUTION_LABEL[draft.resolution] ?? draft.resolution} (ABOVE THIS CAMERA'S LIMIT)`,
    });
  }

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="wiggle" />
          Wiggle
        </h1>
        <span className="microlabel">
          {config.mode === 'wiggle' ? 'ACTIVE MODE' : 'CONFIGURED · QUAD IS ACTIVE'}
        </span>
      </div>

      <Panel title="PLAYBACK">
        <WiggleViz fps={draft.fps} loop={draft.loop} direction={draft.direction} />
        <SliderField
          label="WIGGLE SPEED"
          value={draft.fps}
          min={5}
          max={15}
          format={(v) => `${v} FPS · ${speedLabel(v)}`}
          onChange={(fps) => patch((d) => ({ ...d, fps }))}
        />
        <SegField
          label="LOOP"
          value={draft.loop}
          options={[
            { value: 'bounce', label: 'BOUNCE' },
            { value: 'continuous', label: 'CONTINUOUS' },
            { value: 'sweep', label: 'ONE SWEEP' },
          ]}
          onChange={(v) => patch((d) => ({ ...d, loop: v as WiggleLoop }))}
        />
        <SegField
          label="DIRECTION"
          value={draft.direction}
          options={[
            { value: 'ltr', label: 'LEFT → RIGHT' },
            { value: 'rtl', label: 'RIGHT → LEFT' },
          ]}
          onChange={(v) => patch((d) => ({ ...d, direction: v as WiggleDirection }))}
        />
        {draft.loop === 'continuous' ? (
          <p className="dim" style={{ paddingTop: 6 }}>
            Continuous jumps from CAM4 straight back to CAM1 instead of bouncing.
          </p>
        ) : null}
      </Panel>

      <Panel title="CAPTURE">
        {/* Only what the camera says it can do. `limits.maxResolution` was
            read by nothing but the conformance suite, so a body that caps at
            2M was still offered 3M — a setting it refuses. */}
        <SegField
          label="RESOLUTION"
          value={draft.resolution}
          options={resolutionOptions}
          hint={
            resolutionOptions.length < RESOLUTIONS.length
              ? `This camera reports ${state.limits?.maxResolution} as its maximum.`
              : undefined
          }
          onChange={(v) => patch((d) => ({ ...d, resolution: v as Resolution }))}
        />
        <ToggleField
          label="FLASH IN WIGGLE"
          checked={draft.flash}
          hint={
            policyOff
              ? 'Shoot › FLASH POLICY is OFF, so nothing fires regardless of this.'
              : 'Uses the flash policy set on Shoot. All four cameras expose on the same pulse.'
          }
          hintWarn={policyOff && draft.flash}
          onChange={(flash) => patch((d) => ({ ...d, flash }))}
        />
        {!supports(state, 'flashHardware') ? <FlashNotFittedNote /> : null}
        <SelectField
          label="LOOK"
          value={draft.recipeId}
          options={recipeOptions}
          onChange={(recipeId) => patch((d) => ({ ...d, recipeId }))}
        />
        <SegField
          label="VIEWFINDER IN WIGGLE"
          hint={withNotReadHint(
            'Overrides Shoot › BODY VIEWFINDER while wiggle mode is active.',
            state.firmwareLabel,
          )}
          value={draft.previewCam}
          options={[
            { value: 'cam1', label: 'CAM1' },
            { value: 'cam2', label: 'CAM2' },
            { value: 'cam3', label: 'CAM3' },
            { value: 'cam4', label: 'CAM4' },
          ]}
          onChange={(v) => patch((d) => ({ ...d, previewCam: v as CamId }))}
        />
      </Panel>

      {/* Split out of CAPTURE: what the sensor records is a different decision
          from how the JPEG is squeezed afterwards. */}
      <Panel title="IMAGE PROCESSING">
        <SliderField
          label="JPEG QUALITY"
          value={draft.jpegQuality}
          min={60}
          max={95}
          format={(v) => `${v}${v >= 90 ? ' · LARGE FILES' : v <= 70 ? ' · VISIBLE ARTEFACTS' : ''}`}
          onChange={(jpegQuality) => patch((d) => ({ ...d, jpegQuality }))}
        />
        <SegField
          label="DENOISE"
          value={String(draft.denoise)}
          options={DENOISE_LABELS}
          onChange={(v) => patch((d) => ({ ...d, denoise: Number(v) }))}
        />
        <SegField
          label="SHARPENING"
          value={String(draft.sharpness)}
          options={SHARPNESS_LABELS}
          onChange={(v) => patch((d) => ({ ...d, sharpness: Number(v) }))}
        />
        <ToggleField
          label="SAVE ORIGINALS"
          checked={draft.saveOriginals}
          hint={withNotReadHint(undefined, state.firmwareLabel)}
          onChange={(saveOriginals) => patch((d) => ({ ...d, saveOriginals }))}
        />
        {!draft.saveOriginals ? (
          <p className="notice notice--warn" style={{ marginTop: 10, marginBottom: 0 }}>
            Off: only the assembled wigglegram is saved. The four source JPEGs are not kept, so a
            capture cannot be re-aligned or re-exported later.
          </p>
        ) : null}
      </Panel>

      <ApplyBar dirty={dirty} changeCount={changes} changedFields={changedFields} onApply={apply} onDiscard={discard} />
    </>
  );
}
