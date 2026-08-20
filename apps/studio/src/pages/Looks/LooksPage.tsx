import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ApplyBar } from '../../components/ApplyBar';
import { SegField, SliderField, TextField } from '../../components/fields';
import { useDeviceStore, allRecipes } from '../../state/deviceStore';
import { useDraft } from '../../hooks/useDraft';
import { dropDraft } from '../../state/draftStore';
import { getDevice, refreshRecipes, refreshDeviceInfo } from '../../app/session';
import type { Recipe } from '../../recipes/recipeTypes';
import { IDENTITY_MATRIX, validateRecipe } from '../../recipes/recipeTypes';
import { DEVICE_LUT_SIZE, parseCubeLut } from '../../recipes/cubeLut';
import { downloadJson } from '../../utils/download';
import { formatEv, formatSigned } from '../../utils/format';
import { previewBackingSize, renderLookPreview } from '../../utils/lookPreview';

/** No sr-only utility in the stylesheet, and CSS is off-limits here. */
const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Changed leaf fields between draft and device truth, for the discard prompt. */
function countChangedLeaves(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return 1;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let n = 0;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    n += countChangedLeaves(left[key], right[key]);
  }
  return n;
}

function LookPreview({ recipe }: { recipe: Recipe | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));

  // The canvas sizes its backing store from its own box, so a paint has to
  // survive both recipe changes and layout changes. Latest state goes through
  // a ref and every trigger collapses onto one animation frame.
  const shown = showOriginal ? null : recipe;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const frameRef = useRef(0);

  const paint = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      if (canvasRef.current) renderLookPreview(canvasRef.current, shownRef.current);
    });
  }, []);

  useEffect(() => {
    paint();
  }, [shown, dpr, paint]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Repaint only when the box actually implies a different backing store —
    // setting one changes the element's intrinsic height, which would
    // otherwise feed the observer its own output.
    const ro = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { w, h } = previewBackingSize(canvas);
      if (canvas.width !== w || canvas.height !== h) paint();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [paint]);

  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);

  return (
    <Panel title="PREVIEW">
      <div className="lookpreview">
        <div className="well well--dark lookpreview-well">
          {/* The attributes only set the 4:3 intrinsic ratio so the element
              has its final box before the first paint resizes the backing
              store; CSS width:100% decides the drawn size. */}
          <canvas
            ref={canvasRef}
            width={340}
            height={255}
            aria-label="Sample scene with this look applied"
          />
        </div>
        <div className="lookpreview-tools">
          <span className="microlabel">SAMPLE SCENE · APPROXIMATE PREVIEW</span>
          <button
            type="button"
            className="btn btn--sm"
            aria-pressed={showOriginal}
            onMouseDown={() => setShowOriginal(true)}
            onMouseUp={() => setShowOriginal(false)}
            onMouseLeave={() => setShowOriginal(false)}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') setShowOriginal(true);
            }}
            onKeyUp={() => setShowOriginal(false)}
          >
            HOLD FOR ORIGINAL
          </button>
        </div>
      </div>
    </Panel>
  );
}

