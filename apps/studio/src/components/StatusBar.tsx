import { Led } from './Led';
import { ConnectionStrip } from './ConnectionStrip';
import { useConnectionStore } from '../state/connectionStore';
import { useDeviceStore } from '../state/deviceStore';
import { useDeviceBusy } from '../state/deviceBusy';
import { useDraftStore } from '../state/draftStore';
import { formatMB } from '../utils/format';

// Bottom status bar: the vital signs stay visible no matter which section
// is open. Every state is text + lamp, never color alone.

export function StatusBar() {
  const phase = useConnectionStore((s) => s.phase);
  const fault = useConnectionStore((s) => s.fault);
  const cameras = useDeviceStore((s) => s.cameras);
  const power = useDeviceStore((s) => s.power);
  const storage = useDeviceStore((s) => s.storage);
  const busyLabel = useDeviceBusy((s) => s.label);
  const dirty = useDraftStore((s) => s.dirty);
  const unsaved = [...new Set(Object.values(dirty))];

  return (
    // A landmark, not a live region: the cells inside announce themselves, and
    // wrapping the whole bar in role="status" would re-read every number on
    // every 4 s poll.
    <div className="statusbar" role="region" aria-label="Camera vital signs">
      <span className="status-cell status-cell--stretch">
        <ConnectionStrip phase={phase} fault={fault} />
      </span>
      {/* One UART, one operation at a time — the holder is named so a
          disabled bench button is never a mystery. */}
      {busyLabel ? (
        <span className="status-cell" role="status">
          <Led state="busy" label={`${busyLabel} RUNNING`} />
        </span>
      ) : null}
      {unsaved.length > 0 ? (
        <span className="status-cell" title="Sections with changes that are not saved to KINO">
          UNSAVED: {unsaved.join(', ')}
        </span>
      ) : null}
      {cameras.length === 4 ? (
        <span className="status-cell status-cam" aria-label="Camera module status" aria-live="polite">
          {cameras.map((cam) => {
            const cls = !cam.online ? 'bad' : cam.state === 'ready' ? 'ok' : 'warn';
            const mark = !cam.online ? '✗' : cam.state === 'ready' ? '✓' : '…';
            return (
              <span key={cam.id} className={cls}>
                C{cam.id.slice(-1)}{mark}
              </span>
            );
          })}
        </span>
      ) : null}
      {storage ? (
        <span className="status-cell">SD {storage.present ? `${formatMB(storage.freeMB)} FREE` : '— NO CARD'}</span>
      ) : null}
      {power ? (
        <span className="status-cell">BATT {power.batteryPct}%</span>
      ) : null}
    </div>
  );
}
