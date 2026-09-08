import { useCallback, useEffect, useState } from 'react';
import {
  apiFailureMessage,
  isMissingCaptureError,
  isNoRollError,
  PinRequiredError,
  rollApi,
  type CaptureDetail as CaptureDetailView,
  type RollView,
} from '../api/client';
import { evictCaptureAssets } from '../cache/assets';
import { CaptureDetail, clockOf, heroStill } from './CaptureDetail';
import { LoadFailure } from '../components/LoadFailure';
import { OfflineBanner } from '../components/OfflineBanner';
import { rollLabel } from '../components/SiteHeader';
import { useRollEvents } from '../hooks/useRollEvents';
import { useOnline } from '../hooks/useOnline';
import { absoluteUrl, setRouteMeta } from '../meta';
import { NoCapturePage, NoRollPage } from './NotFoundPage';
import { PinGate } from './PinGate';

export interface CaptureDetailPageProps {
  slug: string;
  captureId: string;
}

export function CaptureDetailPage({ slug, captureId }: CaptureDetailPageProps) {
  const [capture, setCapture] = useState<CaptureDetailView | null>(null);
  const [roll, setRoll] = useState<RollView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The host removed this photograph, or cleared the roll, while it was open. */
  const [gone, setGone] = useState(false);
  const online = useOnline();

  // What a pasted link to this photograph previews as. The image is the
  // capture's still — the picture, not the roll's cover.
  useEffect(() => {
    if (roll === null || capture === null) return;
    const still = heroStill(capture);
    setRouteMeta({
      title: `${rollLabel(roll.title, slug)} · ${clockOf(capture.capturedAt)} — KINO Roll`,
      description: `One capture from a KINO D4, ${capture.frameCount === 1 ? 'single frame' : `${String(capture.frameCount)} frames`}.`,
      image: still === undefined ? undefined : absoluteUrl(rollApi.assetUrl(still.assetId)),
    });
  }, [capture, roll, slug]);

  useEffect(() => {
    // Cancelled on the way out, not merely ignored: going straight back to the
    // feed used to leave a roll read and a full capture read running against
    // the same uplink the tiles are coming down.
    const controller = new AbortController();
    setCapture(null);
    setRoll(null);
    setError(null);
    setGone(false);

    void Promise.all([
      rollApi.getRoll(slug, { signal: controller.signal }),
      rollApi.getCapture(slug, captureId, { signal: controller.signal }),
    ])
      .then(([nextRoll, nextCapture]) => {
        if (controller.signal.aborted) return;
        setRoll(nextRoll);
        setCapture(nextCapture);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      });

    return () => controller.abort();
  }, [attempt, captureId, slug]);

  // Without this the SAVE actions' "Rendering…" would never resolve: a lazy
  // render finishing announces itself as `processing.completed`, and the event
  // hook's replace path re-fetches the capture — which is a full detail, since
  // `rollApi.getCapture` is what fetched it.
  //
  // `wants` is what keeps this page cheap. Every capture in the roll emits
  // events; without the filter each one cost a full `getCapture` here, and the
  // answer was then thrown away because the id did not match. One photograph
  // on screen, one capture fetched.
  /**
   * The host pulled this photograph while a guest was looking at it.
   *
   * The page passed only `wants` and `replace`, so `capture.hidden` and
   * `capture.deleted` called an undefined `remove` handler and there was no
   * `onRollCleared` at all: a deleted photograph stayed on the guest's screen
   * for as long as they left the tab open, and its bytes stayed in the asset
   * cache, still servable offline. Moderation has to reach here too.
   *
   * Evicting first and then showing the 404 page in the same order the feed
   * uses (`RollFeedPage.removeLive`): both URLs per asset, the inline one and
   * the `?download=1` one, which are different cache keys for the same bytes.
   */
  const dropCapture = useCallback((): void => {
    setCapture((current) => {
      if (current !== null) void evictCaptureAssets(current, rollApi).catch(() => {});
      return null;
    });
    setGone(true);
  }, []);

  useRollEvents(
    slug,
    {
      wants: (id) => id === captureId,
      replace: (next) => {
        if (next.captureId === captureId) setCapture(next);
      },
      remove: (id) => {
        if (id === captureId) dropCapture();
      },
      onRollCleared: dropCapture,
    },
    rollApi,
    roll !== null && error === null,
  );

  if (gone) return <NoCapturePage slug={slug} />;

  if (error instanceof PinRequiredError) {
    return <PinGate slug={slug} onUnlocked={() => setAttempt((current) => current + 1)} />;
  }

  if (isMissingCaptureError(error)) return <NoCapturePage slug={slug} />;
  if (isNoRollError(error)) return <NoRollPage />;

  return (
    <>
      <div className="k-app">
        <OfflineBanner />
        <div className="k-bar">
          <a className="k-back" href={`/r/${encodeURIComponent(slug)}`} aria-label="Back to the roll">
            <span aria-hidden="true">&#8249;</span>
          </a>
          <span className="k-who">{rollLabel(roll?.title, slug)}</span>
          {/* The window carries when this frame was taken — the one fact that
              is about this photograph rather than about the roll. */}
          {capture === null ? null : <span className="k-count">{clockOf(capture.capturedAt)}</span>}
        </div>
        {error !== null ? (
          <LoadFailure
            onRetry={() => setAttempt((current) => current + 1)}
            offline={!online}
            what="photo"
            reason={apiFailureMessage(error)}
          />
        ) : null}
        {/* Offline and not loaded yet: say so NOW rather than after the
            service worker's five-second network timeout has run out and
            produced a red line blaming a connection the phone already knows
            it does not have. */}
        {capture === null || roll === null
          ? error !== null
            ? null
            : online
              ? <p className="k-note">Reading roll…</p>
              : <p className="k-note" role="status">You&#39;re offline. This photo has not been loaded yet.</p>
          : null}
        {capture !== null && roll !== null ? (
          <CaptureDetail slug={slug} capture={capture} roll={roll} />
        ) : null}
      </div>
    </>
  );
}
