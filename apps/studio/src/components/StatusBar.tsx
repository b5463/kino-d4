import { Led } from './Led';
import { ConnectionStrip } from './ConnectionStrip';
import { useConnectionStore } from '../state/connectionStore';
import { useEffect, useState } from 'react';
import { pollAgeMs, POLL_PERIOD_MS, useDeviceStore } from '../state/deviceStore';
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

  // Staleness is a function of the clock, so it needs a clock: the store only
  // changes when a poll does something, and a poll that stopped happening
  // changes nothing at all.
  const poll = useDeviceStore((s) => s.poll);
  const [now, setNow] = useState(() => Date.now());
  const watching = poll.failures > 0 || poll.pausedBy !== null;
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => setNow(Date.now()), POLL_PERIOD_MS);
    setNow(Date.now());
    return () => clearInterval(timer);
  }, [watching]);
  const ageMs = pollAgeMs(poll, now);
  const stale =
    ageMs === null
      ? null
      : poll.pausedBy !== null
        ? `HELD ${Math.round(ageMs / 1000)}s — ${poll.pausedBy} HAS THE LINK`
        : `STALE ${Math.round(ageMs / 1000)}s — ${poll.lastError ?? 'THE CAMERA STOPPED ANSWERING'}`;

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
      {/* The numbers to the right are only as good as the last poll. When
          that stopped, say so beside them rather than letting them read as
          live. */}
      {stale ? (
        <span
          className="status-cell"
          role="status"
          title="Camera, power and storage readings below are not current"
        >
          <Led state={poll.pausedBy !== null ? 'busy' : 'warn'} label={`VALUES ${stale}`} />
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
        // D4-V1 has no gauge: the firmware sends null (D10), permanently.
        <span className="status-cell">
          BATT {power.batteryPct === null ? '—' : `${power.batteryPct}%`}
        </span>
      ) : null}
    </div>
  );
}
