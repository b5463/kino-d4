import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiFailureMessage,
  isNoRollError,
  PinRequiredError,
  rollApi,
  type CaptureView,
  type RollView,
} from '../api/client';
import { evictCaptureAssets } from '../cache/assets';
import { assetOf } from '../captures';
import { playerPlayback } from '../components/playback';
import { SafeImage } from '../components/SafeImage';
import { ScanQr } from '../components/ScanQr';
import { WigglePlayer } from '../components/WigglePlayer';
import { useRollEvents } from '../hooks/useRollEvents';
import { useRollFeed } from '../hooks/useRollFeed';
import { NoRollPage } from './NotFoundPage';
import { PinGate } from './PinGate';

export interface RollDisplayPageProps {
  slug: string;
}

/** How long one capture holds the screen before the display moves on. */
export const DISPLAY_CYCLE_MS = 8_000;

/** The display rotates through this many of the newest captures. */
const CYCLE_POOL = 12;

/**
 * `/r/:slug/display` — the roll on a TV or projector at the party.
 *
 * No site chrome, no tabs, no virtualizer: a black full-bleed hero cycling the
 * newest captures, cutting straight to a genuinely new arrival. `?qr=1` adds a
 * corner QR so guests can join the roll off the screen.
 */
export function RollDisplayPage({ slug }: RollDisplayPageProps) {
  const feed = useRollFeed(slug);
  const [roll, setRoll] = useState<RollView | null>(null);
  const [rollError, setRollError] = useState<Error | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const refreshRoll = useCallback(async (): Promise<void> => {
    try {
      setRoll(await rollApi.getRoll(slug));
      setRollError(null);
    } catch (caught) {
      setRollError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, [slug]);

  useEffect(() => {
    void refreshRoll();
  }, [refreshRoll]);

  const failure = rollError ?? feed.error;

  // A live arrival cuts in immediately — the cycle resumes from it.
  const prependLive = useCallback(
    (capture: CaptureView): void => {
      feed.prepend(capture);
      setCurrentId(capture.captureId);
    },
    [feed],
  );

  /**
   * The host hid or deleted this one: off the screen now, and its bytes out of
   * the cache with it.
   *
   * The projector kept showing a deleted photograph. `remove` took it out of
   * the feed, but the cycle pool is a slice taken on render and the cached
   * asset was left servable, so the picture on the wall was the one thing in
   * the venue that had not heard.
   */
  const removeLive = useCallback(
    (captureId: string): void => {
      const capture = feed.captures.find((candidate) => candidate.captureId === captureId);
      feed.remove(captureId);
      setCurrentId((shownId) => (shownId === captureId ? null : shownId));
      if (capture !== undefined) void evictCaptureAssets(capture, rollApi).catch(() => {});
    },
    [feed],
  );

  /**
   * The host cleared the roll: the screen empties.
   *
   * There was no handler at all, so `roll.cleared` reached the display and
   * nothing happened to the twelve captures it was cycling — a projector at
   * the front of the room carrying on showing photographs the host had just
   * put in the trash.
   */
  const clearLive = useCallback((): void => {
    feed.clear();
    setCurrentId(null);
  }, [feed]);

  useRollEvents(
    slug,
    {
      prepend: prependLive,
      replace: feed.replace,
      remove: removeLive,
      refetchHead: feed.refetchHead,
      onRollChanged: refreshRoll,
      onRollCleared: clearLive,
    },
    rollApi,
    roll !== null && !(failure instanceof PinRequiredError) && !isNoRollError(failure),
  );

  const pool = feed.captures.slice(0, CYCLE_POOL);
  const poolRef = useRef(pool);
  poolRef.current = pool;

  useEffect(() => {
    const timer = setInterval(() => {
      const list = poolRef.current;
      if (list.length === 0) return;
      setCurrentId((shownId) => {
        const index = list.findIndex((capture) => capture.captureId === shownId);
        return list[(index + 1) % list.length]?.captureId ?? null;
      });
    }, DISPLAY_CYCLE_MS);
    return () => clearInterval(timer);
  }, []);

  // A display must not dim mid-party. The lock dies whenever the tab hides, so
  // it is re-acquired on every return to visibility.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = (): void => {
      void navigator.wakeLock
        ?.request('screen')
        .then((sentinel) => {
          lock = sentinel;
        })
        .catch(() => {});
    };
    const visibilityChanged = (): void => {
      if (!document.hidden) acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      void lock?.release().catch(() => {});
    };
  }, []);

  if (failure instanceof PinRequiredError) {
    return (
      <PinGate
        slug={slug}
        onUnlocked={async () => {
          await Promise.all([refreshRoll(), feed.refetchHead()]);
        }}
      />
    );
  }

  if (isNoRollError(failure)) return <NoRollPage />;

  const showQr = new URLSearchParams(window.location.search).get('qr') === '1';
  const shown = pool.find((capture) => capture.captureId === currentId) ?? pool[0];

  let media = null;
  if (shown !== undefined) {
    const poster = assetOf(shown, ['enhanced-still', 'kino-still', 'thumb', 'wiggle-preview']);
    const animated = assetOf(shown, ['wiggle-webp', 'wiggle-preview']);
    // Camera order, from frameIndex (the 1-based camera number), never the
    // order the API happened to list the assets in.
    const originals = shown.assets
      .filter((asset) => asset.role === 'original-frame')
      .sort((left, right) => (left.frameIndex ?? 0) - (right.frameIndex ?? 0))
      .map((asset) => rollApi.assetUrl(asset.assetId));

    /**
     * The BAKED animation first, the live player only when there is none.
     *
     * `animated` was computed here and then never used by the branch that
     * actually ran, so every wigglegram with two or more originals mounted the
     * live player: four full-resolution JPEGs, twelve to twenty megabytes, per
     * capture, every eight seconds, over the venue's Wi-Fi — while a 960 px
     * `wiggle-webp` of the same photograph sat there at a few tens of kB. The
     * feed already reasons this way and says so in its own comment; the
     * display did not.
     *
     * Playback is not a download, and a save permission decides what leaves a
     * guest's phone, never what a screen at the party may show. This gate used
     * to require `downloadsEnabled`, so a host turning saves off froze the
     * display. A failed capture gets no player either way: its frames may be
     * half written.
     */
    if (
      animated === undefined &&
      shown.mode === 'wiggle' &&
      originals.length >= 2 &&
      shown.status !== 'failed'
    ) {
      media = (
        <WigglePlayer
          frames={originals}
          {...playerPlayback(shown.playback)}
          poster={poster === undefined ? undefined : rollApi.assetUrl(poster.assetId)}
        />
      );
    } else {
      const source = animated ?? poster;
      media =
        source === undefined ? null : (
          <SafeImage key={shown.captureId} src={rollApi.assetUrl(source.assetId)} alt="" className="display-img" />
        );
    }
  }

  return (
    <div className="display-root">
      {media === null ? (
        <p className="display-empty" role="status" aria-live="polite">
          {/* Never the raw error. This is a projector at the front of a room,
              and it printed `TypeError: Failed to fetch` across the wall. Same
              treatment as `components/LoadFailure.tsx`: what the reader can
              act on, in the reader's own words. */}
          {failure === null
            ? 'No photos yet.'
            : (apiFailureMessage(failure) ?? 'Cannot reach the roll. Check the connection.')}
        </p>
      ) : (
        <div className="display-hero" aria-label="Latest captures">{media}</div>
      )}
      <span className="display-title">{roll?.title ?? slug}</span>
      {showQr ? <ScanQr slug={slug} /> : null}
    </div>
  );
}
