// What matching the lenses says when it does not work, and what a check of
// KINO says afterwards. Pure.

import type { SelfTestCheck } from '@kino/kdp';
import { LENS_POSITIONS } from '../physical/fieldBody';

export type MatchFailure = { kind: 'lens'; sentence: string } | { kind: 'light'; sentence: string };

/** A camera number in an engineering message, as a position. */
function positionIn(message: string): string | null {
  const m = /cam\s?([1-4])/i.exec(message);
  return m ? (LENS_POSITIONS[Number(m[1]) - 1] ?? 'left').toLowerCase() : null;
}

/** The failure sentence for a calibration error, in the customer's words. */
export function matchFailure(message: string): MatchFailure {
  if (/offline|not answering|unreachable|sensor|not detected|no lens/i.test(message)) {
    const pos = positionIn(message);
    return {
      kind: 'lens',
      sentence: pos ? `The ${pos} lens isn't answering, so the lenses can't be matched yet.` : "A lens isn't answering, so the lenses can't be matched yet.",
    };
  }
  return { kind: 'light', sentence: "The light wasn't even. Try a different wall." };
}

/**
 * "Nothing to fix." or plain sentences for the checks that did not pass.
 * The check names are the firmware's; the sentences are not.
 */
export function checkSentences(results: SelfTestCheck[]): string[] {
  const failed = results.filter((r) => r.status === 'fail');
  const out: string[] = [];
  for (const r of failed) {
    const pos = positionIn(r.name);
    if (pos) out.push(`The ${pos} lens didn't pass its check. KINO may shoot with three.`);
    else if (/sd|card|storage/i.test(r.name)) out.push("The card didn't pass its check. Try another card.");
    else out.push("Something inside KINO didn't pass its check. Restart KINO; if it stays, get help.");
  }
  return [...new Set(out)];
}
