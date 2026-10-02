import { useEffect, useRef, useState } from 'react';
import { RailIcon } from './RailIcon';
import {
  INSPECTOR_MAX_W,
  INSPECTOR_MIN_W,
  setInspectorCollapsed,
  setInspectorSectionOpen,
  setInspectorWidth,
  usePrefs,
} from '../../state/prefs';
import { onUi } from '../../state/uiBus';
import { INSPECTOR_SECTIONS } from '../../pages/Overview/inspectorSections';

/**
 * The right-hand column: the camera's vital signs as a stack of folding
 * sections, beside whichever page is open. Drag the left edge to resize;
 * the chevron folds it to a 28 px strip. Width and folds persist per browser.
 *
 * Every section stays mounted while folded — the self test subscribes to the
 * TEST command from here, and a run must not be lost because its section
 * happened to be shut.
 */
export function Inspector() {
  const width = usePrefs((s) => s.inspectorWidth);
  const collapsed = usePrefs((s) => s.inspectorCollapsed);
  const closed = usePrefs((s) => s.inspectorClosed);
  const [dragging, setDragging] = useState(false);
  const colRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; w0: number } | null>(null);

  // The top bar's TEST: open the column, open the section, bring it into view.
  useEffect(
    () =>
      onUi('self-test', () => {
        setInspectorCollapsed(false);
        setInspectorSectionOpen('selftest', true);
        // After the state above has painted.
        setTimeout(() => {
          colRef.current
            ?.querySelector<HTMLElement>('[data-section="selftest"]')
            ?.scrollIntoView({ block: 'nearest' });
        }, 60);
      }),
    [],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { x0: e.clientX, w0: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = Math.min(INSPECTOR_MAX_W, Math.max(INSPECTOR_MIN_W, drag.current.w0 + (drag.current.x0 - e.clientX)));
    usePrefs.setState({ inspectorWidth: next });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    setInspectorWidth(usePrefs.getState().inspectorWidth);
  };
  const onHandleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10;
    if (e.key === 'ArrowLeft') setInspectorWidth(width + step);
    else if (e.key === 'ArrowRight') setInspectorWidth(width - step);
    else return;
    e.preventDefault();
  };

  if (collapsed) {
    return (
      <aside className="insp insp--collapsed" aria-label="Inspector">
        <button
          type="button"
          className="insp-toggle"
          aria-label="Show inspector"
          title="Show inspector"
          onClick={() => setInspectorCollapsed(false)}
        >
          <RailIcon name="chevron" size={16} className="insp-chev insp-chev--left" />
        </button>
        <span className="insp-vlabel" aria-hidden="true">
          INSPECTOR
        </span>
        {/* Mounted, hidden: the self test keeps its subscription and its rows. */}
        <div hidden ref={colRef}>
          {INSPECTOR_SECTIONS.map(({ id, Component }) => (
            <div key={id} data-section={id}>
              <Component />
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="insp" style={{ width }} aria-label="Inspector">
      <div
        className={dragging ? 'insp-handle is-dragging' : 'insp-handle'}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        aria-valuenow={width}
        aria-valuemin={INSPECTOR_MIN_W}
        aria-valuemax={INSPECTOR_MAX_W}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onHandleKey}
      />
      <div className="insp-col" ref={colRef}>
        <div className="insp-head">
          <span className="insp-head-title">INSPECTOR</span>
          <button
            type="button"
            className="insp-toggle"
            aria-label="Hide inspector"
            title="Hide inspector"
            onClick={() => setInspectorCollapsed(true)}
          >
            <RailIcon name="chevron" size={16} className="insp-chev insp-chev--right" />
          </button>
        </div>
        {INSPECTOR_SECTIONS.map(({ id, title, Component }) => {
          const open = closed[id] !== true;
          return (
            <section key={id} className="insp-sec" data-section={id}>
              <button
                type="button"
                className="insp-sec-head"
                aria-expanded={open}
                onClick={() => setInspectorSectionOpen(id, !open)}
              >
                <RailIcon name="chevron" size={14} className={open ? 'insp-chev' : 'insp-chev insp-chev--shut'} />
                {title}
              </button>
              <div className="insp-sec-body" hidden={!open}>
                <Component />
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
