import { StatusLamp } from '@kino/design-system';
import type { HostCameraView, HostCaptureView, HostRollView } from '../../api/hostClient';
import { cameraReport, worstCamera } from './CameraPanel';
import type { CaptureFilter } from './CaptureGrid';

/**
 * The three questions, answered above the fold.
 *
 * A host working a party asks, in this order and no other:
 *
 *   1. is the camera uploading?
 *   2. is anything stuck?
 *   3. how many photographs are there?
 *
 * The old dashboard answered them in the wrong order and at the wrong sizes.
 * Question 3 was four equal tiles across the top — CAPTURES, GUESTS, PENDING,
 * HIDDEN — so the least urgent number was the largest thing on the page; two
 * of those tiles repeated, in different words and from a different source,
 * numbers the moderation filter bar already carried, and the two disagreed on
 * screen. Question 1 was a small box in a six-panel grid. Question 2 was a
 * burgundy line inside that box, below the fold on a phone.
 *
 * This strip is one row of three tiles in the order above, and it is modelled
 * on the camera's own roll screen (`firmware/p4/main/ui.c`) — lamp and word,
 * then a big count, then the queue in the camera's sentences — because the
 * host is holding that screen in their other hand.
 */

/** One thing that is stuck, and the filter that shows it. */
export interface StuckItem {
  filter: CaptureFilter | null;
  count: number;
  label: string;
}

/**
 * What is stuck, worst first.
 *
 * Upload failures come from the camera and are not in the capture list at all
 * — a photograph that never left the card has no row here — so they are stated
 * first and separately, and they have no filter to jump to.
 *
 * ## Two different numbers, both of which used to be called "failed"
 *
 * This tile read "4 uploads failed on the camera" while the moderation filter
 * bar one panel below read "Failed 0", on the same screen, and both were
 * right. They count different things in different places:
 *
 *  - the camera's own tally of photographs it stopped trying to send
 *    (`cameras[].failed`, from the heartbeat). Those files are on the SD card
 *    and the server has never seen them, so they have no capture row and no
 *    filter to jump to.
 *  - captures the server accepted and then could not process
 *    (`status === 'failed'`). Those are rows, and Failed to process selects
 *    them.
 *
 * A host cannot be asked to hold that distinction in their head, so neither
 * number is allowed to say only "failed": each one names who counted it and
 * what happened, and the filter bar's label is "Failed to process" for the
 * same reason.
 */
export function stuckItems(
  cameras: HostCameraView[] | undefined,
  captures: HostCaptureView[],
): StuckItem[] {
  const out: StuckItem[] = [];

  const uploadsFailed = (cameras ?? []).reduce((sum, camera) => sum + (camera.failed ?? 0), 0);
  if (uploadsFailed > 0) {
    out.push({
      filter: null,
      count: uploadsFailed,
      label:
        uploadsFailed === 1
          ? 'photograph the camera gave up sending'
          : 'photographs the camera gave up sending',
    });
  }

  const live = captures.filter((capture) => capture.deletedAt === null);
  const failed = live.filter((capture) => capture.status === 'failed').length;
  if (failed > 0) {
    out.push({
      filter: 'failed',
      count: failed,
      label:
        failed === 1
          ? 'photograph the server could not process'
          : 'photographs the server could not process',
    });
  }

  const processing = live.filter(
    (capture) => capture.status !== 'ready' && capture.status !== 'failed',
  ).length;
  if (processing > 0) {
    out.push({ filter: 'pending', count: processing, label: 'still processing' });
  }

  return out;
}

