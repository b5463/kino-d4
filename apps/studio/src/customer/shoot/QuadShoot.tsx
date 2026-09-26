import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CamId, QuadConfig, SlotColorMode } from '@kino/kdp';
import { CAM_IDS } from '@kino/kdp';
import { applyConfigChecked } from '../../app/session';
import { allRecipes, useDeviceStore } from '../../state/deviceStore';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import type { Recipe } from '../../recipes/recipeTypes';
import { KinoFront } from '../physical/KinoFront';
import type { CellSpec } from '../physical/KinoFront';
import { bodyGeometry, LENS_POSITIONS } from '../physical/fieldBody';
import { LookBrowser } from '../looks/LookBrowser';
import { cameraName, resultCaption } from '../copy';
import { ResultPhoto } from './ResultPhoto';
import { lookCssFilter } from './lookFilter';
import { matchingSet, QUAD_SETS } from './quadSets';
import { QuadEditor } from './QuadEditor';
import { useLastPhoto } from './useLastPhoto';
import { useRowMarks } from './useSaved';
import { resultTop } from './WiggleShoot';
import type { ShootLayout } from './shootLayout';

const STAGGER_MS = 40;
const TRAVEL_MS = 320;

interface Traveller {
  name: string;
  from: number;
  to: number;
}

/**
 * Shoot — Quad. Each cell holds that lens's latest frame through its
 * treatment; the four look names sit under their lens axes. Click a lens:
 * a 2 px ink ring, the result beside the body cuts to that lens, a leader
 * drops to one editor under the axis. Choose a set: the four names travel
 * to their lenses, staggered left to right, and the cells re-render as
 * they land. At rest there is no accent anywhere.
 */
