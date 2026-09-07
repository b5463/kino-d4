import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import type { UploadQueueReport } from '../../roll/rollTypes';

/**
 * Upload queue (02 §17). The SD card is the source of truth until an upload
 * succeeds, so these counters are the only honest answer to "is my shoot
 * safe" — a failed item is stated, never rounded away.
 *
 * ## One vocabulary, three surfaces
 *
 * The camera prints this queue on its own roll screen, and the Roll host
 * dashboard prints it again in a browser. The same operator reads all three,
 * often two at a time, so all three say it in the same words — the camera's,
 * from `firmware/p4/main/ui.c`:
 *
 *     "6 waiting to upload"  ·  "Uploading now"  ·  "All uploaded"
 *     "Nothing waiting"      ·  "Saved safely on camera"
 *
 * This panel used to invent a third set — `12 PENDING · 1 UPLOADING · 2
 * FAILED`, `NOTHING QUEUED`, `QUEUE CLEAR`, `QUEUE WAITING` — which is the
 * queue struct's field names read out loud. An operator holding the camera in
 * one hand had to translate "QUEUE WAITING" into "3 waiting to upload" to know
 * whether the two screens agreed.
 *
 * `waiting` follows the firmware and counts the queue *excluding* the frame in
 * flight, so the number here and the number on the camera are the same number
 * rather than differing by one.
 */

/** `6 waiting to upload` / `All uploaded` / `Nothing waiting` — the camera's line. */
export function queueSummary(queue: UploadQueueReport): string {
  if (queue.pending > 0) return `${queue.pending} waiting to upload`;
  if (queue.uploading > 0) return 'Uploading now';
  return queue.uploaded > 0 ? 'All uploaded' : 'Nothing waiting';
}

/** The lamp, in the same words. */
export function queueLamp(queue: UploadQueueReport | null): {
  state: 'ok' | 'warn' | 'err' | 'busy' | 'off';
  label: string;
} {
  if (queue === null) return { state: 'off', label: 'NOT REPORTING' };
  if (queue.failed > 0) return { state: 'err', label: 'UPLOADS FAILED' };
  if (queue.uploading > 0 || queue.draining) return { state: 'busy', label: 'UPLOADING' };
  if (queue.pending > 0) return { state: 'warn', label: 'WAITING TO UPLOAD' };
  return { state: 'ok', label: queue.uploaded > 0 ? 'ALL UPLOADED' : 'NOTHING WAITING' };
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
  const lamp = queueLamp(queue);

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
            {queueSummary(queue)}
          </p>
          {/* The camera's second line, and only when it has something to say:
              a queue that cannot move is the one case where "the photographs
              are not lost" is the sentence the operator needs. */}
          {queue.failed > 0 ? (
            <p className="queuenote">
              {queue.failed} {queue.failed === 1 ? 'upload failed' : 'uploads failed'}. Saved safely
              on camera.
            </p>
          ) : null}
          <dl>
            <div className="datarow">
              <dt>Uploaded</dt>
              <dd>{queue.uploaded}</dd>
            </div>
            <div className="datarow">
              <dt>Uploading now</dt>
              <dd>{queue.uploading}</dd>
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
