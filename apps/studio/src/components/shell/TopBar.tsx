import { RailIcon } from './RailIcon';
import { ShellMenu } from './ShellMenu';
import type { MenuCommand } from '../MenuBar';
import { ConnectionStrip } from '../ConnectionStrip';
import { useConnectionStore } from '../../state/connectionStore';
import { useDeviceStore } from '../../state/deviceStore';
import { connectSerial, disconnect, getDevice } from '../../app/session';

/**
 * The 40 px strip over the workspace: the open section's name on the left;
 * the device chip, SYNC, TEST, CONNECT / DISCONNECT and the overflow menu on
 * the right. The overflow carries what the File / Camera / Help menus used
 * to. Disabled commands stay visible so the bar reads the same in every state.
 */
export function TopBar({
  title,
  onSelfTest,
  onSync,
  syncBusy,
  overflow,
}: {
  title: string;
  onSelfTest: () => void;
  onSync: () => void;
  /** SYNC is many round trips at 921600 — it has to look like work. */
  syncBusy?: boolean;
  overflow: MenuCommand[];
}) {
  const phase = useConnectionStore((s) => s.phase);
  const fault = useConnectionStore((s) => s.fault);
  const transportKind = useConnectionStore((s) => s.transportKind);
  const serialSupported = useConnectionStore((s) => s.serialSupported);
  const serial = useDeviceStore((s) => s.info?.serial);

  const connected = phase === 'connected' || phase === 'maintenance';
  const busyPhase = phase === 'updating' || phase === 'reconnecting';

  return (
    <div className="topbar" role="toolbar" aria-label="Main commands">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-right">
        {serial || phase !== 'disconnected' ? (
          <span className="topbar-chip">
            <ConnectionStrip phase={phase} fault={fault} silentWhenConnected />
            {serial ? `${serial} · ${transportKind === 'twin' ? 'TWIN' : 'USB'}` : null}
          </span>
        ) : null}
        <button
          type="button"
          className={syncBusy ? 'topbtn is-busy' : 'topbtn'}
          disabled={!connected}
          aria-busy={syncBusy || undefined}
          onClick={syncBusy ? undefined : onSync}
          title="Re-read all state from the camera (F5)"
        >
          <RailIcon name="sync" size={16} />
          {syncBusy ? 'READING…' : 'SYNC'}
        </button>
        <button
          type="button"
          className="topbtn"
          disabled={!connected || !getDevice()}
          onClick={onSelfTest}
          title="Run the full self test"
        >
          <RailIcon name="test" size={16} />
          TEST
        </button>
        {connected || busyPhase ? (
          <button
            type="button"
            className="topbtn"
            disabled={busyPhase}
            onClick={() => void disconnect()}
            title={busyPhase ? 'Not while an update or reconnect is running' : 'Close the serial connection'}
          >
            <RailIcon name="usb" size={16} />
            DISCONNECT
          </button>
        ) : (
          <button
            type="button"
            className="topbtn"
            disabled={!serialSupported}
            onClick={() => void connectSerial()}
            title={serialSupported ? 'Connect over USB' : 'Web Serial is unavailable in this browser'}
          >
            <RailIcon name="usb" size={16} />
            CONNECT
          </button>
        )}
        <ShellMenu label="More commands" items={overflow} align="right">
          <RailIcon name="more" size={16} />
        </ShellMenu>
      </div>
    </div>
  );
}
