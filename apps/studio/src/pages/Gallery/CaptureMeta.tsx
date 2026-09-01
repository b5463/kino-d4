// The metadata table under the inspector stage. Two of them: what the camera
// recorded with the capture, and — for a folder imported from this computer
// with no META.JSON — only what the files on disk prove.

import type { CaptureInfo, CaptureKind } from '@kino/kdp';
import type { CaptureFrame } from './useCaptureFrames';

/** One dash and one reason, in the row the figure would have occupied. */
function Absent({ why }: { why: string }) {
  return (
    <>
      <strong>—</strong> <span className="dim">{why}</span>
    </>
  );
}

/**
 * `meta` is absent when the capture folder held no readable `META.JSON`
 * (contract D20). Every row it would have filled is then a dash and a reason:
 * a `0` in the skew row reads as a measured simultaneous trigger, and
 * `0.00 V` reads as a dead cell.
 */
const NO_META = 'not recorded — this capture carries no META.JSON';

export function CaptureMeta({
  info,
  kind,
  lookName,
}: {
  info: CaptureInfo;
  kind: CaptureKind;
  /** Looks are stored by recipe id; users know them by name. */
  lookName: (id: string | undefined) => string;
}) {
  const meta = info.meta;
  /* What the download could be checked against. Shipped firmware sends no
   * per-file SHA-256 (contract D20), and media.ts hands those bytes over
   * unverified rather than calling a missing digest a match — so the row says
   * which of the two happened instead of leaving "downloaded" to be read as
   * "checked". */
  const digests = info.files.filter((f) => typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(f.sha256)).length;
  return (
    <div style={{ marginTop: 10 }}>
      <dl>
        <div className="datarow"><dt>Taken</dt><dd>{new Date(info.ts).toLocaleString()}</dd></div>
        <div className="datarow">
          <dt>{kind === 'wiggle' ? 'Look' : 'Looks (CAM 1–4)'}</dt>
          <dd>{info.recipeIds.map((id) => lookName(id)).join(' · ')}</dd>
        </div>
        <div className="datarow">
          <dt>Resolution</dt>
          <dd>{info.resolution.replace('x', '×')} · {info.totalKB} KB total</dd>
        </div>
        <div className="datarow">
          <dt>Flash</dt>
          <dd>{meta ? (meta.flash ? 'FIRED' : 'OFF') : <Absent why={NO_META} />}</dd>
        </div>
        {meta && meta.exposure.length > 0 ? (
          <div className="datarow" style={{ maxWidth: 'none' }}>
            <dt>Shutter / gain</dt>
            <dd>
              {meta.exposure.map((e) => (
                <span key={e.cam} style={{ marginRight: 14, whiteSpace: 'nowrap' }}>
                  {e.cam.toUpperCase().replace('CAM', 'CAM ')} {e.shutter} · {e.gain}×
                </span>
              ))}
            </dd>
          </div>
        ) : null}
        {/* The number that decides a wigglegram is the effective exposure
            spread, and firmware does not record it per capture — only GPIO
            distribution reaches the card. Say that, in the place the spread
            would occupy, instead of leaving the µs figure below to be read as
            the answer. */}
        <div className="datarow" style={{ maxWidth: 'none' }}>
          <dt>Effective exposure spread</dt>
          <dd>
            <strong>—</strong>{' '}
            <span className="dim">
              not recorded per capture — measure it live on Developer › TIMING BENCH
            </span>
          </dd>
        </div>
        <div className="datarow" style={{ maxWidth: 'none' }}>
          <dt>GPIO trigger skew</dt>
          <dd className="dim">
            {meta ? (
              <>
                {meta.gpioSkewUs} µs — when the shared trigger edge reached each
                camera. It does not say when each sensor exposed.
              </>
            ) : (
              <Absent why={NO_META} />
            )}
          </dd>
        </div>
        <div className="datarow">
          <dt>Battery at capture</dt>
          <dd>{meta ? `${meta.batteryV.toFixed(2)} V` : <Absent why={NO_META} />}</dd>
        </div>
        <div className="datarow">
          <dt>Firmware</dt>
          <dd>
            {meta ? `P4 ${meta.p4Firmware} · CAM ${meta.cameraFirmware.join('/')}` : <Absent why={NO_META} />}
          </dd>
        </div>
        <div className="datarow" style={{ maxWidth: 'none' }}>
          <dt>Transfer check</dt>
          <dd className="dim">
            {digests > 0 && digests === info.files.length ? (
              `SHA-256 VERIFIED · ${digests} of ${info.files.length} file(s)`
            ) : (
              <Absent
                why={
                  digests === 0
                    ? 'UNVERIFIED — this firmware sends no per-file SHA-256, so nothing checked these bytes'
                    : `UNVERIFIED — a digest arrived for only ${digests} of ${info.files.length} file(s)`
                }
              />
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Nothing here is filled in from elsewhere: no time, no looks, no exposure. */
export function ImportedFileMeta({ id, frames }: { id: string; frames: CaptureFrame[] }) {
  return (
    <div style={{ marginTop: 10 }}>
      <dl>
        <div className="datarow"><dt>Source</dt><dd>IMPORTED FOLDER · {id}</dd></div>
        <div className="datarow" style={{ maxWidth: 'none' }}>
          <dt>Files</dt>
          <dd>
            {frames.map((f) => (
              <span key={f.name} style={{ marginRight: 14, whiteSpace: 'nowrap' }}>
                {f.name} {Math.round(f.data.length / 1024)} KB
              </span>
            ))}
          </dd>
        </div>
        <div className="datarow" style={{ maxWidth: 'none' }}>
          <dt>Taken · looks · exposure</dt>
          <dd>
            <strong>—</strong> <span className="dim">no META.JSON in the folder</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}
