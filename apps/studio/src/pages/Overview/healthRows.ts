// The Overview health lamps, as pure functions over device-reported state.
//
// They live outside the page for the reason skewReport.ts does: the rule they
// encode is not "what does this look like" but "what may this claim", and that
// has to be assertable without a DOM. Every row here obeys one rule — the
// firmware not having the feature, the firmware not answering, and the
// firmware answering are THREE states, and none of them may be printed as
// another (audit #61).

import type { CameraInfo, Capabilities, PowerStatus, StorageStatus } from '@kino/kdp';
import type { LedState } from '../../components/Led';
import type { NetworkStatus, RollView } from '../../roll/rollTypes';
import { formatMB } from '../../utils/format';

export interface HealthRow {
  name: string;
  state: LedState;
  label: string;
}

export function camLed(cam: CameraInfo): { state: LedState; label: string } {
  if (!cam.online) return { state: 'err', label: cam.state === 'rebooting' ? 'REBOOTING' : 'OFFLINE' };
  switch (cam.state) {
    case 'ready':
      return { state: 'ok', label: 'READY' };
    // Primed and waiting for the trigger edge. Its own lamp, not a shade of
    // READY: a camera still armed when the burst is over missed the trigger.
    case 'armed':
      return { state: 'busy', label: 'ARMED' };
    case 'timeout':
      return { state: 'warn', label: 'TIMEOUT' };
    case 'updating':
      return { state: 'busy', label: 'UPDATING' };
    case 'error':
      return { state: 'err', label: 'ERROR' };
    default:
      return { state: 'busy', label: cam.state.toUpperCase() };
  }
}

export interface SupplyInput {
  storage: StorageStatus | null;
  power: PowerStatus | null;
  capabilities: Capabilities | null;
  network: NetworkStatus | null;
  roll: RollView | null;
  /** `supports(state, 'network')` — the fail-closed gate, resolved by the caller. */
  hasNetwork: boolean;
  hasRoll: boolean;
}

/**
 * Per-camera state belongs to the camera strip, and the link lamp belongs to
 * the status bar — this list is only what neither of them says.
 */
export function supplyRows(input: SupplyInput): HealthRow[] {
  const { storage, power, capabilities, network, roll, hasNetwork, hasRoll } = input;
  return [
    storage?.present
      ? {
          name: 'SD CARD',
          state: 'ok',
          label: `${formatMB(storage.freeMB)} FREE OF ${formatMB(storage.totalMB)}`,
        }
      : { name: 'SD CARD', state: 'err', label: 'NO CARD' },
    power
      ? {
          name: 'BATTERY',
          state: power.batteryPct <= 15 && !power.charging ? 'warn' : 'ok',
          label: `${power.batteryPct}% · ${power.batteryV.toFixed(2)} V${
            power.charging ? ' · CHARGING' : power.state === 'usb' ? ' · USB POWER' : ''
          }`,
        }
      : { name: 'BATTERY', state: 'off', label: '—' },
    // Device-reported only: firmware without a rail ADC omits busV and this
    // row says so instead of inventing 5.00 (audit #61).
    power && typeof power.busV === 'number'
      ? {
          name: '5V RAIL',
          state: power.busV < 4.6 ? 'err' : power.busV < 4.9 ? 'warn' : 'ok',
          label: `${power.busV.toFixed(2)} V${power.fuse === 'blown' ? ' · FUSE BLOWN' : ''}`,
        }
      : { name: '5V RAIL', state: 'off', label: 'NOT REPORTED' },
    // Device-reported only: the capability says whether this firmware exposes
    // flash control. Nothing here measures the flash itself — RUN SELF TEST
    // does that — so this lamp never claims READY on its own.
    capabilities
      ? capabilities.flashControl
        ? { name: 'FLASH', state: 'ok', label: 'CONTROL AVAILABLE' }
        : { name: 'FLASH', state: 'off', label: 'NOT AVAILABLE' }
      : { name: 'FLASH', state: 'off', label: '—' },
    // A row that printed DISCONNECTED for all three states made a NACK look
    // like a dropped access point.
    !hasNetwork
      ? { name: 'WIFI', state: 'off', label: 'NOT AVAILABLE' }
      : !network
        ? { name: 'WIFI', state: 'off', label: 'NOT REPORTED' }
        : network.state === 'connected'
          ? {
              name: 'WIFI',
              state: 'ok',
              label: `${network.ssid ?? '—'} · CONNECTED${network.internet ? '' : ' · NO INTERNET'}`,
            }
          : {
              name: 'WIFI',
              state: network.state === 'connecting' ? 'busy' : 'off',
              label: network.state === 'connecting' ? `${network.ssid ?? '—'} · CONNECTING` : 'DISCONNECTED',
            },
    // NO ROLL is an answer — the camera is on no Roll. Not the same as a
    // firmware without the Roll service, and neither is the same as silence.
    !hasRoll
      ? { name: 'ROLL', state: 'off', label: 'NOT AVAILABLE' }
      : !roll
        ? { name: 'ROLL', state: 'off', label: 'NOT REPORTED' }
        : roll.active && roll.roll
          ? { name: 'ROLL', state: 'ok', label: `${roll.roll.name.toUpperCase()} · ${roll.roll.slug}` }
          : { name: 'ROLL', state: 'off', label: 'NO ROLL' },
  ];
}
