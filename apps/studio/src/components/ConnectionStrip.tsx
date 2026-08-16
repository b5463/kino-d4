import { Led } from './Led';
import { connectionStrip } from '../state/connectionStore';
import type { ConnectionFault, ConnectionPhase } from '../state/connectionStore';

/**
 * The 02 §6 connection strip lamp. Both places that show it — the sidebar
 * footer and the bottom status bar — render this, so a state cannot be named
 * in one and left as a bare ERROR in the other. State is always symbol + text.
 */
export function ConnectionStrip({
  phase,
  fault,
}: {
  phase: ConnectionPhase;
  fault: ConnectionFault | null;
}) {
  const { label, led } = connectionStrip(phase, fault);
  return <Led state={led} label={label} />;
}
