import { useCallback, useEffect, useRef, useState } from 'react';
import type { WiggleConfig, WiggleDirection } from '@kino/kdp';
import { applyConfigChecked, getDevice, refreshDeviceInfo } from '../../app/session';
import { allRecipes, useDeviceStore } from '../../state/deviceStore';
import { playBuiltin, playWav } from '../../utils/soundFx';
import type { BuiltinSoundId } from '../../utils/soundFx';
import { readSound } from '../../device/sounds';
import type { Recipe } from '../../recipes/recipeTypes';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { KinoFront } from '../physical/KinoFront';
import type { CellSpec } from '../physical/KinoFront';
import { LENS_POSITIONS } from '../physical/fieldBody';
import { LookBrowser } from '../looks/LookBrowser';
import { cameraName, resultCaption } from '../copy';
import { ResultPhoto } from './ResultPhoto';
import { lookCssFilter } from './lookFilter';
import { useLastPhoto } from './useLastPhoto';
import { useRowMarks } from './useSaved';
import { directionForCell, feelForFps, fpsForFeel, useWiggleStep } from './useWiggleStep';
import type { FeelName } from './useWiggleStep';
import { WiggleLine, shutterName } from './WiggleLine';
import type { WiggleOpen } from './WiggleLine';
import type { ShootLayout } from './shootLayout';

const HINT_MS = 1000;

/**
 * Shoot — Wiggle. The four cells hold the four frames of the latest
 * wigglegram; one accent ring walks across them at the feel, and the
 * photograph beside the body snaps from the same sequencer, so the ringed
 * cell and the frame shown are always the same lens. The end cells are the
 * direction control. Under the body: the look, the feel, More.
 */
