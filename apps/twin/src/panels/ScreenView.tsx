import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSimStore } from '../state/simStore';
import { BUTTON, firmwareUi } from '../display/firmwareUi';
import { FirmwareScreenCanvas } from '../display/FirmwareScreenCanvas';
import { loadedAgo, screenCssSize } from '../display/screenFocus';
import { SensorStage } from '../scene/SensorStage';
import type { ScreenScale } from '../display/screenFocus';

/** How often the view asks whether the module on disk changed under it. */
const WATCH_MS = 2000;

/**
 * Just the display. Full window, dark, nothing else mounted: no 3D scene, no
 * panels, no overlay, so no view reset, pick or explode can get between the
 * firmware and the person changing it. The simulator keeps running
 * underneath — Studio stays connected, the card and the config are the same —
 * because this is a different way of looking at the same device, not a
 * different device.
 *
 * The virtual sensors still run: SensorStage hosts the stage and the rig in
 * an offscreen canvas, so the SHOOT screen shows the viewfinder and a
 * capture photographs the same subjects the 3D view would.
 *
 * Built for firmware work: `npm run twin:ui:bake` rewrites the module the
 * screen is running, and WATCH picks that up and restarts the screen on the
 * new build by itself. RELOAD does it
 * on demand. The device state survives either.
 */
export function ScreenView({ onExit }: { onExit: () => void }) {
  const fw = firmwareUi();
  const running = useSimStore((s) => s.running);
  const bootStage = useSimStore((s) => s.bootStage);
  const powerOn = useSimStore((s) => s.powerOn);
  const status = useSyncExternalStore(
    (cb) => fw.onStatus(cb),
    () => `${fw.available() ? 1 : 0}:${fw.loaded()?.hash ?? ''}`,
  );
  const live = fw.available();
  const loaded = fw.loaded();
  const [scale, setScale] = useState<ScreenScale>('fit');
  const [watch, setWatch] = useState(true);
  const [reload, setReload] = useState<'idle' | 'busy' | 'reloaded' | 'unchanged' | 'missing'>('idle');
  const [tick, setTick] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 800, h: 480 });

  // Size the panel to the stage, and again whenever the window changes.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      // clientWidth/Height include the stage's padding; the panel must fit inside it.
      const cs = getComputedStyle(el);
      const px = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const py = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      setStage({ w: Math.max(1, el.clientWidth - (Number.isFinite(px) ? px : 0)), h: Math.max(1, el.clientHeight - (Number.isFinite(py) ? py : 0)) });
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // WATCH: a rebuilt module is picked up without anyone touching the page.
  useEffect(() => {
    if (!watch) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || document.hidden) return;
      if (await fw.updateAvailable()) {
        setReload('busy');
        const result = await fw.reload();
        if (!stopped) setReload(result);
      }
    }, WATCH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [fw, watch]);

  // The "loaded … ago" text ages by itself.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // Keys: Esc leaves, Space is the shutter, F the function key, R reloads.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') onExit();
      else if (e.key === ' ' && fw.available()) {
        e.preventDefault();
        fw.button(BUTTON.SHUTTER);
      } else if ((e.key === 'f' || e.key === 'F') && fw.available()) fw.button(BUTTON.FN);
      else if (e.key === 'r' || e.key === 'R') void doReload();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fw, onExit]);

  async function doReload() {
    setReload('busy');
    setReload(await fw.reload(true));
  }

  const size = screenCssSize(stage.w, stage.h, scale);
  const label = live
    ? `FIRMWARE ui.c ${fw.version ?? ''}`
    : running
      ? bootStage === 'READY'
        ? 'FIRMWARE MODULE NOT LOADED'
        : `BOOTING · ${bootStage.replaceAll('_', ' ')}`
      : 'SIM OFF';
  const reloadWord =
    reload === 'busy' ? 'RELOADING…' : reload === 'reloaded' ? 'RELOADED' : reload === 'unchanged' ? 'NO CHANGE' : reload === 'missing' ? 'MODULE MISSING' : 'RELOAD';
  void tick;

  return (
    <div className="twin-screenview" role="region" aria-label="Screen view">
      {/* The virtual cameras keep photographing the stage while the scene is not shown. */}
      {running ? <SensorStage /> : null}
      <div className="twin-screenview-bar">
        <span className="twin-screenview-title">SCREEN VIEW</span>
        <span className="twin-screenview-status" data-status={status}>{label}</span>
        {loaded ? (
          <span className="twin-screenview-muted" title={loaded.url}>
            {loaded.hash} · loaded {loadedAgo(loaded.loadedAt)}
          </span>
        ) : null}
        <span className="twin-screenview-spacer" />
        {!running ? (
          <button type="button" className="twin-btn twin-btn--primary" onClick={powerOn}>POWER ON</button>
        ) : null}
        <button type="button" className="twin-btn" disabled={!live} title="The body's shutter key (Space)" onClick={() => fw.button(BUTTON.SHUTTER)}>
          SHUTTER
        </button>
        <button type="button" className="twin-btn" disabled={!live} title="The body's function key (F)" onClick={() => fw.button(BUTTON.FN)}>
          FN
        </button>
        <span className="twin-screenview-group" role="group" aria-label="Scale">
          {(['fit', '1x', '2x'] as ScreenScale[]).map((s) => (
            <button
              type="button"
              key={s}
              className={scale === s ? 'twin-btn twin-btn--active' : 'twin-btn'}
              aria-pressed={scale === s}
              onClick={() => setScale(s)}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </span>
        <button
          type="button"
          className={watch ? 'twin-btn twin-btn--active' : 'twin-btn'}
          aria-pressed={watch}
          title="Restart the screen on a rebuilt kino-ui.wasm as soon as the bake lands"
          onClick={() => setWatch((w) => !w)}
        >
          WATCH
        </button>
        <button type="button" className="twin-btn" disabled={reload === 'busy'} title="Fetch the module again and restart the screen on it (R)" onClick={() => void doReload()}>
          {reloadWord}
        </button>
        <button type="button" className="twin-btn" title="Back to the 3D view (Esc)" onClick={onExit}>
          EXIT
        </button>
      </div>
      <div className="twin-screenview-stage" ref={stageRef}>
        <FirmwareScreenCanvas
          className="twin-screenview-canvas"
          style={{ width: size.width, height: size.height, imageRendering: size.integer ? 'pixelated' : 'auto' }}
          ariaLabel={live ? 'Touch panel' : 'Device display'}
        />
      </div>
      <p className="twin-screenview-hint">
        Rebuild with <code>npm run twin:ui:bake</code>. WATCH restarts the screen on the new module; the device underneath keeps its card, config and Studio link.
      </p>
    </div>
  );
}