export function LooksPage() {
  const state = useDeviceStore();
  const [selectedId, setSelectedId] = useState<string>('party-neg');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cubeRef = useRef<HTMLInputElement>(null);

  const recipes = allRecipes(state);
  const selected = recipes.find((r) => r.id === selectedId) ?? recipes[0] ?? null;
  // Keyed per look: an unsaved edit to Party Neg must not follow you onto
  // Mono, and it must still be there when you come back from another section.
  const { draft, dirty, changedFields, patch, discard } = useDraft<Recipe>(selected, {
    key: `looks:${selected?.id ?? 'none'}`,
    label: 'Looks',
  });

  const activeRecipeId = state.info?.activeRecipe;
  const takenIds = new Set(recipes.map((r) => r.id));

  const withDevice = async (fn: (dev: NonNullable<ReturnType<typeof getDevice>>) => Promise<void>) => {
    const dev = getDevice();
    if (!dev) return;
    setNotice(null);
    try {
      await fn(dev);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const saveToKino = async () => {
    const dev = getDevice();
    if (!dev || !draft) throw new Error('Not connected');
    await dev.uploadRecipe({ ...draft, factory: false });
    await refreshRecipes();
  };

  const saveAsCustom = (source: Recipe) =>
    withDevice(async (dev) => {
      const id = uniqueId(`${source.id.replace(/-\d+$/, '')}-custom`, takenIds);
      const copy: Recipe = {
        ...structuredClone(source),
        id,
        name: uniqueId(`${source.name} Custom`, new Set(recipes.map((r) => r.name))).slice(0, 40),
        factory: false,
      };
      await dev.uploadRecipe(copy);
      await refreshRecipes();
      setSelectedId(id);
      setNotice(`Saved as ${copy.name}`);
    });

  /**
   * Duplicates the look **as stored on KINO**, never the unsaved draft.
   *
   * Copying the draft wrote the edit into the copy and left the original
   * dirty, so the status bar said `UNSAVED: Looks` with no unsaved control
   * anywhere on screen. Unsaved work now stays on the look it belongs to —
   * and so does the selection, or the ApplyBar holding it would scroll out of
   * existence. Either way the notice says which.
   */
  const duplicate = (source: Recipe) =>
    withDevice(async (dev) => {
      const unsaved = draft ? countChangedLeaves(draft, source) : 0;
      const id = uniqueId(`${source.id}-copy`, takenIds);
      const copy: Recipe = { ...structuredClone(source), id, name: `${source.name} Copy`.slice(0, 40), factory: false };
      await dev.uploadRecipe(copy);
      await refreshRecipes();
      if (unsaved === 0) setSelectedId(id);
      setNotice(
        unsaved === 0
          ? `Duplicated ${source.name} as ${copy.name}. Editing the copy.`
          : `Duplicated ${source.name} as saved on KINO — ${copy.name}. Your ${unsaved} unsaved change${unsaved === 1 ? '' : 's'} stayed on ${source.name}, still open here.`,
      );
    });

  const remove = () =>
    withDevice(async (dev) => {
      if (!selected) return;
      const goneId = selected.id;
      await dev.deleteRecipe(goneId);
      dropDraft(`looks:${goneId}`);
      await refreshRecipes();
      setSelectedId('party-neg');
      setDeleteOpen(false);
    });

  const useForWiggle = (id: string) =>
    withDevice(async (dev) => {
      await dev.setActiveRecipe(id);
      await refreshDeviceInfo();
    });

  const importJson = (file: File) => {
    void file.text().then((text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setNotice('Import failed: file is not valid JSON');
        return;
      }
      const check = validateRecipe(json);
      if (!check.ok) {
        setNotice(`Import failed: ${check.error}`);
        return;
      }
      void withDevice(async (dev) => {
        const recipe = check.recipe;
        if (state.factoryRecipes.some((r) => r.id === recipe.id)) {
          recipe.id = uniqueId(`${recipe.id}-custom`, takenIds);
        }
        await dev.uploadRecipe({ ...recipe, factory: false });
        await refreshRecipes();
        setSelectedId(recipe.id);
        setNotice(`Imported ${recipe.name}`);
      });
    });
  };

  /**
   * `.cube` import (02 §14). The file is checked here — it has to be a 3D cube
   * at the device grid, and a 33³ export is rejected by name rather than
   * silently resampled. What lands in the look is the LUT's name: there is no
   * KDP command to carry the 14,739-float grid to the card yet, so the copy
   * says exactly that instead of implying the camera has it.
   */
  const importCube = (file: File) => {
    void file.text().then((text) => {
      let grid;
      try {
        grid = parseCubeLut(text);
      } catch (err) {
        setNotice(`LUT rejected: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const name = grid.title ?? file.name.replace(/\.cube$/i, '');
      patch((d) => ({ ...d, advanced: { ...d.advanced, lut: name } }));
      setNotice(
        `${name} read — ${DEVICE_LUT_SIZE}×${DEVICE_LUT_SIZE}×${DEVICE_LUT_SIZE}, ${grid.data.length / 3} entries. ` +
          'The look now names this LUT; the grid itself stays on this computer until firmware exposes a LUT upload.',
      );
    });
  };

  const renderList = (list: Recipe[], emptyText: string) =>
    list.length === 0 ? (
      <p className="faint" style={{ padding: '4px 0' }}>{emptyText}</p>
    ) : (
      list.map((r) => (
        <button
          key={r.id}
          type="button"
          className="recipe-item"
          // aria-pressed drives the selected style; aria-current says which
          // one of the single-selection list is open in the editor.
          aria-pressed={selected?.id === r.id}
          aria-current={selected?.id === r.id ? 'true' : undefined}
          onClick={() => setSelectedId(r.id)}
        >
          <span className="recipe-item-name">
            {r.name}
            {activeRecipeId === r.id ? (
              <span className="tag tag--accent">
                WIGGLE
                <span style={SR_ONLY}> — used for wiggle capture</span>
              </span>
            ) : null}
          </span>
          {r.description ? <span className="recipe-item-desc">{r.description}</span> : null}
        </button>
      ))
    );

  const matrix = draft?.advanced?.rgbMatrix ?? IDENTITY_MATRIX;
  const changeCount = draft && selected ? countChangedLeaves(draft, selected) : 0;

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="looks" />
          Looks
        </h1>
        <span className="microlabel">
          {state.factoryRecipes.length} FACTORY · {state.customRecipes.length} CUSTOM
        </span>
      </div>

      {notice ? <p className="notice">{notice}</p> : null}

      <div className="recipes-layout">
        <div>
          <Panel title="FACTORY">{renderList(state.factoryRecipes, 'No factory looks reported.')}</Panel>
          <Panel
            title="CUSTOM"
            actions={
              <Button size="sm" onClick={() => fileRef.current?.click()}>
                IMPORT JSON
              </Button>
            }
          >
            {renderList(state.customRecipes, 'No custom looks on this KINO.')}
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importJson(f);
                e.target.value = '';
              }}
            />
          </Panel>
        </div>

        {draft && selected ? (
          <div className="looks-editor">
            <LookPreview recipe={draft} />
            <Panel
              title={`EDITOR — ${selected.name.toUpperCase()}${selected.factory ? ' (FACTORY)' : ''}`}
              actions={
                <>
                  {activeRecipeId !== selected.id ? (
                    <Button size="sm" onClick={() => void useForWiggle(selected.id)}>
                      USE FOR WIGGLE
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => downloadJson(`${draft.id}.json`, { ...draft, factory: undefined })}>
                    EXPORT JSON
                  </Button>
                  <Button
                    size="sm"
                    title={dirty ? 'Copies the look as stored on KINO — unsaved edits stay here' : undefined}
                    onClick={() => void duplicate(selected)}
                  >
                    DUPLICATE
                  </Button>
                  {!selected.factory ? (
                    <Button size="sm" variant="danger" onClick={() => setDeleteOpen(true)}>
                      DELETE
                    </Button>
                  ) : null}
                </>
              }
            >
              {selected.factory ? (
                <p className="notice">
                  Edits to a factory look are saved as a custom copy.
                </p>
              ) : null}

              {!selected.factory ? (
                <TextField
                  label="NAME"
                  value={draft.name}
                  maxLength={40}
                  onChange={(name) => patch((d) => ({ ...d, name }))}
                />
              ) : null}

              <h3 className="microlabel" style={{ padding: '12px 0 4px' }}>CAPTURE</h3>
              <SegField
                label="RESOLUTION"
                value={draft.capture.resolution}
                options={[
                  { value: '1600x1200', label: '2M · 1600×1200' },
                  { value: '2048x1536', label: '3M · 2048×1536' },
                ]}
                onChange={(v) =>
                  patch((d) => ({ ...d, capture: { ...d.capture, resolution: v as Recipe['capture']['resolution'] } }))
                }
              />
              {/* Every slider here takes a typed value: SATURATION alone is
                  0–1.6 at step 0.01, which is 160 arrow presses end to end. */}
              <SliderField
                label="JPEG QUALITY"
                value={draft.capture.jpegQuality}
                min={60}
                max={95}
                entry
                onChange={(v) => patch((d) => ({ ...d, capture: { ...d.capture, jpegQuality: v } }))}
              />
              <SliderField
                label="EXPOSURE BIAS"
                value={draft.capture.exposureBias}
                min={-2}
                max={2}
                step={0.1}
                entry
                unit="EV"
                format={formatEv}
                onChange={(v) => patch((d) => ({ ...d, capture: { ...d.capture, exposureBias: Math.round(v * 10) / 10 } }))}
              />
              <SliderField
                label="GAIN LIMIT"
                value={draft.capture.gainLimit}
                min={1}
                max={32}
                entry
                unit="×"
                format={(v) => `${v}×`}
                onChange={(v) => patch((d) => ({ ...d, capture: { ...d.capture, gainLimit: v } }))}
              />
              <SegField
                label="DENOISE"
                value={String(draft.capture.denoise)}
                options={[
                  { value: '0', label: 'OFF' },
                  { value: '1', label: 'LOW' },
                  { value: '2', label: 'HIGH' },
                ]}
                onChange={(v) => patch((d) => ({ ...d, capture: { ...d.capture, denoise: Number(v) } }))}
              />
              <SegField
                label="SHARPNESS"
                value={String(draft.capture.sharpness)}
                options={[
                  { value: '0', label: 'OFF' },
                  { value: '1', label: 'MED' },
                  { value: '2', label: 'HIGH' },
                ]}
                onChange={(v) => patch((d) => ({ ...d, capture: { ...d.capture, sharpness: Number(v) } }))}
              />

              <h3 className="microlabel" style={{ padding: '12px 0 4px' }}>COLOR</h3>
              <SliderField
                label="CONTRAST"
                value={draft.look.contrast}
                min={0.8}
                max={1.4}
                step={0.01}
                entry
                format={(v) => v.toFixed(2)}
                onChange={(v) => patch((d) => ({ ...d, look: { ...d.look, contrast: v } }))}
              />
              <SliderField
                label="SATURATION"
                value={draft.look.saturation}
                min={0}
                max={1.6}
                step={0.01}
                entry
                format={(v) => v.toFixed(2)}
                onChange={(v) => patch((d) => ({ ...d, look: { ...d.look, saturation: v } }))}
              />
              <SliderField
                label="TEMPERATURE"
                value={draft.look.temperature}
                min={-400}
                max={400}
                step={10}
                entry
                unit="MIRED"
                format={(v) => `${formatSigned(v)} MIRED`}
                onChange={(v) => patch((d) => ({ ...d, look: { ...d.look, temperature: v } }))}
              />
              <SliderField
                label="TINT"
                value={draft.look.tint}
                min={-20}
                max={20}
                entry
                format={(v) => formatSigned(v)}
                onChange={(v) => patch((d) => ({ ...d, look: { ...d.look, tint: v } }))}
              />
              <SliderField
                label="BLACK POINT"
                value={draft.look.blackPoint}
                min={0}
                max={16}
                entry
                onChange={(v) => patch((d) => ({ ...d, look: { ...d.look, blackPoint: v } }))}
              />
              <SliderField
                label="HIGHLIGHT COMP."
                value={draft.look.highlightCompression}
                min={0}
                max={0.3}
                step={0.01}
                entry
                format={(v) => v.toFixed(2)}
                onChange={(v) => patch((d) => ({ ...d, look: { ...d.look, highlightCompression: v } }))}
              />

              <h3 className="microlabel" style={{ padding: '12px 0 4px' }}>CHARACTER</h3>
              <SliderField
                label="GRAIN"
                value={draft.look.grain}
                min={0}
                max={0.5}
                step={0.01}
                entry
                format={(v) => v.toFixed(2)}
                onChange={(v) => patch((d) => ({ ...d, look: { ...d.look, grain: v } }))}
              />
              <SliderField
                label="VIGNETTE"
                value={draft.look.vignette}
                min={0}
                max={0.3}
                step={0.01}
                entry
                format={(v) => v.toFixed(2)}
                onChange={(v) => patch((d) => ({ ...d, look: { ...d.look, vignette: v } }))}
              />

              <h3 className="microlabel" style={{ padding: '12px 0 4px' }}>ADVANCED</h3>
              <div className="field">
                <span className="field-label">RGB MATRIX</span>
                <div className="control" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 76px)', gap: 6 }}>
                  {matrix.map((v, i) => (
                    <input
                      key={i}
                      type="number"
                      className="input"
                      style={{ width: 76 }}
                      step={0.01}
                      value={v}
                      aria-label={`Matrix ${['R', 'G', 'B'][Math.floor(i / 3)]} row, column ${(i % 3) + 1}`}
                      onChange={(e) => {
                        const num = Number(e.target.value);
                        if (!Number.isFinite(num)) return;
                        patch((d) => {
                          const m = [...(d.advanced?.rgbMatrix ?? IDENTITY_MATRIX)] as NonNullable<
                            Recipe['advanced']
                          >['rgbMatrix'] & number[];
                          m[i] = num;
                          return { ...d, advanced: { ...d.advanced, rgbMatrix: m as never } };
                        });
                      }}
                    />
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-label">LUT</span>
                <div className="control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Button size="sm" onClick={() => cubeRef.current?.click()}>
                    IMPORT .CUBE
                  </Button>
                  <span className="faint">
                    {draft.advanced?.lut
                      ? `${draft.advanced.lut} — named only; no LUT upload command in this firmware`
                      : `none — ${DEVICE_LUT_SIZE}×${DEVICE_LUT_SIZE}×${DEVICE_LUT_SIZE} cubes only`}
                  </span>
                  <input
                    ref={cubeRef}
                    type="file"
                    accept=".cube"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) importCube(f);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
            </Panel>

            {selected.factory ? (
              <ApplyBar
                dirty={dirty}
                changeCount={changeCount}
                changedFields={changedFields}
                applyLabel="SAVE AS CUSTOM LOOK"
                onApply={async () => {
                  await saveAsCustom(draft);
                  discard(); // factory source stays as-is; edits went to the copy
                }}
                onDiscard={discard}
              />
            ) : (
              <ApplyBar
                dirty={dirty}
                changeCount={changeCount}
                changedFields={changedFields}
                applyLabel="SAVE TO KINO"
                onApply={saveToKino}
                onDiscard={discard}
              />
            )}
          </div>
        ) : (
          <Panel title="EDITOR">
            <p className="faint" style={{ padding: '4px 0' }}>Reading looks from KINO…</p>
          </Panel>
        )}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        danger
        title="DELETE LOOK"
        confirmLabel="DELETE"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void remove()}
      >
        <p>
          Delete <strong>{selected?.name}</strong> from the KINO? Slots using it fall back to Party Neg.
          This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
