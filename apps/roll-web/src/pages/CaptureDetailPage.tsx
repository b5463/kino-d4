export interface CaptureDetailPageProps {
  slug: string;
  captureId: string;
}

export function CaptureDetailPage({ slug, captureId }: CaptureDetailPageProps) {
  const [capture, setCapture] = useState<CaptureDetailView | null>(null);
  const [roll, setRoll] = useState<RollView | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    setCapture(null);
    setRoll(null);
    setError(null);

    void Promise.all([rollApi.getRoll(slug), rollApi.getCapture(slug, captureId)])
      .then(([nextRoll, nextCapture]) => {
        if (!active) return;
        setRoll(nextRoll);
        setCapture(nextCapture);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught : new Error(String(caught)));
      });

    return () => {
      active = false;
    };
  }, [captureId, slug]);

  return (
    <main style={{ padding: '1rem' }}>
      <p>
        <a href={`/r/${encodeURIComponent(slug)}`}>← Back to {roll?.title ?? 'Roll'}</a>
      </p>
      {error !== null ? <p role="alert">{error.message}</p> : null}
      {capture === null || roll === null ? (error === null ? <p>Loading capture…</p> : null) : null}
      {capture !== null && roll !== null ? (
        <CaptureDetail slug={slug} capture={capture} roll={roll} />
      ) : null}
    </main>
  );
}
import { useEffect, useState } from 'react';
import { rollApi, type CaptureDetail as CaptureDetailView, type RollView } from '../api/client';
import { CaptureDetail } from './CaptureDetail';
