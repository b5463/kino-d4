import { create } from 'zustand';
import type { TransportKind } from '@kino/kdp';
import type { LedState } from '../components/Led';

// Connection lifecycle. "connected" is only entered after a successful
// HELLO handshake and protocol check — never on port-open alone.
export type ConnectionPhase =
  | 'disconnected'
  | 'requesting-port'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'maintenance'
  | 'updating'
  | 'reconnecting'
  | 'recovery'
  | 'error';

/**
 * Why the link is in `error`. 02 §6 lists "Protocol mismatch" and "Hardware
 * error" as their own connection-strip states, and they are not the same
 * problem: one needs a different build of Studio or of the firmware, the
 * other needs someone to look at the cable. A bare ERROR lamp said neither.
 */
export type ConnectionFault = 'protocol-mismatch' | 'hardware';

interface ConnectionState {
  phase: ConnectionPhase;
  transportKind: TransportKind | null;
  error: string | null;
  fault: ConnectionFault | null;
  serialSupported: boolean;
}

export const useConnectionStore = create<ConnectionState>(() => ({
  phase: 'disconnected',
  transportKind: null,
  error: null,
  fault: null,
  serialSupported: typeof navigator !== 'undefined' && 'serial' in navigator,
}));

export function setConnection(patch: Partial<ConnectionState>) {
  useConnectionStore.setState(patch);
}

export const PHASE_LABEL: Record<ConnectionPhase, string> = {
  'disconnected': 'DISCONNECTED',
  'requesting-port': 'SELECT PORT…',
  'connecting': 'CONNECTING…',
  'handshaking': 'HANDSHAKE…',
  'connected': 'KINO CONNECTED',
  'maintenance': 'MAINTENANCE',
  'updating': 'UPDATING',
  'reconnecting': 'RECONNECTING…',
  // The board stopped answering and did not come back. 02 §22 is the way out.
  'recovery': 'RECOVERY NEEDED',
  'error': 'ERROR',
};

export const FAULT_LABEL: Record<ConnectionFault, string> = {
  'protocol-mismatch': 'PROTOCOL MISMATCH',
  'hardware': 'HARDWARE ERROR',
};

/**
 * The 02 §6 connection strip, in one place. Both strips (the sidebar footer
 * and the bottom status bar) print exactly this, so a state can never be
 * named in one and left as a bare ERROR in the other.
 */
export function connectionStrip(
  phase: ConnectionPhase,
  fault: ConnectionFault | null,
): { label: string; led: LedState } {
  const led: LedState =
    phase === 'connected' ? 'ok'
    : phase === 'maintenance' || phase === 'updating' ? 'warn'
    : phase === 'reconnecting' ? 'busy'
    : phase === 'error' || phase === 'recovery' ? 'err'
    : 'off';
  const label = phase === 'error' && fault ? FAULT_LABEL[fault] : PHASE_LABEL[phase];
  return { label, led };
}

/**
 * Whether OPEN DEMO DEVICE can be taken. There is no live session to disturb
 * in exactly three states, and `recovery` is one of them: a board that never
 * came back is the state a user is most likely to want the simulator from.
 */
export function canOpenDemo(phase: ConnectionPhase): boolean {
  return phase === 'disconnected' || phase === 'error' || phase === 'recovery';
}

/**
 * The explanation that goes with a fault (02 §31: say what to do, not just
 * that something broke). `null` for every state that is not a fault — an
 * empty banner is worse than no banner.
 */
export function connectionNotice(
  phase: ConnectionPhase,
  fault: ConnectionFault | null,
  error: string | null,
): { title: string; body: string; detail: string | null } | null {
  if (phase === 'recovery') {
    return {
      title: PHASE_LABEL.recovery,
      body:
        'KINO stopped answering and did not come back. Power-cycle it and connect again. ' +
        'If it still does not answer, the board needs the ROM-loader procedure under Updates › Advanced Recovery.',
      detail: error,
    };
  }
  if (phase !== 'error' || !fault) return null;
  if (fault === 'protocol-mismatch') {
    return {
      title: FAULT_LABEL['protocol-mismatch'],
      body:
        'The camera and this KINO Studio do not speak the same protocol version. ' +
        'Update whichever is older — Studio from the build you installed, the camera from Updates.',
      detail: error,
    };
  }
  return {
    title: FAULT_LABEL.hardware,
    body: 'The link to KINO broke. Check the USB-C cable and the port, then connect again.',
    detail: error,
  };
}