export function QuadShoot({ layout, readOnly, onOpenPhotos }: { layout: ShootLayout; readOnly: boolean; onOpenPhotos: () => void }) {
  const state = useDeviceStore();
  const config = state.config;
  const reduced = useReducedMotion();
  const { save, mark, retry } = useRowMarks();
  const last = useLastPhoto(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [lookOpen, setLookOpen] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [setsOpen, setSetsOpen] = useState(false);
  const [drag, setDrag] = useState<{ i: number; value: number } | null>(null);
  const [previewLookId, setPreviewLookId] = useState<string | null>(null);
  const [previewDraft, setPreviewDraft] = useState<Recipe | null>(null);
  const [travellers, setTravellers] = useState<Traveller[] | null>(null);
  const [landed, setLanded] = useState(false);
  const underRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<HTMLButtonElement>(null);
  const g = useMemo(() => bodyGeometry(layout.pxPerMm), [layout.pxPerMm]);

  // Travellers start at the set word and are carried to their axes on the
  // next frame; nothing else on the page moves while they do.
  useLayoutEffect(() => {
    if (!travellers) return;
    void lineRef.current?.offsetWidth;
    const go = setTimeout(() => setLanded(true), 20);
    const done = setTimeout(() => {
      setTravellers(null);
      setLanded(false);
    }, TRAVEL_MS + STAGGER_MS * 3 + 80);
    return () => {
      clearTimeout(go);
      clearTimeout(done);
    };
  }, [travellers]);

  useEffect(() => {
    if (!lookOpen) setPreviewLookId(null);
  }, [lookOpen]);

  const collapse = useCallback(() => {
    setSelected(null);
    setLookOpen(false);
    setSetsOpen(false);
    setPreviewLookId(null);
  }, []);

  useEffect(() => {
    if (selected === null && !setsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') collapse();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (underRef.current?.contains(t)) return;
      if ((t as Element).closest?.('.c-cell, .c-looks')) return;
      collapse();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [selected, setsOpen, collapse]);

  const onBrowserPreview = useCallback((look: Recipe | null) => setPreviewDraft(look), []);

  const quad = config?.quad;
  if (!config || !quad) return null;
  const recipes = allRecipes(state);
  const recipeOf = (id: string) => recipes.find((r) => r.id === id) ?? null;
  const currentSet = matchingSet(quad.slots);

  const writeQuad = (row: string, slots: QuadConfig['slots'], differs: (stored: QuadConfig) => boolean) =>
    save(row, async () => differs((await applyConfigChecked({ quad: { ...quad, slots } })).config.quad));

  const patchSlot = (cam: CamId, patch: Partial<QuadConfig['slots'][CamId]>): QuadConfig['slots'] => ({ ...quad.slots, [cam]: { ...quad.slots[cam], ...patch } });

  const chooseSet = (name: string) => {
    const set = QUAD_SETS.find((s) => s.name === name);
    if (!set || readOnly) return;
    setSetsOpen(false);
    setSelected(null);
    setLookOpen(false);
    const line = lineRef.current?.getBoundingClientRect();
    const from = setRef.current?.getBoundingClientRect();
    if (!reduced && line && from) {
      setLanded(false);
      setTravellers(CAM_IDS.map((cam, i) => ({ name: recipeOf(set.slots[cam].recipeId)?.name ?? set.slots[cam].recipeId, from: from.left - line.left, to: g.cellXs[i] })));
    }
    void writeQuad('sets', structuredClone(set.slots), (stored) => matchingSet(stored.slots) !== name);
  };

  const chooseLook = (i: number, id: string) => {
    const cam = CAM_IDS[i]!;
    setLookOpen(false);
    setBrowser(false);
    setPreviewLookId(null);
    setPreviewDraft(null);
    void writeQuad(`look${i}`, patchSlot(cam, { recipeId: id }), (s) => s.slots[cam].recipeId !== id);
  };
  const chooseColour = (i: number, colorMode: SlotColorMode) => {
    const cam = CAM_IDS[i]!;
    void writeQuad(`colour${i}`, patchSlot(cam, { colorMode }), (s) => s.slots[cam].colorMode !== colorMode);
  };
  const commitBias = (i: number, value: number) => {
    const cam = CAM_IDS[i]!;
    const exposureBias = Math.round(value * 10) / 10;
    setDrag(null);
    if (exposureBias === quad.slots[cam].exposureBias) return;
    void writeQuad(`bias${i}`, patchSlot(cam, { exposureBias }), (s) => s.slots[cam].exposureBias !== exposureBias);
  };

  const select = (i: number) => {
    setSetsOpen(false);
    if (selected !== i) setLookOpen(false);
    setSelected(i);
  };

  const lookFor = (i: number): Recipe | null => {
    const slot = quad.slots[CAM_IDS[i]!];
    if (selected === i) return previewDraft ?? recipeOf(previewLookId ?? slot.recipeId);
    return recipeOf(slot.recipeId);
  };
  const filterFor = (i: number) => {
    const slot = quad.slots[CAM_IDS[i]!];
    return lookCssFilter(lookFor(i), slot.colorMode === 'mono', drag?.i === i ? drag.value - slot.exposureBias : 0);
  };

  const cells: CellSpec[] = CAM_IDS.map((cam, i) => ({
    url: last.frames?.[i] ?? null,
    filter: filterFor(i),
    ring: selected === i ? (drag?.i === i ? 'drag' : 'selected') : 'none',
    label: `${LENS_POSITIONS[i]} lens, ${recipeOf(quad.slots[cam].recipeId)?.name ?? quad.slots[cam].recipeId} look`,
    onClick: () => select(i),
  }));

  const shownLens = selected ?? 0;
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
  const colourSupported = CAM_IDS.every((cam) => quad.slots[cam].colorMode !== undefined);

  return (
    <>
      <div className="c-stage-left">
        <KinoFront pxPerMm={layout.pxPerMm} cover="open" cells={cells} identity={cameraName(state.info, config)} reduced={reduced} />
        <div className="c-under" ref={underRef}>
          <div className="c-quad-line" ref={lineRef}>
            <div className="c-quad-set" role={setsOpen ? 'radiogroup' : undefined} aria-label={setsOpen ? 'Set' : undefined}>
              {setsOpen ? (
                QUAD_SETS.map((set) => (
                  <button key={set.name} type="button" role="radio" className={set.name === currentSet ? 'c-word' : 'c-word c-word--quiet'} aria-checked={set.name === currentSet} ref={set.name === (currentSet ?? 'Party') ? setRef : undefined} onClick={() => chooseSet(set.name)}>
                    {set.name}
                  </button>
                ))
              ) : (
                <button type="button" className="c-word" ref={setRef} aria-expanded={false} aria-label={`Set, ${currentSet ?? 'Yours'}`} onClick={() => setSetsOpen(true)}>
                  {currentSet ?? 'Yours'}
                </button>
              )}
              {!setsOpen ? markFor(['sets']) : null}
            </div>
            {CAM_IDS.map((cam, i) =>
              selected === i ? null : (
                <button
                  key={cam}
                  type="button"
                  className={`c-quad-name${travellers ? ' is-hidden' : ''}`}
                  style={{ left: g.cellXs[i] }}
                  aria-label={`${LENS_POSITIONS[i]} lens, ${recipeOf(quad.slots[cam].recipeId)?.name ?? quad.slots[cam].recipeId} look`}
                  onClick={() => {
                    select(i);
                    setLookOpen(true);
                  }}
                >
                  {recipeOf(quad.slots[cam].recipeId)?.name ?? quad.slots[cam].recipeId}
                </button>
              ),
            )}
            {selected !== null ? (
              <QuadEditor
                index={selected}
                axisX={g.cellXs[selected]!}
                slot={quad.slots[CAM_IDS[selected]!]}
                recipe={recipeOf(quad.slots[CAM_IDS[selected]!].recipeId)}
                recipes={recipes}
                lookOpen={lookOpen}
                colourSupported={colourSupported}
                dragValue={drag?.i === selected ? drag.value : null}
                readOnly={readOnly}
                mark={markFor([`look${selected}`, `bias${selected}`, `colour${selected}`])}
                onToggleLook={() => setLookOpen((o) => !o)}
                onPreviewLook={setPreviewLookId}
                onChooseLook={(id) => chooseLook(selected, id)}
                onMoreLooks={() => {
                  setLookOpen(false);
                  setBrowser(true);
                }}
                onDrag={(v) => setDrag(v === null ? null : { i: selected, value: v })}
                onCommitBias={(v) => commitBias(selected, v)}
                onColour={(mode) => chooseColour(selected, mode)}
              />
            ) : null}
            {travellers?.map((t, i) => (
              <span key={`${t.name}-${i}`} className={`c-travel${reduced ? ' is-cut' : ''}`} aria-hidden="true" style={{ left: 0, top: 0, transform: landed ? `translate(calc(${t.to}px - 50%), 0)` : `translate(${t.from}px, -4px)`, transitionDelay: `${i * STAGGER_MS}ms` }}>
                {t.name}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="c-stage-right" style={{ marginTop: resultTop(layout) }}>
        <ResultPhoto
          url={last.summary ? (last.frames?.[shownLens] ?? null) : null}
          filter={filterFor(shownLens)}
          caption={last.summary ? resultCaption(last.summary.ts, state.storage) : null}
          alt={`The ${LENS_POSITIONS[shownLens]!.toLowerCase()} lens's frame of the last photo`}
          onOpen={onOpenPhotos}
        />
        {browser && selected !== null ? (
          <LookBrowser scope={selected} currentId={quad.slots[CAM_IDS[selected]!].recipeId} onPreview={onBrowserPreview} onUse={(id) => chooseLook(selected, id)} onClose={() => setBrowser(false)} />
        ) : null}
      </div>
    </>
  );
}
