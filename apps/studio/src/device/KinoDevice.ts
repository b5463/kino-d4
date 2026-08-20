import { Cmd } from '@kino/kdp';
import type { KinoProtocolClient } from '@kino/kdp';
import type {
  CamId,
  CamCalibration,
  CameraInfo,
  CapabilitiesResponse,
  CaptureInfo,
  ConfigEnvelope,
  DeviceInfo,
  FlashDistance,
  FlashLevel,
  FwBeginRequest,
  FwBeginResponse,
  FwEndResponse,
  FwQueryResponse,
  FwStatusResponse,
  HelloResponse,
  KinoConfig,
  LogEntry,
  LinkBenchResult,
  MediaListRequest,
  MediaListResponse,
  PhaseResult,
  PowerStatus,
  RecipesResponse,
  RuntimeStats,
  ShootMode,
  SoundBeginRequest,
  SoundBeginResponse,
  SoundInfo,
  SoundsResponse,
  StorageStatus,
  TargetId,
} from '@kino/kdp';
import { CONFIG_SCHEMA_VERSION } from '@kino/kdp';
import type { TimingResult } from '@kino/kdp';
import type { Recipe } from '../recipes/recipeTypes';
import type {
  NetworkListResponse,
  NetworkSetRequest,
  NetworkStatus,
  RollCreateResponse,
  PublishedRollJoinRequest,
  RollView,
  UploadEnqueueResponse,
  UploadQueueReport,
  UploadQueueRetryResponse,
} from '../roll/rollTypes';

/**
 * Typed command facade over the protocol client. Pages talk to this — never
 * to raw frames. Logical targets only (P4, CAM1..CAM4); pin/GPIO mapping is
 * firmware's business.
 */
export class KinoDevice {
  readonly client: KinoProtocolClient;

  constructor(client: KinoProtocolClient) {
    this.client = client;
  }

  /** Nonce proves the reply belongs to this attempt, not a stale buffer. */
  hello(nonce: number, timeoutMs = 500) {
    return this.client.request<HelloResponse>(Cmd.HELLO, { nonce }, timeoutMs);
  }

  getCapabilities() {
    return this.client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
  }

  getDeviceInfo() {
    return this.client.request<DeviceInfo>(Cmd.GET_DEVICE_INFO);
  }

