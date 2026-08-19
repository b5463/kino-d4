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
