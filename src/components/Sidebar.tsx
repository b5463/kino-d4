import { Icon } from './Icon';
import type { IconName } from './Icon';
import { Led } from './Led';
import type { LedState } from './Led';
import { PHASE_LABEL, useConnectionStore } from '../state/connectionStore';
import { useDeviceStore } from '../state/deviceStore';
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
  | 'device'
  | 'updates'
  | 'developer'
  | 'bringup';

const NAV: { id: PageId; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'shoot', label: 'Shoot', icon: 'shoot' },
  { id: 'wiggle', label: 'Wiggle', icon: 'wiggle' },
  { id: 'quad', label: 'Quad', icon: 'quad' },
  { id: 'looks', label: 'Looks', icon: 'looks' },
  { id: 'calibration', label: 'Calibration', icon: 'calibration' },
  { id: 'gallery', label: 'Gallery', icon: 'gallery' },
  { id: 'device', label: 'Device', icon: 'device' },
  { id: 'updates', label: 'Updates', icon: 'updates' },
];

/** Section titles, shared with the page head and the route announcement. */
export const PAGE_LABEL: Record<PageId, string> = {
  overview: 'Overview',
  shoot: 'Shoot',
  wiggle: 'Wiggle',
  quad: 'Quad',
  looks: 'Looks',
  calibration: 'Calibration',
  gallery: 'Gallery',
  device: 'Device',
  updates: 'Updates',
  developer: 'Developer',
  bringup: 'Bring-Up',
};

export function Sidebar({ page, onNavigate }: { page: PageId; onNavigate: (page: PageId) => void }) {
  const phase = useConnectionStore((s) => s.phase);
  const transportKind = useConnectionStore((s) => s.transportKind);
  const serial = useDeviceStore((s) => s.info?.serial);
  const developerMode = usePrefs((s) => s.developerMode);
  const dirty = useDraftStore((s) => s.dirty);
  const unsaved = dirtySections(dirty);

  const ledState: LedState =
    phase === 'connected' ? 'ok'
    : phase === 'maintenance' || phase === 'updating' ? 'warn'
    : phase === 'reconnecting' ? 'busy'
    : phase === 'error' ? 'err'
    : 'off';

  const items = developerMode
    ? [
        ...NAV,
        { id: 'developer' as PageId, label: 'Developer', icon: 'developer' as IconName },
        { id: 'bringup' as PageId, label: 'Bring-Up', icon: 'usb' as IconName },
      ]
    : NAV;

  return (
    <aside className="sidebar">
      <nav className="nav" aria-label="Sections">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="nav-item"
            aria-current={page === item.id ? 'page' : undefined}
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
        <Led state={ledState} label={PHASE_LABEL[phase]} />
        {serial ? (
          <span className="microlabel">
            {serial}
            {transportKind === 'mock' ? ' · DEMO' : ' · USB'}
          </span>
        ) : null}
      </div>
    </aside>
  );
}
