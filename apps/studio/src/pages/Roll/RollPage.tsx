import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/Button';
import { Unsupported } from '../../components/Unsupported';
import { getDevice, isDemo } from '../../app/session';
import { supportsRollUpload, useDeviceStore } from '../../state/deviceStore';
import { putRollLinks, rollLinksFor, useRollLinks } from '../../state/rollLinks';
import {
  DEFAULT_ROLL_SERVER_URL,
  StubRollServerClient,
  getRollServerClient,
  setRollServerUrl,
} from '../../roll/RollServerClient';
import { startRoll, submitNetwork } from '../../roll/rollOps';
import type { StartRollOptions } from '../../roll/rollOps';
import type { NetworkSetRequest, NetworkStatus, NetworkView, RollView, UploadQueueReport } from '../../roll/rollTypes';
import { ServerPanel } from './ServerPanel';
import type { ServerTestResult } from './ServerPanel';
import { NetworkPanel } from './NetworkPanel';
import { RollPanel } from './RollPanel';
import { UploadQueuePanel } from './UploadQueuePanel';

/** Same cadence the session poller uses for device-owned state. */
const POLL_MS = 4000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Roll page (02 §17).
 *
 * Everything here except the ROLL SERVER panel is device-side KDP. The camera
 * keeps its own Wi-Fi credentials, its own roll membership and its own upload
 * queue; Studio only reads them back and writes what the user typed.
 */
export function RollPage() {
  const state = useDeviceStore();
  const supported = supportsRollUpload(state);

  const [networks, setNetworks] = useState<NetworkView[]>([]);
  const [netStatus, setNetStatus] = useState<NetworkStatus | null>(null);
  const [rollView, setRollView] = useState<RollView | null>(null);
  const [queue, setQueue] = useState<UploadQueueReport | null>(null);

  const [serverUrl, setServerUrl] = useState(getRollServerClient().baseUrl || DEFAULT_ROLL_SERVER_URL);
  const [serverResult, setServerResult] = useState<ServerTestResult | null>(null);

  const [netBusy, setNetBusy] = useState(false);
  const [rollBusy, setRollBusy] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);

  const [netError, setNetError] = useState<string | null>(null);
  const [rollError, setRollError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  /** A failed read of the whole page, which is a link problem, not a form one. */
  const [loadError, setLoadError] = useState<string | null>(null);

  // Public URLs live in a store that outlives this component: the camera never
  // reports a host dashboard, so page state lost it on the first page swap and
  // the panel then denied a Roll that was published fine.
  const linkMap = useRollLinks((s) => s.byRollId);

  const refresh = useCallback(async () => {
    const dev = getDevice();
    if (!dev) return;
    try {
      const [list, status, view, q] = await Promise.all([
        dev.networkList(),
        dev.networkStatus(),
        dev.rollStatus(),
        dev.uploadQueueStatus(),
      ]);
      setNetworks(list.networks);
      setNetStatus(status);
      setRollView(view);
      setQueue(q);
      setLoadError(null);
    } catch (err) {
      setLoadError(message(err));
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    void refresh();
    // The mock's backlog drains on a timer and a real camera uploads in the
    // background, so the counters have to be re-read, not remembered.
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [supported, refresh]);

  if (!supported) {
    return (
      <>
        <div className="pagehead">
          <h1>
            <Icon name="roll" />
            Roll
          </h1>
        </div>
        <Unsupported
          feature="Roll upload"
          firmware={state.firmwareLabel}
          note="Photos stay on the SD card. Update the firmware to publish a Roll."
        />
      </>
    );
  }

  const withDevice = async (
    setBusy: (b: boolean) => void,
    setError: (e: string | null) => void,
    work: (dev: NonNullable<ReturnType<typeof getDevice>>) => Promise<void>,
  ) => {
    const dev = getDevice();
    if (!dev) {
      setError('KINO is not connected.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await work(dev);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const saveNetwork = (req: NetworkSetRequest) =>
    withDevice(setNetBusy, setNetError, async (dev) => {
      setNetworks(await submitNetwork(dev, req));
    });

  const forgetNetwork = (ssid: string) =>
    withDevice(setNetBusy, setNetError, async (dev) => {
      setNetworks((await dev.networkDelete(ssid)).networks);
    });

  const server = getRollServerClient();

  const testServer = async () => {
    setServerBusy(true);
    setRollServerUrl(serverUrl);
    try {
      setServerResult(await getRollServerClient().testConnection());
    } catch (err) {
      setServerResult({ ok: false, error: message(err) });
    } finally {
      setServerBusy(false);
    }
  };

  /**
   * With no Roll server configured, "Start a Roll" fails loudly — which is
   * correct: there is nowhere to publish to. Against the simulator there is no
   * server to configure either, and the reference device mints its own guest
   * URL, so demo mode is allowed to create the Roll on the camera alone and
   * show the whole QR flow. The seam is untouched: one flag, decided here.
   */
  const allowDeviceOnly = isDemo() && server instanceof StubRollServerClient;

  const links = rollLinksFor(rollView, linkMap);

  const start = (opts: StartRollOptions) =>
    withDevice(setRollBusy, setRollError, async (dev) => {
      const started = await startRoll(dev, server, opts, { allowDeviceOnly });
      putRollLinks(started.deviceRollId, {
        guestUrl: started.guestUrl,
        hostUrl: started.hostUrl,
        origin: started.deviceOnly ? 'device-only' : 'server',
      });
    });

  // A joined Roll was created by someone else, so this session knows no host
  // dashboard for it — and does not pretend one cannot exist.
  const join = (slug: string) =>
    withDevice(setRollBusy, setRollError, async (dev) => {
      setRollView(await dev.rollJoin(slug));
    });

  const leave = () =>
    withDevice(setRollBusy, setRollError, async (dev) => {
      await dev.rollLeave();
    });

  const retryUploads = () =>
    withDevice(setQueueBusy, setQueueError, async (dev) => {
      setQueue((await dev.uploadQueueRetry()).queue);
    });

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="roll" />
          Roll
        </h1>
        <div className="pagehead-actions">
          <Button size="sm" onClick={() => void refresh()}>
            REFRESH
          </Button>
        </div>
      </div>

      {loadError ? <p className="notice notice--err">Could not read Roll state from KINO: {loadError}</p> : null}

      <ServerPanel
        url={serverUrl}
        busy={serverBusy}
        result={serverResult}
        onUrlChange={setServerUrl}
        onTest={testServer}
      />

      <NetworkPanel
        networks={networks}
        status={netStatus}
        busy={netBusy}
        error={netError}
        onSave={saveNetwork}
        onForget={forgetNetwork}
      />

      <RollPanel
        view={rollView}
        guestUrl={links.guestUrl}
        hostUrl={links.hostUrl}
        origin={links.origin}
        busy={rollBusy}
        error={rollError}
        onStart={start}
        onJoin={join}
        onLeave={leave}
      />

      <UploadQueuePanel queue={queue} busy={queueBusy} error={queueError} onRetry={retryUploads} />

      <p className="roll-offline">
        KINO shoots without Wi-Fi. Uploads resume when the Roll server is reachable.
      </p>
    </>
  );
}
