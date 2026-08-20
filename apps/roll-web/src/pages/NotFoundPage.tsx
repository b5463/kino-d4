export interface NotFoundPageProps {
  pathname: string;
}

/** Anything outside `/r/:slug`, `/r/:slug/c/:captureId` and `/host`. */
export function NotFoundPage({ pathname }: NotFoundPageProps) {
  return (
    <main>
      <h1>Not found</h1>
      <p>No route matches {pathname}.</p>
    </main>
  );
}

/** A valid Roll route whose secret slug or capture is no longer available. */
export function NoRollPage() {
  return (
    <main style={{ maxWidth: 480, margin: '15vh auto', padding: '1rem' }}>
      <h1>No Roll here.</h1>
      <p>This link may be old, or the Roll may have been removed.</p>
    </main>
  );
}
