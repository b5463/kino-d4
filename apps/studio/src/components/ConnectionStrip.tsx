import { Led } from './Led';
import { connectionStrip } from '../state/connectionStore';
import type { ConnectionFault, ConnectionPhase } from '../state/connectionStore';

/**
 * The 02 §6 connection strip lamp. All three places that show it — the
 * toolbar's device cell, the sidebar footer and the bottom status bar —
 * render this, so a state cannot be named in one and left as a bare ERROR in
 * the others. State is always symbol + text.
 */
export function ConnectionStrip({
  phase,
  fault,
  silentWhenConnected = false,
}: {
  phase: ConnectionPhase;
  fault: ConnectionFault | null;
  /**
   * Drop the wording in the plain connected state only. The toolbar prints the
   * camera's serial immediately beside this lamp, and "KINO CONNECTED
   * KINO000012 · USB" says the same thing twice. Every other state keeps its
   * words there — including MAINTENANCE, which used to be an unlabelled amber
   * lamp in the toolbar, and all three fault states.
   */
  silentWhenConnected?: boolean;
}) {
  const { label, led } = connectionStrip(phase, fault);
  return <Led state={led} label={silentWhenConnected && phase === 'connected' ? '' : label} />;
}
