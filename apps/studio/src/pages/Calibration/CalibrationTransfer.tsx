import { useRef, useState } from 'react';
import { CAM_IDS } from '@kino/kdp';
import type { CalibrationData, CamCalibration, CamId } from '@kino/kdp';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDeviceStore } from '../../state/deviceStore';
import { getDevice, refreshCalibration } from '../../app/session';
import { downloadText } from '../../utils/download';

export const CALIBRATION_REPORT_KIND = 'kino-calibration';
export const CALIBRATION_REPORT_SCHEMA = 1;

export interface CalibrationReport {
  kind: string;
  schema: number;
  createdAt: string;
  device: { serial: string; hardware: string; p4Firmware: string };
  calibration: CalibrationData;
}

export interface CalibrationReportCheck {
  ok: boolean;
  error?: string;
  report?: CalibrationReport;
}

const CAL_NUMBER_FIELDS: (keyof CamCalibration)[] = ['ev', 'r', 'g', 'b', 'x', 'y', 'rot'];

export function validateCalibrationReport(json: unknown): CalibrationReportCheck {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'Not a JSON object' };
  const r = json as Partial<CalibrationReport>;
  if (r.kind !== CALIBRATION_REPORT_KIND) return { ok: false, error: 'Not a KINO calibration report' };
  if (r.schema !== CALIBRATION_REPORT_SCHEMA) {
    return { ok: false, error: `Unsupported calibration report schema ${String(r.schema)}` };
  }
  const cams = r.calibration?.cams;
  if (typeof cams !== 'object' || cams === null) return { ok: false, error: 'Report is missing per-camera offsets' };
  for (const cam of CAM_IDS) {
    const entry = (cams as Record<string, Partial<CamCalibration>>)[cam];
    if (!entry) return { ok: false, error: `Report is missing ${cam.toUpperCase()}` };
    for (const field of CAL_NUMBER_FIELDS) {
      if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field])) {
        return { ok: false, error: `${cam.toUpperCase()} ${String(field)} is not a number` };
      }
    }
  }
  return { ok: true, report: r as CalibrationReport };
}

/**
 * Calibration export/import (audit #61). Export writes the full device
 * calibration with the unit's identity — the Wiggle calibration report.
 * Import applies the PER-CAMERA OFFSETS only: camera order is physical truth
 * verified by the blink wizard, and spacing is measured on a unit — neither
 * is something a file from another day (or camera) may overwrite silently.
 */
export function CalibrationTransfer() {
  const calibration = useDeviceStore((s) => s.calibration);
  const info = useDeviceStore((s) => s.info);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<CalibrationReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function exportReport() {
    if (!calibration || !info) return;
    const report: CalibrationReport = {
      kind: CALIBRATION_REPORT_KIND,
      schema: CALIBRATION_REPORT_SCHEMA,
      createdAt: new Date().toISOString(),
      device: { serial: info.serial, hardware: info.hardware, p4Firmware: info.p4Firmware },
      calibration,
    };
    downloadText(`${info.serial}-calibration-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(report, null, 2));
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    void file.text().then((text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setNotice('Import failed: not valid JSON');
        return;
      }
      const check = validateCalibrationReport(json);
      if (!check.ok || !check.report) {
        setNotice(`Import failed: ${check.error}`);
        return;
      }
      setNotice(null);
      setPending(check.report);
    });
  }

  const applyImport = async () => {
    const dev = getDevice();
    if (!dev || !pending) return;
    setPending(null);
    setBusy(true);
    try {
      const offsets = Object.fromEntries(
        CAM_IDS.map((cam) => [cam, { ...pending.calibration.cams[cam] }]),
      ) as Record<CamId, CamCalibration>;
      await dev.applyCalibration(offsets);
      await refreshCalibration();
      setNotice(`Applied per-camera offsets from ${pending.device.serial}. Order and spacing were not touched.`);
    } catch (err) {
      setNotice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
      <Button size="sm" disabled={!calibration || !info} onClick={exportReport}>
        EXPORT REPORT
      </Button>
      <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
        IMPORT OFFSETS
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {notice ? <span className="microlabel">{notice}</span> : null}

      <ConfirmDialog
        open={pending !== null}
        danger
        title="IMPORT CALIBRATION OFFSETS"
        confirmLabel="APPLY OFFSETS"
        onCancel={() => setPending(null)}
        onConfirm={() => void applyImport()}
      >
        {pending ? (
          <>
            {info && pending.device.serial !== info.serial ? (
              <p className="warn" style={{ fontWeight: 600 }}>
                This report is from {pending.device.serial}; the connected camera is {info.serial}. Per-camera
                calibration is measured on one physical unit.
              </p>
            ) : null}
            <p>
              Report of {pending.device.serial}, {new Date(pending.createdAt).toLocaleDateString()}. Applies the
              per-camera EV/RGB/alignment offsets only. Camera order stays as verified on this unit, and spacing
              stays as measured — re-run those procedures if the hardware changed.
            </p>
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
