import { useEffect, useRef, useState } from 'react';
import type { Recipe } from '../../recipes/recipeTypes';
import { validateRecipe } from '../../recipes/recipeTypes';
import { getDevice, refreshRecipes } from '../../app/session';
import { allRecipes, useDeviceStore } from '../../state/deviceStore';
import { downloadJson } from '../../utils/download';
import { ConfirmSheet } from '../Dialog';
import { Overflow } from './Overflow';
import { CUSTOMER_SLIDERS, duplicateOf, isYours, uniqueId, withLookValue, yoursCopy } from './lookEdits';

const UPLOAD_DEBOUNCE_MS = 350;

/**
 * Five words with a hairline each. Adjusting a built-in makes it yours on
 * the first move ("Party Neg (yours)") and that copy becomes the look in
 * use; every later move goes to the camera a moment after the dot settles.
 * Internals (matrices, mired, LUTs) are not here.
 */
export function LookAdjust({
  recipe,
  onPreview,
  onSwapTo,
  onDeleted,
}: {
  recipe: Recipe;
  /** The draft, for the cells and the photograph to render through while the dot moves. */
  onPreview: (draft: Recipe) => void;
  /** The look in use changed identity (a copy was made, a file opened). */
  onSwapTo: (id: string) => void;
  onDeleted: () => void;
}) {
  const state = useDeviceStore();
  const [draft, setDraft] = useState<Recipe>(recipe);
  const [note, setNote] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const yours = isYours(recipe);

  useEffect(() => {
    setDraft(recipe);
  }, [recipe]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const upload = async (next: Recipe) => {
    const dev = getDevice();
    if (!dev) return;
    try {
      await dev.uploadRecipe({ ...next, factory: false });
      await refreshRecipes();
      setNote(null);
    } catch {
      setNote("KINO didn't save this look. Try again.");
    }
  };

  /** The first move on a built-in makes the copy; later moves edit the copy. */
  const change = (next: Recipe) => {
    if (!yours) {
      const copy = { ...yoursCopy(recipe, allRecipes(state)), look: next.look };
      setDraft(copy);
      onPreview(copy);
      void upload(copy).then(() => onSwapTo(copy.id));
      return;
    }
    setDraft(next);
    onPreview(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void upload(next), UPLOAD_DEBOUNCE_MS);
  };

  const openFile = (file: File) => {
    void file.text().then((text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setNote("That file isn't a look.");
        return;
      }
      const check = validateRecipe(json);
      if (!check.ok) {
        setNote("That file isn't a look.");
        return;
      }
      const all = allRecipes(state);
      const opened = { ...check.recipe, factory: false as const };
      if (all.some((r) => r.id === opened.id)) opened.id = uniqueId(`${opened.id}-yours`, new Set(all.map((r) => r.id)));
      void upload(opened).then(() => onSwapTo(opened.id));
    });
  };

  const remove = async () => {
    setDeleteOpen(false);
    const dev = getDevice();
    if (!dev) return;
    try {
      await dev.deleteRecipe(recipe.id);
      await refreshRecipes();
      onDeleted();
    } catch {
      setNote("KINO didn't delete this look. Try again.");
    }
  };

  return (
    <div className="c-looks-adjust">
      <div className="c-adjust-name">
        {yours ? (
          <input
            className="c-field"
            aria-label="Name of this look"
            value={draft.name}
            maxLength={40}
            onChange={(e) => change({ ...draft, name: e.target.value })}
          />
        ) : (
          <span className="c-20">{recipe.name}</span>
        )}
        <Overflow
          items={[
            {
              label: 'Duplicate',
              onSelect: () => {
                const copy = duplicateOf(recipe, allRecipes(state));
                void upload(copy).then(() => onSwapTo(copy.id));
              },
            },
            ...(yours ? [{ label: 'Delete', warning: true, onSelect: () => setDeleteOpen(true) }] : []),
            { label: 'Save look as file…', onSelect: () => downloadJson(`${draft.id}.json`, { ...draft, factory: undefined }) },
            { label: 'Open look file…', onSelect: () => fileRef.current?.click() },
          ]}
        />
      </div>
      {CUSTOMER_SLIDERS.map((s) => (
        <label key={s.key} className="c-adjust-row">
          <span className="c-adjust-label">{s.label}</span>
          <span className="c-slider">
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={draft.look[s.key]}
              aria-label={s.label}
              onChange={(e) => change(withLookValue(draft, s.key, Number(e.target.value)))}
            />
          </span>
        </label>
      ))}
      {note ? <p className="c-mark">{note}</p> : null}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFile(f);
          e.target.value = '';
        }}
      />
      <ConfirmSheet open={deleteOpen} confirmLabel="Delete" warning onCancel={() => setDeleteOpen(false)} onConfirm={() => void remove()}>
        <p>Delete {recipe.name}? Anything using it goes back to Party Neg. This cannot be undone.</p>
      </ConfirmSheet>
    </div>
  );
}