export function StatusStrip({
  roll,
  captures,
  now = Date.now(),
  onFilter,
}: {
  roll: HostRollView;
  captures: HostCaptureView[];
  now?: number;
  onFilter: (filter: CaptureFilter) => void;
}) {
  const cameras = roll.cameras;
  const camera = cameras === undefined ? null : worstCamera(cameras, now);
  const report = camera === null ? null : cameraReport(camera, now);
  const others = cameras === undefined ? 0 : Math.max(0, cameras.length - 1);
  const stuck = stuckItems(cameras, captures);
  const trashed = captures.filter((capture) => capture.deletedAt !== null).length;

  /**
   * `report.alarm` first, not the lamp.
   *
   * OFFLINE carries an `off` lamp — a hollow circle, correctly, because the
   * camera is not lit up — but an OFFLINE camera with six photographs waiting
   * on its card IS the problem on this page. Deriving the tile's colour from
   * the lamp alone gave that tile a grey rule and a white ground while the
   * same tile was announcing itself to a screen reader as an alert. The two
   * now agree: if it is worth interrupting for, it is worth colouring.
   */
  const tone =
    report === null ? 'off'
    : report.alarm ? 'bad'
    : report.lamp === 'err' ? 'bad'
    : report.lamp === 'warn' ? 'warn'
    : report.lamp === 'ok' ? 'ok'
    : 'off';

  const photos = roll.counts.captures;

  return (
    <section className="host-now" aria-label="Roll at a glance">
      {/*
        1. Is the camera uploading?

        The tile is its own alarm. There used to be a separate burgundy line
        above the strip repeating the word and the queue, which made sense when
        the camera was a small panel four screens down; with the camera at the
        top of the page it was simply the same sentence printed twice, and on a
        phone the two blocks filled the first screen between them.

        `role="alert"` only when the camera is actually stuck, so a screen
        reader is interrupted by KINO NOT ANSWERING and not by ONLINE.
      */}
      <div
        className="host-now-tile host-now-camera"
        data-tone={tone}
        role={report?.alarm === true ? 'alert' : undefined}
      >
        <h2 className="host-now-label">Camera</h2>
        {report === null || camera === null ? (
          <p className="host-now-line">
            {cameras === undefined
              ? 'This Roll server does not report camera status.'
              : 'No camera has joined this roll yet.'}
          </p>
        ) : (
          <>
            <div className="host-now-word">
              {/* `announce` makes this one lamp a live region: the camera going
                  quiet is the single transition worth interrupting a screen
                  reader for, and it is the only lamp on the page that gets it. */}
              <StatusLamp state={report.lamp} label={report.word} announce />
            </div>
            {report.queue === '' ? null : <p className="host-now-queue">{report.queue}</p>}
            {report.line2 === '' ? null : <p className="host-now-line">{report.line2}</p>}
            <p className="host-now-line">{report.note}</p>
            {/* Serial, age and firmware. With one camera on the roll this is
                everything the setup panel would have said, which is why that
                panel is not also rendered for a single camera — see
                `HostDashboard`. */}
            <p className="host-now-foot">
              {camera.serial ?? camera.deviceId} · last status {report.seen}
              {camera.firmware === null ? '' : ` · firmware ${camera.firmware}`}
              {others === 0 ? '' : ` · ${String(others)} more ${others === 1 ? 'camera' : 'cameras'}`}
            </p>
          </>
        )}
      </div>

      {/*
        2. Is anything stuck?

        "Nothing stuck." in green, next to a tile shouting UPLOAD PAUSED, is
        the page contradicting itself: a camera holding six photographs it
        cannot send is the definition of stuck. Nothing is repeated here — the
        count and the sentences stay in the camera's own tile, which is where
        the host has to act — but this tile stops claiming otherwise.
      */}
      <div
        className="host-now-tile"
        data-tone={stuck.length > 0 ? 'bad' : report?.alarm === true ? 'warn' : 'ok'}
      >
        <h2 className="host-now-label">Stuck</h2>
        {stuck.length === 0 ? (
          <p className="host-now-clear">
            {report?.alarm === true
              ? 'Nothing stuck on the server. The camera is — read the Camera tile.'
              : 'Nothing stuck.'}
          </p>
        ) : (
          <ul className="host-now-stuck">
            {stuck.map((item) => (
              <li key={item.label}>
                {item.filter === null ? (
                  <span>
                    <b>{item.count}</b> {item.label}
                  </span>
                ) : (
                  <button type="button" onClick={() => onFilter(item.filter as CaptureFilter)}>
                    <b>{item.count}</b> {item.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        3. How many photographs are there?

        `roll.counts.captures` is the server's count of captures not in the
        trash, hidden ones included. The moderation bar's "All" is every row
        this page is holding, trash included, so the two differ by exactly the
        trash — which is why the trash is named here. Without that line the
        host read "12 PHOTOS" beside "All 13" and had no way to close the gap.
      */}
      <div className="host-now-tile" data-tone="off">
        <h2 className="host-now-label">On this roll</h2>
        <p className="host-now-figure">
          {photos.toLocaleString()}
          <span className="host-now-unit">{photos === 1 ? 'PHOTO' : 'PHOTOS'}</span>
        </p>
        <p className="host-now-sub">
          {roll.guests.toLocaleString()} {roll.guests === 1 ? 'guest' : 'guests'}
          {roll.counts.hidden > 0 ? ` · ${String(roll.counts.hidden)} hidden` : ''}
          {trashed > 0 ? ` · ${String(trashed)} in the trash, not counted` : ''}
        </p>
      </div>
    </section>
  );
}
