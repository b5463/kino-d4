import { RailIcon } from './RailIcon';
import type { RailIconName } from './RailIcon';
import { ShellMenu } from './ShellMenu';
import type { MenuCommand } from '../MenuBar';
import { Led } from '../Led';
import { navItems } from '../Sidebar';
import type { PageId } from '../Sidebar';
import { connectionStrip, useConnectionStore } from '../../state/connectionStore';
import { supports, supportsRollUpload, useDeviceStore } from '../../state/deviceStore';
import { usePrefs } from '../../state/prefs';
import { dirtySections, useDraftStore } from '../../state/draftStore';
import { KINO_MARK_HEIGHT_MM, KINO_MARK_POLYGONS } from '../../assets/kino-d4-mark';

/** The wordmark's "kino" letters only, as one path in mm (Y flipped once here). */
const MARK_KINO_W_MM = 62;
const MARK_KINO_PATH = KINO_MARK_POLYGONS.filter((poly) => poly[0][0] < MARK_KINO_W_MM)
  .map(
    (poly) =>
      poly.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(KINO_MARK_HEIGHT_MM - y).toFixed(2)}`).join(' ') +
      ' Z',
  )
  .join(' ');

/** The rail glyph for each section. The registry itself stays in Sidebar.tsx. */
const RAIL_ICON: Record<PageId, RailIconName> = {
  shoot: 'shoot',
  wiggle: 'wiggle',
  quad: 'quad',
  looks: 'looks',
  calibration: 'calibration',
  gallery: 'gallery',
  roll: 'roll',
  device: 'device',
  updates: 'updates',
  developer: 'developer',
  bringup: 'bringup',
  bench: 'bench',
};

/**
 * The left rail: the mark, one button per section, and at the foot the link
 * lamp, the gear and the version. Sections the camera cannot serve are not
 * listed — same registry as before (02 §27). An unsaved section carries an
 * accent dot on its glyph instead of a badge.
 */
export function Rail({
  page,
  onNavigate,
  locked,
  inSession,
  gearItems,
  version,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  /** Reason navigation is blocked, e.g. while firmware is being written. */
  locked?: string | null;
  /** Disconnected: only the mark and the gear are shown. */
  inSession: boolean;
  gearItems: MenuCommand[];
  version: string;
}) {
  const phase = useConnectionStore((s) => s.phase);
  const fault = useConnectionStore((s) => s.fault);
  const serial = useDeviceStore((s) => s.info?.serial);
  const developerMode = usePrefs((s) => s.developerMode);
  const rollUpload = useDeviceStore(supportsRollUpload);
  const gallery = useDeviceStore((s) => supports(s, 'gallery'));
  const wiggle = useDeviceStore((s) => supports(s, 'wiggle'));
  const quad = useDeviceStore((s) => supports(s, 'quad'));
  const dirty = useDraftStore((s) => s.dirty);
  const unsaved = dirtySections(dirty);
  const strip = connectionStrip(phase, fault);

  const items = inSession ? navItems({ developerMode, rollUpload, gallery, wiggle, quad }) : [];

  return (
    <aside className="rail">
      <div className="rail-mark">
        <svg
          viewBox={`0 0 ${MARK_KINO_W_MM} ${KINO_MARK_HEIGHT_MM}`}
          width={50}
          height={(50 * KINO_MARK_HEIGHT_MM) / MARK_KINO_W_MM}
          role="img"
          aria-label="KINO Studio"
        >
          <path d={MARK_KINO_PATH} fill="currentColor" />
        </svg>
      </div>
      <nav className="rail-nav" aria-label="Sections">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="rail-item"
            data-page={item.id}
            aria-label={item.label}
            aria-current={page === item.id ? 'page' : undefined}
            disabled={locked ? page !== item.id : undefined}
            title={locked && page !== item.id ? locked : item.label}
            onClick={() => onNavigate(item.id)}
          >
            <RailIcon name={RAIL_ICON[item.id]} />
            <span className={item.label.length > 8 ? 'rail-label rail-label--long' : 'rail-label'}>{item.label}</span>
            {unsaved.has(item.id) ? (
              <span className="rail-dot" title="This section has changes that are not saved to KINO" />
            ) : null}
          </button>
        ))}
      </nav>
      <div className="rail-foot">
        {inSession ? (
          <span className="rail-link" title={strip.label}>
            <Led state={strip.led} label="" accessibleLabel={strip.label} announce />
            {serial ? <span className="rail-serial">{serial}</span> : null}
          </span>
        ) : null}
        <ShellMenu label="Studio settings" items={gearItems} align="above" className="rail-gear">
          <RailIcon name="gear" />
        </ShellMenu>
        <span className="rail-version">v{version}</span>
      </div>
    </aside>
  );
}
