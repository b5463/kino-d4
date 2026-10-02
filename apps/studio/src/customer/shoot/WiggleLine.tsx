import type { ReactNode } from 'react';
import type { Recipe } from '../../recipes/recipeTypes';
import type { SoundInfo } from '@kino/kdp';
import { InlineLooks } from '../looks/InlineLooks';
import { FEELS } from './useWiggleStep';
import type { FeelName } from './useWiggleStep';

export type WiggleOpen = 'none' | 'look' | 'feel' | 'more';

const SHUTTER_NAMES: Record<string, string> = {
  'click': 'Click',
  'cheap-digi': 'Cheap digi',
  'tiny-beep': 'Tiny beep',
  'mechanical': 'Mechanical',
  'silent': 'Silent',
};

/** The firmware keeps 1–3 s or until you tap; 6 s is not a value it holds. */
export const REVIEW_OPTIONS = [
  { value: 3, label: '3 s' },
  { value: -1, label: 'Until you tap' },
] as const;

export function reviewLabel(seconds: number): string {
  return REVIEW_OPTIONS.find((o) => o.value === seconds)?.label ?? `${seconds} s`;
}

export function shutterName(id: string, custom: SoundInfo[]): string {
  return SHUTTER_NAMES[id] ?? custom.find((s) => s.id === id)?.name ?? id;
}

/**
 * The line under the body: "Party Neg   Normal   More" at rest. Click a word
 * and its choices take the line; click again, Escape or paper puts the word
 * back. The word at the right end is what the camera said about the last
 * change.
 */
export function WiggleLine({
  open,
  setOpen,
  recipes,
  lookId,
  lookName,
  feel,
  bounce,
  shutter,
  sounds,
  review,
  readOnly,
  mark,
  onPreviewLook,
  onChooseLook,
  onMoreLooks,
  onPreviewFeel,
  onChooseFeel,
  onBounce,
  onShutter,
  onPlay,
  onReview,
}: {
  open: WiggleOpen;
  setOpen: (o: WiggleOpen) => void;
  recipes: Recipe[];
  lookId: string;
  lookName: string;
  feel: FeelName;
  bounce: boolean;
  shutter: string;
  sounds: SoundInfo[];
  review: number;
  readOnly: boolean;
  mark: ReactNode;
  onPreviewLook: (id: string | null) => void;
  onChooseLook: (id: string) => void;
  onMoreLooks: () => void;
  onPreviewFeel: (feel: FeelName | null) => void;
  onChooseFeel: (feel: FeelName) => void;
  onBounce: (on: boolean) => void;
  onShutter: (id: string) => void;
  onPlay: () => void;
  onReview: (seconds: number) => void;
}) {
  const toggle = (which: WiggleOpen) => setOpen(open === which ? 'none' : which);

  return (
    <>
      <div className="c-stateline">
        {open === 'feel' ? (
          <span className="c-scale" role="radiogroup" aria-label="Feel">
            {FEELS.map((f) => (
              <button
                key={f.name}
                type="button"
                role="radio"
                className={f.name === feel ? 'c-word' : 'c-word c-word--quiet'}
                aria-checked={f.name === feel}
                title={`${f.fps} frames a second`}
                disabled={readOnly}
                onMouseEnter={() => onPreviewFeel(f.name)}
                onMouseLeave={() => onPreviewFeel(null)}
                onFocus={() => onPreviewFeel(f.name)}
                onBlur={() => onPreviewFeel(null)}
                onClick={() => onChooseFeel(f.name)}
              >
                {f.name}
              </button>
            ))}
          </span>
        ) : open === 'look' ? (
          <InlineLooks recipes={recipes} currentId={lookId} disabled={readOnly} onPreview={onPreviewLook} onChoose={onChooseLook} onMore={onMoreLooks} />
        ) : (
          <>
            <button type="button" className="c-word" aria-expanded={false} aria-label={`Look, ${lookName}`} onClick={() => toggle('look')}>
              {lookName}
            </button>
            <button type="button" className="c-word" aria-expanded={false} aria-label={`Feel, ${feel}`} onClick={() => toggle('feel')}>
              {feel}
            </button>
            <button type="button" className="c-word c-word--quiet" aria-expanded={open === 'more'} onClick={() => toggle('more')}>
              {open === 'more' ? 'Less' : 'More'}
            </button>
          </>
        )}
        {mark}
      </div>
      {open === 'more' ? (
        <div className="c-more">
          <div className="c-more-row" role="group" aria-label="Back and forth">
            <span className="c-more-label">Back and forth</span>
            <span className="c-pair">
              <button type="button" className={bounce ? 'c-word c-word--quiet' : 'c-word'} aria-pressed={!bounce} disabled={readOnly} onClick={() => onBounce(false)}>
                Off
              </button>
              <span className="c-dot">·</span>
              <button type="button" className={bounce ? 'c-word' : 'c-word c-word--quiet'} aria-pressed={bounce} disabled={readOnly} onClick={() => onBounce(true)}>
                On
              </button>
            </span>
          </div>
          <div className="c-more-row">
            <label className="c-more-label" htmlFor="c-shutter">
              Shutter sound
            </label>
            <select id="c-shutter" value={shutter} disabled={readOnly} onChange={(e) => onShutter(e.target.value)}>
              {Object.entries(SHUTTER_NAMES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              {sounds.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="button" className="c-word c-word--quiet" disabled={shutter === 'silent'} onClick={onPlay}>
              Play
            </button>
          </div>
          <div className="c-more-row" role="group" aria-label="Show the photo for">
            <span className="c-more-label">Show the photo for</span>
            <span className="c-pair">
              {REVIEW_OPTIONS.map((o, i) => (
                <span key={o.value} className="c-pair">
                  {i > 0 ? <span className="c-dot">·</span> : null}
                  <button type="button" className={o.value === review ? 'c-word' : 'c-word c-word--quiet'} aria-pressed={o.value === review} disabled={readOnly} onClick={() => onReview(o.value)}>
                    {o.label}
                  </button>
                </span>
              ))}
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
