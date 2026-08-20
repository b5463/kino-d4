import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import type { UploadQueueReport } from '../../roll/rollTypes';

/**
 * Upload queue (02 §17). The SD card is the source of truth until an upload
 * succeeds, so these counters are the only honest answer to "is my shoot
 * safe" — a failed item is stated, never rounded away.
 */

/** `12 PENDING · 1 UPLOADING · 2 FAILED` — one line, no invented totals. */
export function queueSummary(queue: UploadQueueReport): string {
  const parts = [`${queue.pending} PENDING`];
  if (queue.uploading > 0) parts.push(`${queue.uploading} UPLOADING`);
  parts.push(`${queue.failed} FAILED`);
  return parts.join(' · ');
}

export function UploadQueuePanel({
  queue,
  busy,
  error,
  onRetry,
}: {
  queue: UploadQueueReport | null;
  busy: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  const idle = queue !== null && queue.pending + queue.uploading + queue.failed === 0;
  const lamp =
    queue === null ? { state: 'off' as const, label: 'QUEUE UNKNOWN' }
    : queue.failed > 0 ? { state: 'err' as const, label: 'UPLOADS FAILED' }
    : queue.draining ? { state: 'busy' as const, label: 'UPLOADING' }
    : idle ? { state: 'ok' as const, label: 'QUEUE CLEAR' }
    : { state: 'warn' as const, label: 'QUEUE WAITING' };

  return (
    <Panel title="UPLOAD QUEUE" actions={<Led state={lamp.state} label={lamp.label} />}>
      {error ? <p className="notice notice--err" role="alert">{error}</p> : null}

      {queue === null ? (
        <p className="roll-empty" role="status" aria-live="polite" aria-atomic="true">
          The camera has not reported an upload queue yet.
        </p>
      ) : (
        <>
          <p className="queueline" role="status" aria-live="polite" aria-atomic="true">
            {idle ? 'NOTHING QUEUED' : queueSummary(queue)}
          </p>
          <dl>
            <div className="datarow">
              <dt>Uploaded</dt>
              <dd>{queue.uploaded}</dd>
            </div>
            <div className="datarow">
              <dt>Failed</dt>
              <dd>{queue.failed}</dd>
            </div>
          </dl>
          <div className="panel-actions">
            <Button busy={busy} disabled={queue.failed === 0} onClick={() => void onRetry()}>
              RETRY FAILED
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
