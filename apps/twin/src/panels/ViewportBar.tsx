import { NET_CLASSES } from '@kino/hardware-profiles';
import type { NetClass } from '@kino/hardware-profiles';
import { useSceneStore } from '../state/sceneStore';
import type { ViewMode } from '../state/sceneStore';
import type { ViewPoseName } from '../scene/viewPoses';

const VIEW_BUTTONS: { label: string; name: ViewPoseName }[] = [
  { label: 'FRONT', name: 'front' },
  { label: 'REAR', name: 'rear' },
  { label: 'TOP', name: 'top' },
  { label: 'BOTTOM', name: 'bottom' },
  { label: 'LEFT', name: 'left' },
  { label: 'RIGHT', name: 'right' },
  { label: 'FIT', name: 'fit' },
  { label: 'LENS', name: 'lens' },
];

const NET_CLASS_BUTTONS: { label: string; cls: NetClass }[] = NET_CLASSES.map((cls) => ({ label: cls, cls }));

const MODE_BUTTONS: { label: string; mode: ViewMode }[] = [
  { label: 'NORMAL', mode: 'normal' },
  { label: 'X-RAY', mode: 'xray' },
  { label: 'INTERNALS', mode: 'internals' },
  { label: 'SHELL', mode: 'enclosure' },
  { label: 'WIRING', mode: 'wiring' },
];

interface ViewportBarProps {
  onView(name: ViewPoseName): void;
}

/**
 * The viewport toolbar (§3, Task 13): standard-view buttons drive the R3F
 * camera through `onView` (imperative — `TwinCanvas` owns the camera/controls
 * refs the pose math needs); explode, view mode, and pitch read/write
 * `sceneStore` directly since those are plain state, not camera imperatives.
 */
export function ViewportBar({ onView }: ViewportBarProps) {
  const explode = useSceneStore((s) => s.explode);
  const setExplode = useSceneStore((s) => s.setExplode);
  const viewMode = useSceneStore((s) => s.viewMode);
  const setViewMode = useSceneStore((s) => s.setViewMode);
  const pitchMm = useSceneStore((s) => s.pitchMm);
  const setPitch = useSceneStore((s) => s.setPitch);
  const [pitchLo, pitchHi] = useSceneStore((s) => s.profile.cameraPitchRangeMm);
  const netClasses = useSceneStore((s) => s.netClasses);
  const toggleNetClass = useSceneStore((s) => s.toggleNetClass);
  const setAllNetClasses = useSceneStore((s) => s.setAllNetClasses);
  const measureMode = useSceneStore((s) => s.measureMode);
  const setMeasureMode = useSceneStore((s) => s.setMeasureMode);
  const showGrid = useSceneStore((s) => s.showGrid);
  const setShowGrid = useSceneStore((s) => s.setShowGrid);
  const allNetClassesOn = NET_CLASSES.every((cls) => netClasses.has(cls));

  return (
    <div className="twin-viewport-bar" role="toolbar" aria-label="Viewport controls">
      <div className="twin-viewport-group">
        <span className="twin-viewport-label">VIEW</span>
        {VIEW_BUTTONS.map(({ label, name }) => (
          <button key={name} type="button" className="twin-btn" onClick={() => onView(name)}>
            {label}
          </button>
        ))}
      </div>

      <div className="twin-viewport-group">
        <label className="twin-viewport-label" htmlFor="twin-explode">
          EXPLODE
        </label>
        <input
          id="twin-explode"
          className="twin-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(explode * 100)}
          onChange={(e) => setExplode(Number(e.target.value) / 100)}
        />
        <span className="twin-viewport-value">{Math.round(explode * 100)}%</span>
      </div>

      <div className="twin-viewport-group">
        <span className="twin-viewport-label">SHOW</span>
        {MODE_BUTTONS.map(({ label, mode }) => (
          <button
            key={mode}
            type="button"
            className={mode === viewMode ? 'twin-btn twin-btn--active' : 'twin-btn'}
            onClick={() => setViewMode(mode)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="twin-viewport-group">
        <button
          type="button"
          className={measureMode ? 'twin-btn twin-btn--active' : 'twin-btn'}
          aria-pressed={measureMode}
          onClick={() => setMeasureMode(!measureMode)}
        >
          MEASURE
        </button>
        <button
          type="button"
          className={showGrid ? 'twin-btn twin-btn--active' : 'twin-btn'}
          aria-pressed={showGrid}
          title="Reference grid under the assembly"
          onClick={() => setShowGrid(!showGrid)}
        >
          GRID
        </button>
      </div>

      {viewMode === 'wiring' && (
        <div className="twin-viewport-group" role="group" aria-label="Wiring net classes">
          <button
            type="button"
            className={allNetClassesOn ? 'twin-btn twin-btn--active' : 'twin-btn'}
            onClick={() => setAllNetClasses(!allNetClassesOn)}
          >
            ALL
          </button>
          {NET_CLASS_BUTTONS.map(({ label, cls }) => (
            <button
              key={cls}
              type="button"
              className={netClasses.has(cls) ? 'twin-btn twin-btn--active' : 'twin-btn'}
              onClick={() => toggleNetClass(cls)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="twin-viewport-group">
        <label className="twin-viewport-label" htmlFor="twin-pitch">
          PITCH
        </label>
        <input
          id="twin-pitch"
          className="twin-slider"
          type="range"
          min={pitchLo}
          max={pitchHi}
          step={0.1}
          value={pitchMm}
          onChange={(e) => setPitch(Number(e.target.value))}
        />
        <input
          className="twin-numeric"
          type="number"
          min={pitchLo}
          max={pitchHi}
          step={0.1}
          value={pitchMm}
          onChange={(e) => setPitch(Number(e.target.value))}
          aria-label="Camera pitch (mm)"
        />
        <span className="twin-viewport-value">mm</span>
      </div>
    </div>
  );
}
