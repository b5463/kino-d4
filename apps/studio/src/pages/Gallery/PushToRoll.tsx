import { useState } from 'react';
import { Button } from '../../components/Button';
import type { RollView } from '../../roll/rollTypes';

/**
 * "Push to Roll" (02 §16) for one capture.
 *
 * The action exists only when the bytes have somewhere to go: the firmware
 * advertises `rollUpload` AND `ROLL_STATUS` reports an active Roll. Anything
 * less and this renders nothing — a button that enqueues into no Roll is a
 * NACK the user was invited to press.
 *
 * Both halves of that gate arrive as props, along with the push itself, so the
 * whole thing can be rendered without a device — the same rule the Roll panels
 * follow.
 */
export function PushToRoll({
  captureId,
  rollUpload,
  roll,
  onPush,
}: {
  captureId: string;
  /** `rollUpload` as the connected firmware advertises it. */
  rollUpload: boolean;
  /** ROLL_STATUS as the gallery last read it. */
  roll: RollView | null;
  onPush: (captureId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = roll?.active === true && roll.roll !== null;
  if (!rollUpload || !active) return null;
  const rollName = roll.roll!.name;

  const push = async () => {
    setBusy(true);
    setError(null);
    try {
      await onPush(captureId);
      setQueued(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none', marginLeft: 8 }}>
      <Button
        size="sm"
        busy={busy}
        disabled={queued}
        title={`Queue ${captureId} for upload to ${rollName}`}
        onClick={() => void push()}
      >
        {queued ? 'QUEUED' : 'PUSH TO ROLL'}
      </Button>
      <span className="microlabel" role="status" aria-live="polite" aria-atomic="true">
        {error ?? (queued ? `IN THE UPLOAD QUEUE FOR ${rollName}` : rollName)}
      </span>
    </span>
  );
}
