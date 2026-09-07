import type { ReactNode } from 'react';
import kinoRoll from '../assets/kino-roll-light.png';

export interface NotFoundPageProps {
  pathname: string;
}

/**
 * The three dead ends a guest can reach, and the one thing they have in
 * common: they used to be bare black pages with two lines of text on them and
 * no mark, no way on. A guest who scanned a card and landed here could not
 * tell whether they were in the right app. Each one now carries the wordmark,
 * says what happened in one line, and offers the one move that makes sense.
 */
function Dead({ title, line, children }: { title: string; line: string; children?: ReactNode }) {
  return (
    <main className="k-gate">
      <img className="k-mark" src={kinoRoll} alt="KINO Roll" />
      <h1>{title}</h1>
      <p className="k-gate-lede">{line}</p>
      {children}
    </main>
  );
}

/** Anything outside `/`, `/r/:slug`, `/r/:slug/display`, `/r/:slug/c/:captureId` and `/host`. */
export function NotFoundPage({ pathname }: NotFoundPageProps) {
  return (
    <Dead title="Not found" line={`No page at ${pathname}.`}>
      <a className="k-gate-act" href="/">Open a roll</a>
    </Dead>
  );
}

/** A valid Roll route whose secret slug is no longer available. */
export function NoRollPage() {
  return (
    <Dead title="No roll here" line="This link may be old, or the roll may have been removed.">
      <a className="k-gate-act" href="/">Enter a roll code</a>
    </Dead>
  );
}

/**
 * One capture is gone, but the roll it belonged to is not.
 *
 * These were the same page, so a guest opening a link to a photograph the
 * host had hidden was told the whole roll was missing and given no way back
 * into it. The host removed one picture; that is what the page should say,
 * and the roll is one tap away.
 */
export function NoCapturePage({ slug }: { slug: string }) {
  return (
    <Dead
      title="This photograph is gone"
      line="The host removed it. The rest of the roll is still here."
    >
      <a className="k-gate-act" href={`/r/${encodeURIComponent(slug)}`}>
        Back to the roll
      </a>
    </Dead>
  );
}
