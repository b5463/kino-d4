// The metadata table under the inspector stage. Two of them: what the camera
// recorded with the capture, and — for a folder imported from this computer
// with no META.JSON — only what the files on disk prove.

import type { CaptureInfo, CaptureKind } from '@kino/kdp';
import type { CaptureFrame } from './useCaptureFrames';

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
        <div className="datarow"><dt>Flash</dt><dd>{info.meta.flash ? 'FIRED' : 'OFF'}</dd></div>
        {info.meta.exposure.length > 0 ? (
          <div className="datarow" style={{ maxWidth: 'none' }}>
            <dt>Shutter / gain</dt>
            <dd>
              {info.meta.exposure.map((e) => (
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
            {info.meta.gpioSkewUs} µs — when the shared trigger edge reached each
            camera. It does not say when each sensor exposed.
          </dd>
        </div>
        <div className="datarow"><dt>Battery at capture</dt><dd>{info.meta.batteryV.toFixed(2)} V</dd></div>
        <div className="datarow"><dt>Firmware</dt><dd>P4 {info.meta.p4Firmware} · CAM {info.meta.cameraFirmware.join('/')}</dd></div>
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
