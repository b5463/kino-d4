import { create } from 'zustand';
import type { PageId } from '../components/Sidebar';

/**
 * Cross-section links.
 *
 * Studio has no router: App owns which section is open, and a section owns
 * its own tabs. That is fine until one section prints a number another section
 * measured — Overview's sync verdict comes from the Skew Bench — because then
 * the readout has to be able to open the page that produced it, and neither
 * side can reach the other's state.
 *
 * This is the one channel between them. App consumes `page`; the target page
 * consumes `tab`. `nonce` makes a repeat request to the section you are
 * already looking at still count as a request.
 */
export interface NavRequest {
  page: PageId;
  /** Tab inside that page, if it has any. Interpreted by the page itself. */
  tab?: string;
  nonce: number;
}

export const useNavRequest = create<{ request: NavRequest | null }>(() => ({ request: null }));

let nonce = 0;

export function openSection(page: PageId, tab?: string): void {
  nonce += 1;
  useNavRequest.setState({ request: { page, tab, nonce } });
}

/**
 * A request is spent once the target page has acted on it.
 *
 * Without this it never was: one click of Overview's OPEN SKEW BENCH left the
 * request standing, and every later visit to Calibration for the rest of the
 * session force-landed on the Skew Bench tab, ignoring the tab the user had
 * actually chosen. Clearing is nonce-matched so a stale handler cannot swallow
 * a newer request that arrived in between.
 */
export function clearNavRequest(handled: number): void {
  useNavRequest.setState((s) => (s.request?.nonce === handled ? { request: null } : s));
}
