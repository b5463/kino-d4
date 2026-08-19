export interface CaptureDetailPageProps {
  slug: string;
  captureId: string;
}

/**
 * Placeholder for one capture's detail view (Task 29: WigglePlayer, download
 * control, reactions once the API grows an endpoint for them). This task only
 * proves `/r/:slug/c/:captureId` resolves.
 */
export function CaptureDetailPage({ slug, captureId }: CaptureDetailPageProps) {
  return (
    <main>
      <h1>Capture {captureId}</h1>
      <p>
        On Roll {slug}. The capture detail view is not built yet (Task 29).
      </p>
    </main>
  );
}
