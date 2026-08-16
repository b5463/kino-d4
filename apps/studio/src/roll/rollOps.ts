// Roll page operations that are more than a single command.
//
// Kept out of the components so the sequencing is testable on its own: the
// order of "server first, then the device" is the whole point of `startRoll`,
// and `submitNetwork` is the exact path a typed passphrase takes to the camera
// and nowhere else.

import type { KinoDevice } from '../device/KinoDevice';
import { isServerNotConfigured } from './RollServerClient';
import type { RollServerClient } from './RollServerClient';
import type { NetworkSetRequest, NetworkView } from './rollTypes';

/**
 * Save a Wi-Fi network on the camera.
 *
 * The passphrase goes into `NETWORK_SET` and is not returned, logged or
 * stored anywhere by this function (05 §13). What comes back is the device's
 * own list, in which every password is already the mask.
 */
export async function submitNetwork(device: KinoDevice, form: NetworkSetRequest): Promise<NetworkView[]> {
  const req: NetworkSetRequest = {
    ssid: form.ssid.trim(),
    security: form.security ?? 'wpa2',
    autoJoin: form.autoJoin ?? true,
  };
  // An empty box on a known SSID means "leave the stored passphrase alone",
  // so the field is only sent when something was actually typed.
  if (form.password) req.password = form.password;
  const res = await device.networkSet(req);
  return res.networks;
}

export interface StartRollOptions {
  title: string;
  pin?: string;
  downloadsEnabled: boolean;
}

export interface StartedRoll {
  /** Id on the Roll server, or the camera's own when nothing published it. */
  rollId: string;
  /**
   * The id the camera reports in ROLL_STATUS. Session-level knowledge about
   * this Roll has to be filed under this one — it is the only id both sides
   * share, since ROLL_CREATE carries nothing but a name.
   */
  deviceRollId: string;
  slug: string;
  guestUrl: string;
  /** Null when the roll only exists on the camera (demo/device-only path). */
  hostUrl: string | null;
  /** True when no Roll server published this Roll. */
  deviceOnly: boolean;
}

/**
 * Start a Roll: server first, device second.
 *
 * The camera must never end up hosting a roll that does not exist on the
 * server — a guest scanning the QR would land nowhere and the queued uploads
 * would have no destination. So a server failure aborts before `ROLL_CREATE`
 * is ever sent.
 *
 * `allowDeviceOnly` is the demo escape hatch: with the stub client and the
 * simulator attached there is no server to fail against, and the reference
 * device mints a usable `guestUrl` of its own, so the full QR flow can be
 * shown. There is no host dashboard on that path, and the page says so.
 */
export async function startRoll(
  device: KinoDevice,
  server: RollServerClient,
  opts: StartRollOptions,
  { allowDeviceOnly = false }: { allowDeviceOnly?: boolean } = {},
): Promise<StartedRoll> {
  let published: { rollId: string; slug: string; guestUrl: string; hostUrl: string } | null = null;
  try {
    published = await server.createRoll({
      title: opts.title,
      pin: opts.pin,
      downloadsEnabled: opts.downloadsEnabled,
    });
  } catch (err) {
    if (!(allowDeviceOnly && isServerNotConfigured(err))) throw err;
  }

  const created = await device.rollCreate(opts.title);

  return published
    ? {
        rollId: published.rollId,
        deviceRollId: created.rollId,
        slug: published.slug,
        guestUrl: published.guestUrl,
        hostUrl: published.hostUrl,
        deviceOnly: false,
      }
    : {
        rollId: created.rollId,
        deviceRollId: created.rollId,
        slug: created.slug,
        guestUrl: created.guestUrl,
        hostUrl: null,
        deviceOnly: true,
      };
}
