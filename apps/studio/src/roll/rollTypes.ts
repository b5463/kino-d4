// Wire shapes for the Network / Roll / upload-queue command group
// (KDP 0xa0–0xa9, firmware-contract "Network / Roll / upload queue").
//
// These live in Studio rather than in `@kino/kdp` because the group is the
// newest part of the contract and its types were not frozen with the rest of
// the protocol package. The field names are the reference device's, verbatim.

export type WifiSecurity = 'wpa2' | 'wpa3' | 'open';

/**
 * One saved network as the camera reports it. `password` is always the mask
 * string — the passphrase never leaves the device (05 §13), so `hasPassword`
 * is the only way to know whether one is stored.
 */
export interface NetworkView {
  ssid: string;
  password: string;
  hasPassword: boolean;
  security: WifiSecurity;
  autoJoin: boolean;
  lastSeen: number | null;
}

/** The mask `NETWORK_LIST` reports in place of a stored passphrase. */
export const MASKED_PASSWORD = '••••';

export interface NetworkListResponse {
  networks: NetworkView[];
}

export interface NetworkStatus {
  state: 'connected' | 'connecting' | 'disconnected';
  ssid: string | null;
  ip: string | null;
  rssi: number | null;
  since: number | null;
  internet: boolean;
}

/**
 * `password` is optional on purpose: an update that omits it keeps the stored
 * one, because the host never had it to send back.
 */
export interface NetworkSetRequest {
  ssid: string;
  password?: string;
  security?: WifiSecurity;
  autoJoin?: boolean;
}

export interface UploadQueueReport {
  pending: number;
  uploading: number;
  failed: number;
  uploaded: number;
  /** True while the device is actively working the queue. */
  draining: boolean;
}

export interface UploadQueueRetryResponse {
  ok: boolean;
  retried: number;
  queue: UploadQueueReport;
}

/** `UPLOAD_ENQUEUE` — "push to Roll" for one capture already on the card. */
export interface UploadEnqueueResponse {
  ok: boolean;
  captureId: string;
  queue: UploadQueueReport;
}

export interface RollInfo {
  rollId: string;
  slug: string;
  guestUrl: string;
  name: string;
  /** `ROLL_CREATE` makes the device the host; `ROLL_JOIN` makes it a guest. */
  role: 'host' | 'guest';
  joinedAt: number;
}

/** `roll` is null rather than omitted when the camera is not on a Roll. */
export interface RollView {
  active: boolean;
  roll: RollInfo | null;
  queue: UploadQueueReport;
}

export interface RollCreateResponse {
  rollId: string;
  slug: string;
  guestUrl: string;
  name: string;
  role: 'host' | 'guest';
}
