import { create } from 'zustand';
import type { RollView } from '../roll/rollTypes';

/**
 * Public URLs for Rolls this Studio session created.
 *
 * The camera knows it is on a Roll and knows its own guest URL, but it does not
 * carry the host dashboard address — that only ever exists in the reply from
 * the Roll server. Held in page state it died on the next sidebar click, and
 * the panel then told the user "this Roll exists on the camera only" about a
 * Roll that was published perfectly well. Same failure mode `benchResults`
 * fixes for measurements, and the same fix: outlive the component.
 *
 * Keyed by the id the *camera* reports in ROLL_STATUS, because that is the only
 * id both sides of the join have. The Roll server mints its own id, and
 * ROLL_CREATE takes nothing but a name, so the two never meet on the wire.
 */

/** Where this session's knowledge of a Roll's public links comes from. */
export type RollLinkOrigin =
  /** A Roll server published it; the host dashboard is real. */
  | 'server'
  /** Created on the camera alone (demo); there is no host dashboard at all. */
  | 'device-only'
  /** The camera is on a Roll this session did not create. Nothing is claimed. */
  | 'unknown';

export interface RollLinks {
  guestUrl: string;
  hostUrl: string | null;
  origin: Exclude<RollLinkOrigin, 'unknown'>;
}

/**
 * One Roll this machine started, kept so the operator has a second copy of the
 * host link.
 *
 * The Roll server mints the host token once, hands it back in the create reply
 * and never again — no rotate route, no re-issue route. The dashboard strips it
 * from the URL on arrival, so a host who closes that tab has nothing. This list
 * is the only other place it exists, and it is on the machine that ran the
 * party, which is where the operator will look.
 */
export interface CreatedRoll {
  deviceRollId: string;
  title: string;
  slug: string;
  guestUrl: string;
  hostUrl: string | null;
  createdAt: string;
}

interface RollLinkState {
  byRollId: Record<string, RollLinks>;
  created: CreatedRoll[];
}

const STORAGE_KEY = 'kino.studio.createdRolls';
/** Enough for a season of parties, short enough that nothing has to prune it. */
const MAX_CREATED = 25;

function loadCreated(): CreatedRoll[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CreatedRoll[]) : [];
  } catch {
    // No storage, or somebody else's JSON under the key. Not worth a crash.
    return [];
  }
}

function saveCreated(rolls: CreatedRoll[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rolls));
  } catch {
    // A private window keeps the list for the session and no longer.
  }
}

export const useRollLinks = create<RollLinkState>(() => ({
  byRollId: {},
  created: typeof window === 'undefined' ? [] : loadCreated(),
}));

/** Record what a create returned, under the id ROLL_STATUS will report. */
export function putRollLinks(deviceRollId: string, links: RollLinks): void {
  useRollLinks.setState((s) => ({ byRollId: { ...s.byRollId, [deviceRollId]: links } }));
}

/** Remember a Roll this machine started, host link and all, past this session. */
export function rememberCreatedRoll(roll: CreatedRoll): void {
  useRollLinks.setState((s) => {
    const created = [roll, ...s.created.filter((r) => r.deviceRollId !== roll.deviceRollId)].slice(
      0,
      MAX_CREATED,
    );
    saveCreated(created);
    return { created };
  });
}

export function forgetCreatedRoll(deviceRollId: string): void {
  useRollLinks.setState((s) => {
    const created = s.created.filter((r) => r.deviceRollId !== deviceRollId);
    saveCreated(created);
    return { created };
  });
}

export function clearCreatedRolls(): void {
  saveCreated([]);
  useRollLinks.setState({ created: [] });
}

export function getRollLinks(deviceRollId: string): RollLinks | null {
  return useRollLinks.getState().byRollId[deviceRollId] ?? null;
}

/**
 * A new camera or a new session knows nothing about earlier Rolls.
 *
 * The created-Roll list is deliberately NOT cleared here: it outlives cameras
 * and sessions on purpose, because it is the operator's only spare copy of a
 * host link. `clearCreatedRolls` is the explicit way to drop it.
 */
export function resetRollLinks(): void {
  useRollLinks.setState({ byRollId: {} });
}

export interface RollLinkView {
  guestUrl: string | null;
  hostUrl: string | null;
  origin: RollLinkOrigin;
}

const NO_ROLL: RollLinkView = { guestUrl: null, hostUrl: null, origin: 'unknown' };

/**
 * What the Roll panel should show for the Roll the camera reports.
 *
 * An active Roll this session did not create still gets its guest QR — the
 * camera's own guest URL is real and scannable — but nothing is claimed about a
 * host dashboard either way, because this Studio has no way to know.
 */
export function rollLinksFor(
  view: RollView | null,
  byRollId: Record<string, RollLinks> = useRollLinks.getState().byRollId,
): RollLinkView {
  const roll = view?.active === true ? view.roll : null;
  if (!roll) return NO_ROLL;
  const known = byRollId[roll.rollId];
  if (known) return { guestUrl: known.guestUrl, hostUrl: known.hostUrl, origin: known.origin };
  return { guestUrl: roll.guestUrl, hostUrl: null, origin: 'unknown' };
}
