// KINO Twin §10 option 2: the Twin-side half of BroadcastTransport
// (kdp/src/transport/BroadcastTransport.ts). One TwinDeviceServer answers
// probes and serves exactly one Studio tab at a time over a BroadcastChannel,
// piping raw KDP bytes straight to/from `sim.device` — the same MockKinoDevice
// every other transport in this repo drives. Nothing here parses a frame; the
// channel carries the same bytes a serial cable would (§10/§20), and Task 8's
// SimRecorder taps them through noteIn/noteOut exactly for this wiring.
import { TWIN_CHANNEL } from '@kino/kdp';
import type { TwinSimulator } from './TwinSimulator';
import type { SimRecorder } from './recorder';

// Mirrors BroadcastTransport's WireMsg shape. That type itself is
// deliberately not exported across the package boundary (kdp's index only
// exports TWIN_CHANNEL and the class), so it is redeclared locally — the
// same structural-duplication call this engine already makes for
// MockDeviceLike's shape and test-fixtures' CamFault values, rather than
// reaching into another package's private types.
type WireMsg =
  | { t: 'probe' }
  | { t: 'present' }
  | { t: 'connect'; client: string }
  | { t: 'accept'; client: string }
  | { t: 'busy'; client: string }
  | { t: 'data'; from: 'host' | 'device'; client: string; bytes: number[] }
  | { t: 'close'; client: string; reason?: string };

/** Matches MockTransport's hardcoded reboot-close reason — reboot parity (brief §). */
const REBOOT_REASON = 'KINO is rebooting';

function toBytes(nums: number[]): Uint8Array {
  return Uint8Array.from(nums);
}

function toNums(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

/**
 * Serves one TwinSimulator's device over a BroadcastChannel. `start()`/`stop()`
 * own the channel's lifetime; everything else reacts to messages from
 * whichever BroadcastTransport (if any) is currently attached.
 */
export class TwinDeviceServer {
  private readonly sim: TwinSimulator;
  private readonly channelName: string;
  private readonly recorder?: SimRecorder;
  private channel: BroadcastChannel | null = null;

  /**
   * Reserved the instant a `connect` is accepted-in-principle — before the
   * boot-delay wait and the actual `device.attach()` below — so a second
   * `connect` racing in during that wait still sees a client as active
   * instead of slipping past the busy check.
   */
  private activeClient: string | null = null;
  /** True only once `device.attach()` has actually run for `activeClient`. */
  private attached = false;
  private bootDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly clientListeners = new Set<(connected: boolean) => void>();

  constructor(sim: TwinSimulator, opts?: { channelName?: string; recorder?: SimRecorder }) {
    this.sim = sim;
    this.channelName = opts?.channelName ?? TWIN_CHANNEL;
    this.recorder = opts?.recorder;
  }

  start(): void {
    if (this.channel) return; // already running
    const channel = new BroadcastChannel(this.channelName);
    channel.addEventListener('message', this.handleMessage);
    this.channel = channel;
  }

  stop(): void {
    if (this.bootDelayTimer) {
      clearTimeout(this.bootDelayTimer);
      this.bootDelayTimer = null;
    }
    if (this.attached) this.sim.device.detach();
    this.activeClient = null;
    this.setConnected(false);
    if (this.channel) {
      this.channel.removeEventListener('message', this.handleMessage);
      this.channel.close();
      this.channel = null;
    }
  }

  /** Fires whenever a Studio tab attaches/detaches — drives the "Studio ● CONNECTED" header. */
  onClientChange(cb: (connected: boolean) => void): () => void {
    this.clientListeners.add(cb);
    return () => this.clientListeners.delete(cb);
  }

  private setConnected(v: boolean): void {
    if (this.attached === v) return;
    this.attached = v;
    for (const cb of this.clientListeners) cb(v);
  }

  private post(msg: WireMsg): void {
    this.channel?.postMessage(msg);
  }

  private readonly handleMessage = (ev: MessageEvent): void => {
    const msg = ev.data as WireMsg;
    if (!msg) return;
    // 'accept'/'busy'/'present' are Studio-bound replies this server itself
    // posts — nothing here reacts to them.
    if (msg.t === 'probe') {
      this.post({ t: 'present' });
    } else if (msg.t === 'connect') {
      this.handleConnect(msg.client);
    } else if (msg.t === 'data') {
      if (msg.from !== 'host' || msg.client !== this.activeClient) return;
      const bytes = toBytes(msg.bytes);
      this.recorder?.noteIn(bytes);
      this.sim.device.receive(bytes);
    } else if (msg.t === 'close') {
      if (msg.client !== this.activeClient) return;
      if (this.attached) this.sim.device.detach();
      this.activeClient = null;
      this.setConnected(false);
    }
  };

  private handleConnect(client: string): void {
    if (this.sim.bootStage() !== 'READY' || this.activeClient !== null) {
      this.post({ t: 'busy', client });
      return;
    }
    this.activeClient = client;

    const delay = this.sim.device.bootDelayMs();
    this.bootDelayTimer = setTimeout(() => {
      this.bootDelayTimer = null;
      if (this.activeClient !== client) return; // stop()/a raced close already cleared this

      // `accept` goes out before `attach()` runs: attach() can synchronously
      // push bytes through the sink (e.g. boot-spew), and posting accept
      // first guarantees BroadcastTransport's live listener is registered
      // before any such message is ever put on the channel.
      this.post({ t: 'accept', client });
      this.sim.device.attach(
        (bytes) => {
          this.recorder?.noteOut(bytes);
          this.post({ t: 'data', from: 'device', client, bytes: toNums(bytes) });
        },
        () => {
          // Device-initiated force-close (reboot) — MockKinoDevice has
          // already torn itself down (dropLink/reboot clear its own sink),
          // so this must not call detach() again, only clear our bookkeeping.
          if (this.activeClient !== client) return;
          this.activeClient = null;
          this.setConnected(false);
          this.post({ t: 'close', client, reason: REBOOT_REASON });
        },
      );
      this.setConnected(true);
    }, delay);
  }
}
