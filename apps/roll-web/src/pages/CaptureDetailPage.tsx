import { useEffect, useState } from 'react';
import {
  isMissingCaptureError,
  isNoRollError,
  PinRequiredError,
  rollApi,
  type CaptureDetail as CaptureDetailView,
  type RollView,
} from '../api/client';
import { CaptureDetail } from './CaptureDetail';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';
import { useRollEvents } from '../hooks/useRollEvents';
import { NoRollPage } from './NotFoundPage';
import { PinGate } from './PinGate';
import { StatusLamp } from '@kino/design-system';

export interface CaptureDetailPageProps {
  slug: string;
  captureId: string;
}

export function CaptureDetailPage({ slug, captureId }: CaptureDetailPageProps) {
  const [capture, setCapture] = useState<CaptureDetailView | null>(null);
  const [roll, setRoll] = useState<RollView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

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
  }, [attempt, captureId, slug]);

  // Without this the SAVE actions' "Rendering…" would never resolve: a lazy
  // render finishing announces itself as `processing.completed`, and the event
  // hook's replace path re-fetches the capture — which is a full detail, since
  // `rollApi.getCapture` is what fetched it.
  useRollEvents(
    slug,
    {
      replace: (next) => {
        if (next.captureId === captureId) setCapture(next as CaptureDetailView);
      },
    },
    rollApi,
    roll !== null && error === null,
  );

  if (error instanceof PinRequiredError) {
    return <PinGate slug={slug} onUnlocked={() => setAttempt((current) => current + 1)} />;
  }

  if (isNoRollError(error) || isMissingCaptureError(error)) return <NoRollPage />;

  return (
    <>
      <SiteHeader
        right={
          roll === null ? null : (
            <StatusLamp state={roll.status === 'live' ? 'ok' : 'off'} label={roll.status.toUpperCase()} />
          )
        }
      />
      <main className="site-width">
        <p className="back-link">
          <a href={`/r/${encodeURIComponent(slug)}`}>← {roll?.title ?? 'Roll'}</a>
        </p>
        {error !== null ? <p className="roll-alert" role="alert">{error.message}</p> : null}
        {capture === null || roll === null ? (error === null ? <p>Loading capture…</p> : null) : null}
        {capture !== null && roll !== null ? (
          <CaptureDetail slug={slug} capture={capture} roll={roll} />
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
