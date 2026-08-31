import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isNoRollError,
  PinRequiredError,
  rollApi,
  type CaptureView,
  type RollView,
} from '../api/client';
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

function assetOf(capture: CaptureView, roles: readonly string[]) {
  for (const role of roles) {
    const asset = capture.assets.find((candidate) => candidate.role === role);
    if (asset !== undefined) return asset;
  }
  return undefined;
}

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

  useRollEvents(
    slug,
    {
      prepend: prependLive,
      replace: feed.replace,
      remove: feed.remove,
      refetchHead: feed.refetchHead,
      onRollChanged: refreshRoll,
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
    const originals = shown.assets
      .filter((asset) => asset.role === 'original-frame')
      .map((asset) => rollApi.assetUrl(asset.assetId));

    // Playback is not a download, and a save permission decides what leaves a
    // guest's phone, never what a screen at the party may show. This gate used
    // to require `downloadsEnabled`, so a host turning saves off froze the
    // display; the feed and the capture page were already decoupled from it.
    if (shown.mode === 'wiggle' && originals.length >= 2) {
      media = (
        <WigglePlayer
          frames={originals}
          poster={poster === undefined ? undefined : rollApi.assetUrl(poster.assetId)}
        />
      );
    } else {
      const source = animated ?? poster;
      media =
        source === undefined ? null : (
          <img key={shown.captureId} src={rollApi.assetUrl(source.assetId)} alt="" className="display-img" />
        );
    }
  }

  return (
    <div className="display-root">
      {media === null ? (
        <p className="display-empty" role="status" aria-live="polite">
          {failure !== null ? failure.message : 'No photos yet.'}
        </p>
      ) : (
        <div className="display-hero" aria-label="Latest captures">{media}</div>
      )}
      <span className="display-title">{roll?.title ?? slug}</span>
      {showQr ? <ScanQr slug={slug} /> : null}
    </div>
  );
}
