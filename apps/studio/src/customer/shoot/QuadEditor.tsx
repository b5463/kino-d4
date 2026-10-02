import type { ReactNode } from 'react';
import type { QuadSlotConfig, SlotColorMode } from '@kino/kdp';
import type { Recipe } from '../../recipes/recipeTypes';
import { InlineLooks } from '../looks/InlineLooks';
import { LENS_POSITIONS } from '../physical/fieldBody';

/** Where the editor's left edge sits for a lens axis: the slider straddles the axis. */
export function editorLeft(axisX: number): number {
  return Math.round(axisX - 60);
}

/** "+0.3", shown only while the dot is held. */
export function biasLabel(value: number): string {
  const v = Math.round(value * 10) / 10;
  return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
}

/**
 * The one editor on Quad, under the selected lens's axis: the look name at
 * 20 px (click for the recent looks), Darker ─────●───── Brighter, and
 * Colour · B&W when the camera has it. Only one of these exists at a time.
 */
export function QuadEditor({
  index,
  axisX,
  slot,
  recipe,
  recipes,
  lookOpen,
  colourSupported,
  dragValue,
  readOnly,
  mark,
  onToggleLook,
  onPreviewLook,
  onChooseLook,
  onMoreLooks,
  onDrag,
  onCommitBias,
  onColour,
}: {
  index: number;
  axisX: number;
  slot: QuadSlotConfig;
  recipe: Recipe | null;
  recipes: Recipe[];
  lookOpen: boolean;
  colourSupported: boolean;
  dragValue: number | null;
  readOnly: boolean;
  mark: ReactNode;
  onToggleLook: () => void;
  onPreviewLook: (id: string | null) => void;
  onChooseLook: (id: string) => void;
  onMoreLooks: () => void;
  onDrag: (value: number | null) => void;
  onCommitBias: (value: number) => void;
  onColour: (mode: SlotColorMode) => void;
}) {
  const left = editorLeft(axisX);
  const value = dragValue ?? slot.exposureBias;
  const position = LENS_POSITIONS[index]?.toLowerCase() ?? 'left';
  return (
    <>
      <div className="c-leader" style={{ left: axisX, top: -36 }} aria-hidden="true" />
      <button
        type="button"
        className="c-quad-name is-editing"
        style={{ left: axisX }}
        aria-expanded={lookOpen}
        aria-label={`Look for the ${position} lens, ${recipe?.name ?? slot.recipeId}`}
        onClick={onToggleLook}
      >
        {recipe?.name ?? slot.recipeId}
      </button>
      {lookOpen ? (
        <div className="c-quad-lookrow" style={{ '--editor-x': `${left}px` } as React.CSSProperties}>
          <InlineLooks recipes={recipes} currentId={slot.recipeId} disabled={readOnly} onPreview={onPreviewLook} onChoose={onChooseLook} onMore={onMoreLooks} />
        </div>
      ) : null}
      <div className="c-quad-editor" style={{ left }}>
        <div className="c-slider">
          {dragValue !== null ? (
            <span className="c-slider-tip" style={{ left: `${((value + 2) / 4) * 100}%` }}>
              {biasLabel(value)}
            </span>
          ) : null}
          <input
            type="range"
            min={-2}
            max={2}
            step={0.1}
            value={value}
            disabled={readOnly}
            aria-label={`Darker or brighter, ${position} lens`}
            aria-valuetext={biasLabel(value)}
            onPointerDown={() => onDrag(slot.exposureBias)}
            onChange={(e) => onDrag(Number(e.target.value))}
            onPointerUp={(e) => onCommitBias(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) onCommitBias(Number((e.target as HTMLInputElement).value));
            }}
            onBlur={(e) => {
              if (dragValue !== null) onCommitBias(Number(e.target.value));
            }}
          />
        </div>
        <div className="c-slider-ends" aria-hidden="true">
          <span>Darker</span>
          <span>Brighter</span>
        </div>
        {colourSupported ? (
          <div className="c-quad-colour c-pair" role="radiogroup" aria-label={`Colour or black and white, ${position} lens`}>
            <button type="button" role="radio" className={slot.colorMode === 'recipe' ? 'c-word' : 'c-word c-word--quiet'} aria-checked={slot.colorMode === 'recipe'} disabled={readOnly} onClick={() => onColour('recipe')}>
              Colour
            </button>
            <span className="c-dot">·</span>
            <button type="button" role="radio" className={slot.colorMode === 'mono' ? 'c-word' : 'c-word c-word--quiet'} aria-checked={slot.colorMode === 'mono'} disabled={readOnly} onClick={() => onColour('mono')}>
              B&amp;W
            </button>
          </div>
        ) : null}
        {mark}
      </div>
    </>
  );
}
