import type { Recipe } from '../../recipes/recipeTypes';
import { recentLooks } from './lookEdits';

/**
 * The small inline set of looks that appears when the current look name is
 * clicked: the current one, then the recent ones, then "More looks…".
 * Hover or focus previews; click commits; nothing else happens here.
 */
export function InlineLooks({
  recipes,
  currentId,
  disabled = false,
  onPreview,
  onChoose,
  onMore,
}: {
  recipes: Recipe[];
  currentId: string;
  disabled?: boolean;
  onPreview: (id: string | null) => void;
  onChoose: (id: string) => void;
  onMore: () => void;
}) {
  const inline = recentLooks(recipes, currentId);
  return (
    <span className="c-inline-looks" role="radiogroup" aria-label="Look">
      {inline.map((r) => (
        <button
          key={r.id}
          type="button"
          role="radio"
          className={r.id === currentId ? 'c-word' : 'c-word c-word--quiet'}
          aria-checked={r.id === currentId}
          disabled={disabled}
          onMouseEnter={() => onPreview(r.id)}
          onMouseLeave={() => onPreview(null)}
          onFocus={() => onPreview(r.id)}
          onBlur={() => onPreview(null)}
          onClick={() => onChoose(r.id)}
        >
          {r.name}
        </button>
      ))}
      <button type="button" className="c-word c-word--quiet" onClick={onMore}>
        More looks…
      </button>
    </span>
  );
}
