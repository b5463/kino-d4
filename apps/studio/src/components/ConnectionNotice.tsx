import { Icon } from './Icon';
import { connectionNotice } from '../state/connectionStore';
import type { ConnectionFault, ConnectionPhase } from '../state/connectionStore';

/**
 * The banner for a connection state the user has to act on: a protocol
 * mismatch (07 §14 "clearly show version mismatch"), a hardware/link failure,
 * or a board that never came back and needs recovery. Every other state
 * renders nothing.
 */
export function ConnectionNotice({
  phase,
  fault,
  error,
}: {
  phase: ConnectionPhase;
  fault: ConnectionFault | null;
  error: string | null;
}) {
  const notice = connectionNotice(phase, fault, error);
  if (!notice) return null;

  return (
    <p className="notice notice--err" role="alert">
      <Icon name="warning" />
      <span>
        <strong>{notice.title}</strong>
        <br />
        {notice.body}
        {notice.detail ? (
          <>
            <br />
            <span className="mono dim">{notice.detail}</span>
          </>
        ) : null}
      </span>
    </p>
  );
}
