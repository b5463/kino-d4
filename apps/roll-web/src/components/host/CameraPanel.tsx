import { Panel, StatusLamp, type StatusLampState } from '@kino/design-system';
import type { HostCameraView } from '../../api/hostClient';

/**
 * The camera, in the camera's own words.
 *
 * During a party the host's question is not "how many captures are there" but
 * "is the camera uploading?". The camera answers that on its own screen with
 * four words — ONLINE, OFFLINE, KINO NOT ANSWERING, UPLOAD PAUSED — a big
 * count, and up to three lines about the queue. The source is `firmware/p4/
 * main/ui.c`, the roll screen; every string below is copied from it rather
 * than paraphrased. A host holding the camera in one hand and a phone in the
 * other must not have to translate between them.
 *
 * ## What the server can actually see
 *
 * The heartbeat (`POST /api/device/rolls/:rollId/heartbeat`) carries
 * `pending`, `uploading`, `failed`, `serverState` and `firmware`, and nothing
 * else — the body schema is `.strict()`. So:
 *
 *  - KINO NOT ANSWERING is `serverState === 'unreachable'`, which is exactly
 *    the firmware's `server_quiet`: the heartbeat got here, so Wi-Fi is up,
 *    and the camera still says it cannot deliver.
 *  - OFFLINE is a heartbeat that stopped arriving. A camera with no Wi-Fi
 *    cannot report that it has no Wi-Fi, so silence *is* the report, and
 *    OFFLINE is the camera's own word for the state the host is looking at.
 *  - UPLOAD PAUSED is `uploadPaused === true`, which the heartbeat and
 *    `GET /api/host/rolls/:rollId` now carry (`rolls.ts`, `RollCamera`). It is
 *    three-valued on the wire — `null` is "this firmware does not report it" —
 *    so only the explicit `true` shows the word; `null` must never be read as
 *    "not paused", because nobody asked that camera.
 *  - NOT REPORTING is the one word here that is not the camera's, and it is
 *    reserved for the one thing the camera cannot say: nothing has ever
 *    arrived. Firmware older than the heartbeat is silent and may be uploading
 *    perfectly; calling that OFFLINE would be a lie about hardware the host
 *    can see is switched on.
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
  /** The camera's own second line: "Uploading now", "Saved safely on camera". */
  line2: string;
  /** One plain sentence about what the word means here. */
  note: string;
  /** "12 s ago", or "never" for a camera that has not reported at all. */
  seen: string;
  /** True when this camera is the reason the host should put the phone down. */
  alarm: boolean;
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
 * What one camera says about itself.
 *
 * `waiting` follows the firmware: `q.pending + q.card_pending`, which is the
 * queue *excluding* the frame in flight. The one being uploaded right now is
 * "Uploading now", not one of the waiting, so the two screens print the same
 * number rather than differing by one.
 */
export function cameraReport(camera: HostCameraView, now: number = Date.now()): CameraReport {
  const waiting = camera.pending ?? 0;
  const inFlight = camera.uploading ?? 0;
  const silent = camera.pending === null && camera.uploading === null;
  const queue = silent ? '' : waiting + inFlight === 0 ? 'All uploaded' : `${String(waiting)} waiting to upload`;

  if (camera.lastSeenAt === null) {
    return {
      word: 'NOT REPORTING',
      lamp: 'off',
      queue: '',
      line2: '',
      note: 'This camera has never sent a status. Firmware this old does not report at all — it may be uploading perfectly well.',
      seen: 'never',
      alarm: false,
    };
  }

  const seen = relativeTime(camera.lastSeenAt, now);

  /**
   * Silence, not a state the camera announced. Everything below the word is
   * as old as the heartbeat, so the counters are shown and dated rather than
   * shown as if they were current.
   *
   * This is deliberately ahead of the UPLOAD PAUSED branch. `uploadPaused` is
   * a field in a heartbeat, so a camera that paused and then went off the air
   * keeps sending nothing and its last message keeps saying "paused" for as
   * long as the tab is open. OFFLINE is the newer fact of the two: the host
   * cannot go and unpause a camera that is not on.
   */
  if (now - new Date(camera.lastSeenAt).getTime() > CAMERA_STALE_MS) {
    return {
      word: 'OFFLINE',
      lamp: 'off',
      queue,
      line2: 'Saved safely on camera',
      note: `No status for ${seen.replace(' ago', '')}. The camera is off, asleep, or out of Wi-Fi. Nothing below is newer than that.`,
      seen,
      alarm: waiting > 0,
    };
  }

  /**
   * UPLOAD PAUSED, and it is the worst of the four words.
   *
   * The camera halts its own queue when the server refuses its upload
   * credential (`firmware/HARDWARE_VALIDATION.md`: "a credential fault shows
   * UPLOAD PAUSED and 'Check the roll in Studio.'"). Nothing at all leaves the
   * card until somebody re-provisions it — unlike OFFLINE and KINO NOT
   * ANSWERING, waiting does not fix this one — so it says so, and it says the
   * other half too, because a host reading an alarm needs to know what is at
   * stake: the photographs are on the card and none of them are lost.
   */
  if (camera.uploadPaused === true) {
    return {
      word: 'UPLOAD PAUSED',
      lamp: 'err',
      queue,
      line2: 'Saved safely on camera',
      note: 'Check the roll in Studio. The camera stopped its own queue because this server refused its upload credential, and nothing will upload until that is fixed. Waiting will not clear it.',
      seen,
      alarm: true,
    };
  }

  if (camera.serverState === 'unreachable') {
    return {
      word: 'KINO NOT ANSWERING',
      lamp: 'err',
      queue,
      line2: 'Saved safely on camera',
      note: 'Wi-Fi is up. They go when KINO answers.',
      seen,
      alarm: true,
    };
  }

  // Kept for a server that reports it, though no deployed heartbeat does:
  // `serverState` is `unknown | reachable | unreachable` on the wire today.
  if (camera.serverState === 'offline') {
    return {
      word: 'OFFLINE',
      lamp: 'off',
      queue,
      line2: 'Saved safely on camera',
      note: 'No Wi-Fi. They go when Wi-Fi returns.',
      seen,
      alarm: waiting > 0,
    };
  }

  return {
    word: 'ONLINE',
    lamp: 'ok',
    queue,
    line2: inFlight > 0 ? 'Uploading now' : waiting > 0 ? 'Starting upload' : '',
    note:
      waiting + inFlight === 0
        ? 'Everything the camera has shot is here.'
        : 'Photographs are leaving the camera.',
    seen,
    alarm: false,
  };
}