export function WiggleShoot({ layout, readOnly, onOpenPhotos }: { layout: ShootLayout; readOnly: boolean; onOpenPhotos: () => void }) {
  const state = useDeviceStore();
  const config = state.config;
  const reduced = useReducedMotion();
  const { save, mark, retry } = useRowMarks();
  const [open, setOpen] = useState<WiggleOpen>('none');
  const [browser, setBrowser] = useState(false);
  const [previewFeel, setPreviewFeel] = useState<FeelName | null>(null);
  const [previewLookId, setPreviewLookId] = useState<string | null>(null);
  const [previewDraft, setPreviewDraft] = useState<Recipe | null>(null);
  const [hint, setHint] = useState<number | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const underRef = useRef<HTMLDivElement>(null);
  const last = useLastPhoto('wiggle');

  const wiggle = config?.wiggle;
  const fps = previewFeel ? fpsForFeel(previewFeel) : (wiggle?.fps ?? 10);
  const active = useWiggleStep(fps, wiggle?.loop ?? 'continuous', wiggle?.direction ?? 'ltr');

  // A preview ends with the options it belonged to: the hovered word is gone
  // before its mouse-leave can fire.
  useEffect(() => {
    if (open !== 'look') setPreviewLookId(null);
    if (open !== 'feel') setPreviewFeel(null);
  }, [open]);

  // Escape puts the word back; a click on paper does too.
  useEffect(() => {
    if (open === 'none') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen('none');
    };
    const onDown = (e: MouseEvent) => {
      if (underRef.current && !underRef.current.contains(e.target as Node)) setOpen('none');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const onBrowserPreview = useCallback((look: Recipe | null) => setPreviewDraft(look), []);

  if (!config || !wiggle) return null;
  const recipes = allRecipes(state);
  const current = recipes.find((r) => r.id === wiggle.recipeId) ?? null;
  const shown = previewDraft ?? recipes.find((r) => r.id === previewLookId) ?? current;
  const filter = lookCssFilter(shown);
  const feel = feelForFps(wiggle.fps);
  const shoot = config.shoot;

  const writeWiggle = (patch: Partial<WiggleConfig>, differs: (stored: WiggleConfig) => boolean) => async () => {
    const { config: stored } = await applyConfigChecked({ wiggle: { ...wiggle, ...patch } });
    return differs(stored.wiggle);
  };

  const chooseLook = (id: string) => {
    setOpen('none');
    setBrowser(false);
    setPreviewLookId(null);
    setPreviewDraft(null);
    void save('look', async () => {
      const { config: stored } = await applyConfigChecked({ wiggle: { ...wiggle, recipeId: id } });
      const dev = getDevice();
      if (dev) {
        await dev.setActiveRecipe(id);
        await refreshDeviceInfo();
      }
      return stored.wiggle.recipeId !== id;
    });
  };

  const chooseFeel = (name: FeelName) => {
    setOpen('none');
    setPreviewFeel(null);
    void save('feel', writeWiggle({ fps: fpsForFeel(name) }, (s) => feelForFps(s.fps) !== name));
  };

  const setDirection = (direction: WiggleDirection) => {
    if (readOnly || direction === wiggle.direction) return;
    void save('direction', writeWiggle({ direction }, (s) => s.direction !== direction));
  };

  const hover = (i: number, over: boolean) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    if (over && directionForCell(i)) hintTimer.current = setTimeout(() => setHint(i), HINT_MS);
    else setHint(null);
  };

  const playShutter = async () => {
    const dev = getDevice();
    if (shoot.shutterSound === 'silent') return;
    try {
      const custom = state.sounds.find((s) => s.id === shoot.shutterSound);
      if (custom && dev) await playWav(await readSound(dev, custom), shoot.volume);
      else playBuiltin(shoot.shutterSound as BuiltinSoundId, shoot.volume);
    } catch {
      // A missing clip is not worth a sentence here.
    }
  };

  const cells: CellSpec[] = LENS_POSITIONS.map((pos, i) => {
    const direction = directionForCell(i);
    return {
      url: last.frames?.[i] ?? null,
      filter,
      ring: active === i ? 'wiggle' : 'none',
      label: direction ? `${pos} lens. Start the sequence here` : `${pos} lens`,
      onClick: direction ? () => setDirection(direction) : undefined,
      onHover: (over) => hover(i, over),
      hint: hint === i ? 'Start here.' : null,
    };
  });

  const markFor = (rows: string[]) => {
    for (const row of rows) {
      const m = mark(row);
      if (m) {
        return (
          <span className="c-mark" role="status">
            {m}
            {m === "KINO didn't save this." ? (
              <button type="button" onClick={() => retry(row)}>
                Try again
              </button>
            ) : null}
          </span>
        );
      }
    }
    return null;
  };

  const frameUrl = last.frames?.[active] ?? last.frames?.find((f) => f !== null) ?? null;

  return (
    <>
      <div className="c-stage-left">
        <KinoFront pxPerMm={layout.pxPerMm} cover="open" cells={cells} identity={cameraName(state.info, config)} reduced={reduced} />
        <div className="c-under" ref={underRef}>
          <WiggleLine
            open={open}
            setOpen={setOpen}
            recipes={recipes}
            lookId={wiggle.recipeId}
            lookName={current?.name ?? wiggle.recipeId}
            feel={feel}
            bounce={wiggle.loop === 'bounce'}
            shutter={shoot.shutterSound}
            sounds={state.sounds}
            review={shoot.displayAfterShotS}
            readOnly={readOnly}
            mark={markFor(['look', 'feel', 'direction', 'bounce', 'sound', 'review'])}
            onPreviewLook={setPreviewLookId}
            onChooseLook={chooseLook}
            onMoreLooks={() => {
              setOpen('none');
              setBrowser(true);
            }}
            onPreviewFeel={setPreviewFeel}
            onChooseFeel={chooseFeel}
            onBounce={(on) => void save('bounce', writeWiggle({ loop: on ? 'bounce' : 'continuous' }, (s) => (s.loop === 'bounce') !== on))}
            onShutter={(id) =>
              void save('sound', async () => (await applyConfigChecked({ shoot: { ...shoot, shutterSound: id } })).config.shoot.shutterSound !== id)
            }
            onPlay={() => void playShutter()}
            onReview={(n) =>
              void save('review', async () => (await applyConfigChecked({ shoot: { ...shoot, displayAfterShotS: n } })).config.shoot.displayAfterShotS !== n)
            }
          />
        </div>
      </div>
      <div className="c-stage-right" style={{ marginTop: resultTop(layout) }}>
        <ResultPhoto
          url={last.summary ? frameUrl : null}
          filter={filter}
          caption={last.summary ? resultCaption(last.summary.ts, state.storage) : null}
          alt={`The last wigglegram, ${shown ? `through ${shown.name}, ` : ''}playing at ${feel}`}
          onOpen={onOpenPhotos}
        />
        {browser ? (
          <LookBrowser scope="wiggle" currentId={wiggle.recipeId} onPreview={onBrowserPreview} onUse={chooseLook} onClose={() => setBrowser(false)} />
        ) : null}
      </div>
    </>
  );
}

/** The photograph's vertical centre sits on the lens axis. */
export function resultTop(layout: ShootLayout): number {
  if (layout.stacked) return 0;
  const axis = (90 - 43) * layout.pxPerMm;
  return Math.max(0, Math.round(axis - (layout.resultW * 3) / 4 / 2));
}

export { shutterName };