  getCameraInfo() {
    return this.client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO);
  }

  getPowerStatus() {
    return this.client.request<PowerStatus>(Cmd.GET_POWER_STATUS);
  }

  getStorageStatus() {
    return this.client.request<StorageStatus>(Cmd.GET_STORAGE_STATUS);
  }

  getConfig() {
    return this.client.request<ConfigEnvelope>(Cmd.GET_CONFIG);
  }

  async applyConfig(patch: Partial<KinoConfig>): Promise<void> {
    await this.client.request(Cmd.SET_CONFIG, { schemaVersion: CONFIG_SCHEMA_VERSION, config: patch });
    await this.client.request(Cmd.SAVE_CONFIG);
  }

  resetConfig() {
    return this.client.request(Cmd.RESET_CONFIG);
  }

  setMode(mode: ShootMode) {
    return this.client.request(Cmd.SET_MODE, { mode });
  }

  getRecipes() {
    return this.client.request<RecipesResponse<Recipe>>(Cmd.GET_RECIPES);
  }

  setActiveRecipe(id: string) {
    return this.client.request(Cmd.SET_RECIPE, { id });
  }

  uploadRecipe(recipe: Recipe) {
    return this.client.request(Cmd.UPLOAD_RECIPE, { recipe });
  }

  deleteRecipe(id: string) {
    return this.client.request(Cmd.DELETE_RECIPE, { id });
  }

  // ---- sounds ----

  getSounds() {
    return this.client.request<SoundsResponse>(Cmd.GET_SOUNDS);
  }

  soundBegin(req: SoundBeginRequest) {
    return this.client.request<SoundBeginResponse>(Cmd.SOUND_BEGIN, req, 8000);
  }

  soundChunk(sessionId: number, offset: number, data: Uint8Array) {
    const payload = new Uint8Array(8 + data.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, sessionId, true);
    view.setUint32(4, offset, true);
    payload.set(data, 8);
    return this.client.requestBinary<{ ok: boolean; received: number }>(Cmd.SOUND_CHUNK, payload, 8000);
  }

  soundEnd() {
    return this.client.request<{ ok: boolean; sound: SoundInfo }>(Cmd.SOUND_END, undefined, 8000);
  }

  soundRead(id: string, offset: number, length: number) {
    return this.client.requestBytes(Cmd.SOUND_READ, { id, offset, length }, 8000);
  }

  soundDelete(id: string) {
    return this.client.request(Cmd.SOUND_DELETE, { id });
  }

  cameraStatus(cam: CamId) {
    return this.client.request<CameraInfo>(Cmd.CAMERA_STATUS, { cam }, 2000);
  }

  cameraTest(cam: CamId) {
    return this.client.request<{ ok: boolean; jpegKB: number; durationMs: number }>(
      Cmd.CAMERA_TEST,
      { cam },
      5000,
    );
  }

  /** One viewfinder JPEG frame from the given camera (default viewfinder). */
  previewFrame(cam?: CamId) {
    return this.client.requestBytes(Cmd.CAMERA_PREVIEW, cam ? { cam } : undefined, 4000);
  }

  /**
   * One synchronized test capture reporting all three timing metrics:
   * GPIO distribution, VSYNC phase and effective exposure skew.
   */
  timingTest() {
    return this.client.request<TimingResult>(Cmd.CAMERA_CAPTURE, { action: 'timing-test' }, 8000);
  }

  /** Read current sensor frame phases without changing them. */
  measurePhase() {
    return this.client.request<PhaseResult>(Cmd.CAMERA_PHASE, { action: 'measure' }, 6000);
  }

  /** Restart sensors with compensating delays to align frame timelines. */
  rephaseSensors() {
    return this.client.request<{ started: boolean }>(Cmd.CAMERA_PHASE, { action: 'rephase' }, 8000);
  }

  resetPhase() {
    return this.client.request<PhaseResult>(Cmd.CAMERA_PHASE, { action: 'reset' }, 6000);
  }

  /** Stress all four camera UARTs concurrently at a candidate baud. */
  linkBench(baud: number, bytes = 262_144) {
    return this.client.request<LinkBenchResult>(Cmd.LINK_BENCH, { baud, bytes }, 20000);
  }

  setLinkBaud(baud: number) {
    return this.client.request<{ ok: boolean; baud: number }>(Cmd.SET_LINK_BAUD, { baud }, 6000);
  }

  getCalibration() {
    return this.client.request<import('@kino/kdp').CalibrationData>(Cmd.CAMERA_CALIBRATE, { action: 'get' });
  }

  startCalibration() {
    return this.client.request<{ started: boolean }>(Cmd.CAMERA_CALIBRATE, { action: 'start' });
  }

  applyCalibration(offsets: Record<CamId, CamCalibration>) {
    return this.client.request(Cmd.CAMERA_CALIBRATE, { action: 'apply', offsets });
  }

  resetCalibration() {
    return this.client.request(Cmd.CAMERA_CALIBRATE, { action: 'reset' });
  }

  calibrationBlink(cam: CamId) {
    return this.client.request(Cmd.CAMERA_CALIBRATE, { action: 'order-blink', cam });
  }

  saveCameraOrder(order: [CamId, CamId, CamId, CamId]) {
    return this.client.request(Cmd.CAMERA_CALIBRATE, { action: 'order-save', order });
  }

  saveLensSpacing(spacingMm: [number, number, number, number], spacingSource: 'nominal' | 'measured') {
    return this.client.request(Cmd.CAMERA_CALIBRATE, { action: 'spacing-save', spacingMm, spacingSource });
  }

  flashTest(flash: { level: FlashLevel; distance: FlashDistance }) {
    return this.client.request<{ results: { cam: CamId; clippedPct: number }[]; suggested: FlashLevel }>(
      Cmd.CAMERA_CALIBRATE,
      { action: 'flash-test', flash },
      8000,
    );
  }

  saveFlashCalibration(flash: { level: FlashLevel; distance: FlashDistance }) {
    return this.client.request(Cmd.CAMERA_CALIBRATE, { action: 'flash-save', flash });
  }

  getLogs() {
    return this.client.request<{ entries: LogEntry[] }>(Cmd.GET_LOGS);
  }

  clearDeviceLogs() {
    return this.client.request(Cmd.CLEAR_LOGS);
  }

  startSelfTest() {
    return this.client.request<{ started: boolean }>(Cmd.SELF_TEST);
  }

  getRuntimeStats() {
    return this.client.request<RuntimeStats>(Cmd.GET_RUNTIME_STATS);
  }

  enterMaintenance() {
    return this.client.request(Cmd.ENTER_MAINTENANCE);
  }

  exitMaintenance() {
    return this.client.request(Cmd.EXIT_MAINTENANCE);
  }

  reboot() {
    return this.client.request(Cmd.REBOOT);
  }

  factoryReset() {
    return this.client.request(Cmd.FACTORY_RESET, undefined, 6000);
  }

  fwQuery() {
    return this.client.request<FwQueryResponse>(Cmd.FW_QUERY);
  }

  fwBegin(req: FwBeginRequest) {
    return this.client.request<FwBeginResponse>(Cmd.FW_BEGIN, req, 8000);
  }

  fwChunk(sessionId: number, offset: number, data: Uint8Array) {
    const payload = new Uint8Array(8 + data.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, sessionId, true);
    view.setUint32(4, offset, true);
    payload.set(data, 8);
    return this.client.requestBinary<{ ok: boolean; received: number }>(Cmd.FW_CHUNK, payload, 8000);
  }

  fwEnd() {
    return this.client.request<FwEndResponse>(Cmd.FW_END, undefined, 15000);
  }

  fwAbort() {
    return this.client.request(Cmd.FW_ABORT);
  }

  fwStatus(target: TargetId) {
    return this.client.request<FwStatusResponse>(Cmd.FW_STATUS, { target });
  }

  // ---- media ----

  mediaList(req: MediaListRequest = {}) {
    return this.client.request<MediaListResponse>(Cmd.MEDIA_LIST, req, 6000);
  }

  mediaInfo(id: string) {
    return this.client.request<CaptureInfo>(Cmd.MEDIA_INFO, { id }, 10000);
  }

  mediaThumb(id: string) {
    return this.client.requestBytes(Cmd.MEDIA_THUMB, { id }, 8000);
  }

  mediaRead(id: string, file: string, offset: number, length: number) {
    return this.client.requestBytes(Cmd.MEDIA_READ, { id, file, offset, length }, 8000);
  }

  mediaDelete(id: string) {
    return this.client.request(Cmd.MEDIA_DELETE, { id });
  }

  mediaFavorite(id: string, favorite: boolean) {
    return this.client.request(Cmd.MEDIA_FAVORITE, { id, favorite });
  }

  // ---- network / roll / upload queue (04 §7) ----

  networkList() {
    return this.client.request<NetworkListResponse>(Cmd.NETWORK_LIST);
  }

  /**
   * The one command that carries a Wi-Fi passphrase, and the only place it is
   * allowed to exist outside the field it was typed into (05 §13). Omitting
   * `password` for a known SSID keeps the stored one.
   */
  networkSet(req: NetworkSetRequest) {
    return this.client.request<{ ok: boolean } & NetworkListResponse>(Cmd.NETWORK_SET, req, 8000);
  }

  networkDelete(ssid: string) {
    return this.client.request<{ ok: boolean } & NetworkListResponse>(Cmd.NETWORK_DELETE, { ssid });
  }

  networkStatus() {
    return this.client.request<NetworkStatus>(Cmd.NETWORK_STATUS);
  }

  rollStatus() {
    return this.client.request<RollView>(Cmd.ROLL_STATUS);
  }

  rollCreate(name: string) {
    return this.client.request<RollCreateResponse>(Cmd.ROLL_CREATE, { name }, 8000);
  }

  rollJoin(join: string | PublishedRollJoinRequest) {
    return this.client.request<RollView>(Cmd.ROLL_JOIN, typeof join === 'string' ? { slug: join } : join, 8000);
  }

  rollLeave() {
    return this.client.request<{ ok: boolean } & RollView>(Cmd.ROLL_LEAVE, undefined, 8000);
  }

  uploadQueueStatus() {
    return this.client.request<UploadQueueReport>(Cmd.UPLOAD_QUEUE_STATUS);
  }

  uploadQueueRetry() {
    return this.client.request<UploadQueueRetryResponse>(Cmd.UPLOAD_QUEUE_RETRY);
  }

  /**
   * Push one capture already on the card into the active Roll's upload queue
   * (02 §16). The camera decides when it actually goes out — this only says
   * that it should.
   */
  uploadEnqueue(captureId: string) {
    return this.client.request<UploadEnqueueResponse>(Cmd.UPLOAD_ENQUEUE, { captureId }, 8000);
  }
}
