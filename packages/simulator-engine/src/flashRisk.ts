// Moved to @kino/kdp (protocol/flash.ts) so Studio's flash-timing bench and
// the Twin share one implementation (audit #56). Re-exported here so existing
// engine consumers keep their import path.
export { flashBandRisk } from '@kino/kdp';
export type { FlashRisk } from '@kino/kdp';
