import { Icon } from './Icon';
import { ConnectionStrip } from './ConnectionStrip';
import { canOpenDemo, useConnectionStore } from '../state/connectionStore';
import { useDeviceStore } from '../state/deviceStore';
import { connectSerial, connectDemo, disconnect, getDevice } from '../app/session';
import type { PageId } from './Sidebar';

// Icon-and-text command toolbar. Commands mirror the pages/menus; disabled
// commands stay visible so the interface reads the same in every state.

export function Toolbar({
  onNavigate,
  onSelfTest,
  onSync,
  syncBusy,
}: {
  onNavigate: (page: PageId) => void;
  onSelfTest: () => void;
  onSync: () => void;
  /** SYNC is many round trips at 921600 — it has to look like work. */
  syncBusy?: boolean;
}) {
  const phase = useConnectionStore((s) => s.phase);
  const fault = useConnectionStore((s) => s.fault);
  const transportKind = useConnectionStore((s) => s.transportKind);
  const serialSupported = useConnectionStore((s) => s.serialSupported);
  const serial = useDeviceStore((s) => s.info?.serial);

  const connected = phase === 'connected' || phase === 'maintenance';
  const busyPhase = phase === 'updating' || phase === 'reconnecting';

  // ARIA's toolbar pattern expects the arrows to move between commands, not
  // Tab. Both work here: Tab still reaches every enabled button.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.tool-btn:not(:disabled)')];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? buttons.length - 1
      : at < 0 ? 0
      : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Main commands" onKeyDown={onKey}>
      {connected || busyPhase ? (
        <button
          type="button"
          className="tool-btn"
          disabled={busyPhase}
          onClick={() => void disconnect()}
          title={busyPhase ? 'Not while an update or reconnect is running' : 'Close the serial connection'}
        >
          <Icon name="usb" size={20} />
          DISCONNECT
        </button>
      ) : (
        <button
          type="button"
          className="tool-btn"
          disabled={!serialSupported}
          onClick={() => void connectSerial()}
          title={serialSupported ? 'Connect over USB' : 'Web Serial is unavailable in this browser'}
        >
          <Icon name="connect" size={20} />
          CONNECT
        </button>
      )}
      <button
        type="button"
        className={syncBusy ? 'tool-btn is-busy' : 'tool-btn'}
        disabled={!connected}
        aria-busy={syncBusy || undefined}
        onClick={syncBusy ? undefined : onSync}
        title="Re-read all state from the camera (F5)"
      >
        <Icon name="sync" size={20} />
        {syncBusy ? 'READING…' : 'SYNC'}
      </button>
      <span className="tool-sep" />
      <button
        type="button"
        className="tool-btn"
        disabled={!connected || !getDevice()}
        onClick={onSelfTest}
        title="Run the full self test"
      >
        <Icon name="test" size={20} />
        TEST
      </button>
      <button
        type="button"
        className="tool-btn"
        disabled={!connected}
        onClick={() => onNavigate('gallery')}
        title="Browse and download captures"
      >
        <Icon name="download" size={20} />
        GALLERY
      </button>
      <span className="tool-sep" />
      <button
        type="button"
        className="tool-btn"
        disabled={!canOpenDemo(phase)}
        onClick={() => void connectDemo()}
        title="Open the simulated demo camera"
      >
        <Icon name="camera" size={20} />
        DEMO
      </button>

      <span className="tool-device">
        {/* The lamp used to carry `updating` / `reconnecting` by colour alone
            here, while every other Led in the app is required to carry text —
            and then it carried its own private mapping, which said ERROR while
            the status bar 40 px below said PROTOCOL MISMATCH. One mapping now,
            shared with the other two strips. */}
        <ConnectionStrip phase={phase} fault={fault} silentWhenConnected />
        {serial ? `${serial}${transportKind === 'mock' ? ' · DEMO DEVICE' : ' · USB'}` : null}
      </span>
    </div>
  );
}
