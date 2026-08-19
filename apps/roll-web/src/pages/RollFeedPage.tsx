export interface RollFeedPageProps {
  slug: string;
}

/**
 * Placeholder for the guest gallery (Task 28: virtualized feed + live
 * updates via `rollApi.events`). This task only proves `/r/:slug` resolves
 * and names what belongs here — no feed, no fetch, no fake data.
 */
export function RollFeedPage({ slug }: RollFeedPageProps) {
  return (
    <main>
      <h1>Roll: {slug}</h1>
      <p>The guest gallery for this Roll is not built yet (Task 28).</p>
    </main>
  );
}
