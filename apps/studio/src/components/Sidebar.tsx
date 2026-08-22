import { Icon } from './Icon';
import type { IconName } from './Icon';
import { ConnectionStrip } from './ConnectionStrip';
import { useConnectionStore } from '../state/connectionStore';
import { supports, supportsRollUpload, useDeviceStore } from '../state/deviceStore';
import { usePrefs } from '../state/prefs';
import { dirtySections, useDraftStore } from '../state/draftStore';

export type PageId =
  | 'overview'
  | 'shoot'
  | 'wiggle'
  | 'quad'
  | 'looks'
  | 'calibration'
  | 'gallery'
  | 'roll'
  | 'device'
  | 'updates'
  | 'developer'
  | 'bringup'
  | 'bench';

export interface NavItem {
  id: PageId;
  label: string;
  icon: IconName;
}

/** 02 §3 order. Roll sits between Gallery and Device. */
const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'shoot', label: 'Shoot', icon: 'shoot' },
  { id: 'wiggle', label: 'Wiggle', icon: 'wiggle' },
  { id: 'quad', label: 'Quad', icon: 'quad' },
  { id: 'looks', label: 'Looks', icon: 'looks' },
  { id: 'calibration', label: 'Calibration', icon: 'calibration' },
  { id: 'gallery', label: 'Gallery', icon: 'gallery' },
  { id: 'roll', label: 'Roll', icon: 'roll' },
  { id: 'device', label: 'Device', icon: 'device' },
  { id: 'updates', label: 'Updates', icon: 'updates' },
];

/**
 * The nav registry. A section the connected camera cannot serve is not listed
 * at all (02 §27) — a Roll entry that only ever answers UNSUPPORTED_COMMAND is
 * worse than no entry. Developer sections are a preference, not a capability.
 */
export function navItems({
  developerMode,
  rollUpload,
  gallery,
  wiggle,
  quad,
}: {
  developerMode: boolean;
  rollUpload: boolean;
  gallery: boolean;
  wiggle: boolean;
  quad: boolean;
}): NavItem[] {
  const dropped = new Set<PageId>();
  if (!rollUpload) dropped.add('roll');
  if (!gallery) dropped.add('gallery');
  if (!wiggle) dropped.add('wiggle');
  if (!quad) dropped.add('quad');
  const items = NAV.filter((item) => !dropped.has(item.id));
  if (!developerMode) return items;
  return [
    ...items,
    { id: 'developer', label: 'Developer', icon: 'developer' },
    { id: 'bringup', label: 'Bring-Up', icon: 'usb' },
    { id: 'bench', label: 'Bench', icon: 'test' },
  ];
}

/** Section titles, shared with the page head and the route announcement. */
export const PAGE_LABEL: Record<PageId, string> = {
  overview: 'Overview',
  shoot: 'Shoot',
  wiggle: 'Wiggle',
  quad: 'Quad',
  looks: 'Looks',
  calibration: 'Calibration',
  gallery: 'Gallery',
  roll: 'Roll',
  device: 'Device',
  updates: 'Updates',
  developer: 'Developer',
  bringup: 'Bring-Up',
  bench: 'Bench',
};

export function Sidebar({
  page,
  onNavigate,
  locked,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  /** Reason navigation is blocked, e.g. while firmware is being written. */
  locked?: string | null;
}) {
  const phase = useConnectionStore((s) => s.phase);
  const fault = useConnectionStore((s) => s.fault);
  const transportKind = useConnectionStore((s) => s.transportKind);
  const serial = useDeviceStore((s) => s.info?.serial);
  const developerMode = usePrefs((s) => s.developerMode);
  const rollUpload = useDeviceStore(supportsRollUpload);
  const gallery = useDeviceStore((s) => supports(s, 'gallery'));
  const wiggle = useDeviceStore((s) => supports(s, 'wiggle'));
  const quad = useDeviceStore((s) => supports(s, 'quad'));
  const dirty = useDraftStore((s) => s.dirty);
  const unsaved = dirtySections(dirty);

  const items = navItems({ developerMode, rollUpload, gallery, wiggle, quad });

  return (
    <aside className="sidebar">
      <nav className="nav" aria-label="Sections">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="nav-item"
            aria-current={page === item.id ? 'page' : undefined}
            disabled={locked ? page !== item.id : undefined}
            title={locked && page !== item.id ? locked : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <Icon name={item.icon} />
            {item.label}
            {unsaved.has(item.id) ? (
              <span className="nav-badge" title="This section has changes that are not saved to KINO">
                UNSAVED
              </span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="conn-footer">
        <ConnectionStrip phase={phase} fault={fault} />
        {serial ? (
          <span className="microlabel">
            {serial}
            {transportKind === 'mock' ? ' · DEMO' : transportKind === 'twin' ? ' · TWIN' : ' · USB'}
          </span>
        ) : null}
      </div>
    </aside>
  );
}
