// Turns one blocking SYNC_BENCH reply into the EDGE INTEGRITY display model.
//
// Shipped firmware (`handle_sync_bench`, firmware/p4/main/kdp_server.c) does
// not measure skew. It fires N SYNC_OUT pulses and asks every camera node how
// many edges it accepted, saw raw, and refused — so the question it answers is
// "did every trigger arrive exactly once", not "how far apart were the
// exposures". This module never turns an edge count into a millisecond, and
// the report it builds says in words that exposure skew was not measured.

import type { SyncBenchCameraEdges, SyncBenchResponse } from '@kino/kdp';

export interface EdgeIntegrityCamera {
  /** Device id as reported, e.g. `cam3`. */
  cam: string;
  /** `CAM3`. */
  label: string;
  /** False when the node reported no sync block; the counts below are then absent. */
  watched: boolean;
  acceptedEdges: number | null;
  rawEdges: number | null;
  rejectedEdges: number | null;
  /** Pulses actually fired — what `acceptedEdges` is measured against. */
  expected: number | null;
  /** `expected - acceptedEdges`; positive means edges went missing. */
  shortBy: number | null;
  /** `rawEdges - expected`; positive means the node saw bounce. */
  extraRaw: number | null;
  /** 1-based pulse where the sequence first stepped by anything but 1 (polled runs). */
  firstBadPulse: number | null;
  /** Null when the run was not polled — the firmware only checks it per pulse. */
  edgeMonotonic: boolean | null;
  /** The firmware's own verdict for this node: every fired pulse accepted once. */
  clean: boolean | null;
}

export type EdgeIntegrityVerdict = 'clean' | 'dirty' | 'unwatched';

export interface EdgeIntegrityReport {
  /** Discriminant against `SkewReport` in the shared bench store. */
  kind: 'edge-integrity';
  requestedPulses: number;
  /** Pulses actually fired. Short of the request when a capture took over. */
  pulses: number;
  gapMs: number;
  polled: boolean;
  refusedByCapture: number;
  pulseWidthUs: number | null;
  cameras: EdgeIntegrityCamera[];
  /** `clean` only when every watched camera is clean and at least one was watched. */
  verdict: EdgeIntegrityVerdict;
  /** The sentence the display prints in place of a skew figure. */
  notMeasured: string;
}

export const EDGE_VERDICT_LABEL: Record<EdgeIntegrityVerdict, string> = {
  clean: 'TRIGGER WIRE CLEAN',
  dirty: 'TRIGGER WIRE DIRTY',
  unwatched: 'NO CAMERA WATCHED THE TRIGGER',
};

export const EXPOSURE_SKEW_NOT_MEASURED =
  'Exposure skew is not measured by this firmware: SYNC_BENCH counts trigger edges per camera and ' +
  'reports no timing (vsyncTelemetry false). Sensor timing comes from CAMERA_PHASE on the Developer page.';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function cameraRow(edges: SyncBenchCameraEdges): EdgeIntegrityCamera {
  const watched = edges.watched === true;
  const accepted = watched ? num(edges.acceptedEdges) : null;
  const expected = watched ? num(edges.expected) : null;
  const raw = watched ? num(edges.rawEdges) : null;
  // The firmware sends `clean`; an older build that only sends the counts is
  // judged by the same rule it uses (every fired pulse accepted, no more).
  const clean = watched
    ? (bool(edges.clean) ?? (accepted !== null && expected !== null ? accepted === expected : null))
    : null;
  return {
    cam: edges.cam,
    label: String(edges.cam).toUpperCase(),
    watched,
    acceptedEdges: accepted,
    rawEdges: raw,
    rejectedEdges: watched ? num(edges.rejectedEdges) : null,
    expected,
    shortBy: watched ? (num(edges.shortBy) ?? (expected !== null && accepted !== null ? expected - accepted : null)) : null,
    extraRaw: watched ? (num(edges.extraRaw) ?? (raw !== null && expected !== null ? raw - expected : null)) : null,
    firstBadPulse: watched ? num(edges.firstBadPulse) : null,
    edgeMonotonic: watched ? bool(edges.edgeMonotonic) : null,
    clean,
  };
}

/** True when a reply is the blocking SyncBenchResponse rather than a job start. */
export function isSyncBenchResponse(reply: unknown): reply is SyncBenchResponse {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    Array.isArray((reply as { cameras?: unknown }).cameras) &&
    typeof (reply as { jobId?: unknown }).jobId !== 'string'
  );
}

export function buildEdgeIntegrityReport(
  response: SyncBenchResponse,
  requestedPulses: number,
): EdgeIntegrityReport {
  const cameras = (response.cameras ?? []).map(cameraRow);
  const watched = cameras.filter((c) => c.watched);
  let verdict: EdgeIntegrityVerdict;
  if (watched.length === 0) verdict = 'unwatched';
  else if (watched.every((c) => c.clean === true && c.edgeMonotonic !== false)) verdict = 'clean';
  else verdict = 'dirty';
  return {
    kind: 'edge-integrity',
    requestedPulses,
    pulses: num(response.pulses) ?? 0,
    gapMs: num(response.gapMs) ?? 0,
    polled: response.polled === true,
    refusedByCapture: num(response.refusedByCapture) ?? 0,
    pulseWidthUs: num(response.pulseWidthUs),
    cameras,
    verdict,
    notMeasured: EXPOSURE_SKEW_NOT_MEASURED,
  };
}
