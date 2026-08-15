import { create } from 'zustand';
import type { TransportKind } from '@kino/kdp';

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
  | 'error';

interface ConnectionState {
  phase: ConnectionPhase;
  transportKind: TransportKind | null;
  error: string | null;
  serialSupported: boolean;
}

export const useConnectionStore = create<ConnectionState>(() => ({
  phase: 'disconnected',
  transportKind: null,
  error: null,
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
  'error': 'ERROR',
};
