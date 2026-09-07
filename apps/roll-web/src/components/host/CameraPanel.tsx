import { Panel, StatusLamp, type StatusLampState } from '@kino/design-system';
import type { HostCameraView } from '../../api/hostClient';

/**
 * The camera, in the camera's own words.
 *
 * During a party the host's question is not "how many captures are there" but
 * "is the camera uploading?". The camera answers that on its own screen with
 * four words — ONLINE, OFFLINE, KINO NOT ANSWERING, UPLOAD PAUSED — and two
 * lines, "N waiting to upload" and "All uploaded" (firmware `ui.c`, the roll
 * screen). This panel says the same words. A host holding the camera in one
 * hand and a phone in the other must not have to translate between them.
 */

/** A heartbeat older than this is not a report of anything current. */
export const CAMERA_STALE_MS = 120_000;

export type CameraWord =
  | 'ONLINE'
  | 'OFFLINE'
  | 'KINO NOT ANSWERING'
  | 'UPLOAD PAUSED'
  | 'NOT REPORTING';

export interface CameraReport {
  word: CameraWord;
  lamp: StatusLampState;
  /** The queue line, in the camera's wording. Empty when nothing is known. */
  queue: string;
  /** One plain sentence about what the word means here. */
  note: string;
  /** "12 s ago", or "never" for a camera that has not reported at all. */
  seen: string;
}

/** "12 s ago" / "9 m ago" / "2 h ago" / "3 d ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${String(seconds)} s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))} h ago`;
  return `${String(Math.floor(seconds / 86_400))} d ago`;
}

/**
 * What one camera row says.
 *
 * Three readings the host has to be able to tell apart:
 *  - reporting: a heartbeat inside two minutes. The word comes from what the
 *    camera said about the queue and about this server.
 *  - stale: it reported once and then stopped. Something is wrong, but the
 *    dashboard does not know what, so it does not guess.
 *  - never reported: firmware older than the heartbeat. That camera may be
 *    uploading perfectly; showing it as OFFLINE would be a lie about hardware
 *    the host can see is switched on.
 */
export function cameraReport(camera: HostCameraView, now: number = Date.now()): CameraReport {
  const pending = camera.pending ?? 0;
  const uploading = camera.uploading ?? 0;
  const waiting = pending + uploading;
  // The camera counts what is queued, not what is in flight — the frame being
  // uploaded right now is "Uploading now", not one of the waiting. Same split
  // here, so the two screens print the same number.
  const queue =
    camera.pending === null && camera.uploading === null
      ? ''
      : waiting === 0
        ? 'All uploaded'
        : `${String(pending)} waiting to upload`;

  if (camera.lastSeenAt === null) {
    return {
      word: 'NOT REPORTING',
      lamp: 'off',
      queue: '',
      note: 'This camera has never sent a status. Firmware this old does not report at all — it may be uploading perfectly well.',
      seen: 'never',
    };
  }

  const seen = relativeTime(camera.lastSeenAt, now);
  if (now - new Date(camera.lastSeenAt).getTime() > CAMERA_STALE_MS) {
    return {
      word: 'NOT REPORTING',
      lamp: 'warn',
      queue,
      note: `Last status ${seen}. Anything below is that old. Check the camera's own screen.`,
      seen,
    };
  }

  if (camera.uploadPaused === true) {
    return {
      word: 'UPLOAD PAUSED',
      lamp: 'err',
      queue,
      note: 'Uploads are stopped on the camera. Photos are safe on the card until they are started again.',
      seen,
    };
  }
  if (camera.serverState === 'unreachable') {
    return {
      word: 'KINO NOT ANSWERING',
      lamp: 'err',
      queue,
      note: 'The camera has Wi-Fi but cannot reach this server. Photos are safe on the card and go when it answers.',
      seen,
    };
  }
  if (camera.serverState === 'offline') {
    return {
      word: 'OFFLINE',
      lamp: 'off',
      queue,
      note: 'No Wi-Fi. Photos are safe on the card and go when it returns.',
      seen,
    };
  }
  return {
    word: 'ONLINE',
    lamp: 'ok',
    queue,
    note: waiting === 0 ? 'Everything the camera has shot is here.' : 'Uploading now.',
    seen,
  };
}

function CameraRow({ camera, now }: { camera: HostCameraView; now: number }) {
  const report = cameraReport(camera, now);
  const failed = camera.failed ?? 0;
  return (
    <li className="host-camera" data-word={report.word}>
      <div className="host-camera-head">
        <StatusLamp state={report.lamp} label={report.word} />
        <strong className="host-camera-serial">{camera.serial ?? camera.deviceId}</strong>
      </div>
      {report.queue === '' ? null : <div className="host-camera-queue">{report.queue}</div>}
      {failed > 0 ? (
        <div className="host-camera-failed">
          {String(failed)} {failed === 1 ? 'upload failed' : 'uploads failed'}
        </div>
      ) : null}
      <p className="host-camera-note">{report.note}</p>
      <div className="host-camera-foot">
        Last status {report.seen}
        {camera.firmware === null ? '' : ` · firmware ${camera.firmware}`}
      </div>
    </li>
  );
}

export function CameraPanel({
  cameras,
  now = Date.now(),
}: {
  cameras: HostCameraView[] | undefined;
  now?: number;
}) {
  return (
    <Panel title="Camera">
      {cameras === undefined ? (
        // The field is not in the reply at all: an older API, not an empty roll.
        <p className="host-quiet">This Roll server does not report camera status.</p>
      ) : cameras.length === 0 ? (
        <p className="host-quiet">No camera has joined this roll yet.</p>
      ) : (
        <ul className="host-cameras">
          {cameras.map((camera) => (
            <CameraRow key={camera.deviceId} camera={camera} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
