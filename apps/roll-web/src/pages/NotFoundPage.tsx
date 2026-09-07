export interface NotFoundPageProps {
  pathname: string;
}

/** Anything outside `/`, `/r/:slug`, `/r/:slug/display`, `/r/:slug/c/:captureId` and `/host`. */
export function NotFoundPage({ pathname }: NotFoundPageProps) {
  return (
    <main className="k-gate">
      <h1>Not found</h1>
      <p>No route matches {pathname}.</p>
    </main>
  );
}

/** A valid Roll route whose secret slug is no longer available. */
export function NoRollPage() {
  return (
    <main className="k-gate">
      <h1>No roll here</h1>
      <p>This link may be old, or the roll may have been removed.</p>
    </main>
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
    <main className="k-gate">
      <h1>This photo is no longer in the roll.</h1>
      <p>The host removed it. The rest of the roll is still here.</p>
      <p>
        <a className="k-landing-back" href={`/r/${encodeURIComponent(slug)}`}>
          Back to the roll
        </a>
      </p>
    </main>
  );
}
