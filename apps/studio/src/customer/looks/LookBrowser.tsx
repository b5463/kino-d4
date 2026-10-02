import { useEffect, useState } from 'react';
import type { Recipe } from '../../recipes/recipeTypes';
import { allRecipes, useDeviceStore } from '../../state/deviceStore';
import { lensPhrase } from '../physical/fieldBody';
import { lookCharacter } from '../shoot/lookFilter';
import { LookAdjust } from './LookAdjust';
import { splitLooks } from './lookEdits';

/**
 * The full Looks list, in the open under the photograph: built-in first,
 * then Yours; each a name and one line of character. Hover or focus changes
 * the preview; only "Use for Wiggle" (or "Use for the centre-left lens")
 * commits. Adjust opens the five sliders in the same column.
 */
export function LookBrowser({
  scope,
  currentId,
  onPreview,
  onUse,
  onClose,
}: {
  /** 'wiggle', or the lens index the look is for. */
  scope: 'wiggle' | number;
  currentId: string;
  /** The look to render the cells and the photograph through, or null for the current one. */
  onPreview: (look: Recipe | null) => void;
  onUse: (id: string) => void;
  onClose: () => void;
}) {
  const state = useDeviceStore();
  const recipes = allRecipes(state);
  const [selected, setSelected] = useState(currentId);
  const [hovered, setHovered] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const { builtIn, yours } = splitLooks(recipes);
  const selectedRecipe = recipes.find((r) => r.id === selected) ?? null;

  useEffect(() => {
    const shown = recipes.find((r) => r.id === (hovered ?? selected)) ?? null;
    if (!adjusting) onPreview(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, selected, adjusting, recipes.length]);

  useEffect(() => () => onPreview(null), [onPreview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const useLabel = scope === 'wiggle' ? 'Use for Wiggle' : `Use for ${lensPhrase(scope)}`;

  const row = (r: Recipe) => (
    <li key={r.id}>
      <button
        type="button"
        className={`c-look${hovered === r.id ? ' is-hovered' : ''}`}
        aria-pressed={selected === r.id}
        onMouseEnter={() => setHovered(r.id)}
        onMouseLeave={() => setHovered((h) => (h === r.id ? null : h))}
        onFocus={() => setHovered(r.id)}
        onBlur={() => setHovered((h) => (h === r.id ? null : h))}
        onClick={() => {
          setSelected(r.id);
          setAdjusting(false);
        }}
      >
        <span className="c-look-name">{r.name}</span>
        <span className="c-look-character">{lookCharacter(r)}</span>
      </button>
    </li>
  );

  return (
    <section className="c-looks" aria-label="Looks">
      <div className="c-looks-head">
        <button type="button" className="c-button" onClick={() => onUse(selected)}>
          {useLabel}
        </button>
        {selectedRecipe ? (
          <button type="button" className="c-word c-word--quiet" aria-pressed={adjusting} onClick={() => setAdjusting((a) => !a)}>
            Adjust
          </button>
        ) : null}
        <button type="button" className="c-word c-word--quiet" onClick={onClose}>
          Close
        </button>
      </div>
      {adjusting && selectedRecipe ? (
        <LookAdjust
          recipe={selectedRecipe}
          onPreview={onPreview}
          onSwapTo={(id) => {
            setSelected(id);
            onUse(id);
          }}
          onDeleted={() => {
            setSelected('party-neg');
            setAdjusting(false);
          }}
        />
      ) : null}
      <ul>
        {builtIn.map(row)}
        {yours.length > 0 ? (
          <>
            <li className="c-looks-group">Yours</li>
            {yours.map(row)}
          </>
        ) : null}
      </ul>
    </section>
  );
}
