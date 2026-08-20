import { z } from 'zod';
import type { HardwareProfile } from './types';

/** §8 wiring categories. BUTTONS covers shutter/fn signal lines. */
export const NET_CLASSES = ['POWER', 'UART', 'SYNC', 'FLASH', 'BUTTONS'] as const;
export type NetClass = (typeof NET_CLASSES)[number];

const netEndpoint = z.object({ instance: z.string(), pin: z.string() });

/**
 * One physical wire run between two instances (§8). `waypointsMm` are
 * provisional scene-space routing points for visualization, not CAD — 3-5
 * points is enough to suggest a path around the battery/carrier stack.
 */
export const netDef = z.object({
  id: z.string(),
  cls: z.enum(NET_CLASSES),
  from: netEndpoint,
  to: netEndpoint,
  gauge: z.enum(['20AWG', '24AWG', '28AWG', 'ribbon']),
  color: z.enum(['red', 'black', 'yellow', 'blue', 'green', 'grey']),
  waypointsMm: z.array(z.tuple([z.number(), z.number(), z.number()])).min(3).max(5),
});
export type NetDef = z.infer<typeof netDef>;

export function netsFor(profile: HardwareProfile, instanceId: string): NetDef[] {
  return profile.nets.filter((n) => n.from.instance === instanceId || n.to.instance === instanceId);
}

export function netsByClass(profile: HardwareProfile, cls: NetClass): NetDef[] {
  return profile.nets.filter((n) => n.cls === cls);
}