/**
 * The camera the status strip speaks for, on a roll that has several.
 *
 * Two rules, in this order, because the strip answers one question — "is the
 * camera uploading?" — and has room for one camera plus "+N more".
 *
 *  1. **A camera that is stuck wins.** UPLOAD PAUSED and KINO NOT ANSWERING
 *     are things the host has to go and fix, so they take the headline
 *     whatever else is on the roll.
 *  2. **Otherwise the freshest heartbeat wins** — the camera actually doing
 *     the work.
 *
 * Rule 2 is not a tidiness preference. A live roll here had one camera
 * uploading with six waiting and three that had joined and never sent a
 * heartbeat; ranking purely by how far a word is from ONLINE put NOT
 * REPORTING in the headline and hid the only camera that was working. NOT
 * REPORTING says of itself that the camera "may be uploading perfectly well",
 * so it is an absence of news, not news — it belongs in "+3 more cameras" and
 * in the setup panel's list, not at the top of the page.
 */
const ALARM_SEVERITY: Record<CameraWord, number> = {
  'UPLOAD PAUSED': 0,
  'KINO NOT ANSWERING': 1,
  OFFLINE: 2,
  'NOT REPORTING': 3,
  ONLINE: 4,
};

export function worstCamera(
  cameras: HostCameraView[],
  now: number = Date.now(),
): HostCameraView | null {
  let best: HostCameraView | null = null;
  let bestAlarm = Number.POSITIVE_INFINITY;
  let bestSeen = Number.NEGATIVE_INFINITY;

  for (const camera of cameras) {
    const report = cameraReport(camera, now);
    // An alarming camera is ranked by how bad it is; everything else is ranked
    // by how recently it spoke, so the two orderings never mix.
    const alarm = report.alarm ? ALARM_SEVERITY[report.word] : Number.POSITIVE_INFINITY;
    const seen = camera.lastSeenAt === null ? Number.NEGATIVE_INFINITY : new Date(camera.lastSeenAt).getTime();

    if (best === null || alarm < bestAlarm || (alarm === bestAlarm && seen > bestSeen)) {
      best = camera;
      bestAlarm = alarm;
      bestSeen = seen;
    }
  }
  return best;
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
      {/* Whose count this is, said in the line itself. The moderation filter
          bar a screen below carries a "Failed to process" count from the
          captures table, and the two are different numbers about different
          things — see `stuckItems`. */}
      {failed > 0 ? (
        <div className="host-camera-failed">
          Gave up sending {String(failed)} {failed === 1 ? 'photograph' : 'photographs'}
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
    <Panel title={cameras !== undefined && cameras.length > 1 ? 'Cameras' : 'Camera'}>
      {cameras === undefined ? (
        // The field is not in the reply at all: an older API, not an empty roll.
        <p className="host-quiet">This Roll server does not report camera status.</p>
      ) : cameras.length === 0 ? (
        <p className="host-quiet">
          No camera has joined this roll yet. Type the code on the camera to join it.
        </p>
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
