import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clampWiggleFps,
  wiggleSequence,
  type LoopMode,
} from '@kino/media';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface WigglePlayerProps {
  /** Ordered frame URLs in camera order; a wiggle needs at least two. */
  frames: string[];
  fps?: number;
  loop?: LoopMode;
  /** Shown until preloading finishes and whenever reduced motion has not been opted into. */
  poster?: string;
  autoPlay?: boolean;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function pageIsVisible(): boolean {
  return typeof document === 'undefined' || !document.hidden;
}

/**
 * The live, frame-swapping Roll wiggle player (03 §13, §23; 06 §14–15).
 *
 * It intentionally renders an ordinary image rather than a canvas. Every frame
 * stays a browser-managed image resource, so alt/focus behavior remains normal,
 * the decoded preload cache can be reused, and pausing costs no render loop.
 * The frame order is imported from `@kino/media`, the same function used by the
 * worker's baked WebP/MP4 outputs, so live and downloaded wiggles cannot drift.
 */
export function WigglePlayer({
  frames,
  fps,
  loop = 'bounce',
  poster,
  autoPlay = true,
}: WigglePlayerProps) {
  if (frames.length < 2) {
    throw new RangeError(`WigglePlayer needs at least two frames, got ${String(frames.length)}`);
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef(0);
  const frameRequestRef = useRef<number | null>(null);
  const sequence = useMemo(() => wiggleSequence(frames.length, loop, 'ltr'), [frames.length, loop]);
  const frameRate = clampWiggleFps(fps);

  const [position, setPosition] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [intersecting, setIntersecting] = useState(true);
  const [pageVisible, setPageVisible] = useState(pageIsVisible);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [motionOptIn, setMotionOptIn] = useState(false);
  const [playing, setPlaying] = useState(autoPlay);

  useEffect(() => {
    positionRef.current = 0;
    setPosition(0);
  }, [sequence]);

  useEffect(() => {
    setPlaying(autoPlay);
  }, [autoPlay]);

  useEffect(() => {
    let cancelled = false;
    let remaining = frames.length;
    const preloads: HTMLImageElement[] = [];

    setLoaded(false);
    const settled = (): void => {
      remaining -= 1;
      if (!cancelled && remaining === 0) setLoaded(true);
    };

    for (const url of frames) {
      const image = new Image();
      image.onload = settled;
      // A broken frame must not leave the player on its poster forever. It may
      // still fail visibly when selected, which is an honest media error and
      // lets the surrounding capture view offer the processed fallback.
      image.onerror = settled;
      image.src = url;
      preloads.push(image);
    }

    return () => {
      cancelled = true;
      for (const image of preloads) {
        image.onload = null;
        image.onerror = null;
      }
    };
  }, [frames]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const changed = (event: MediaQueryListEvent): void => {
      setReducedMotion(event.matches);
      if (event.matches) setMotionOptIn(false);
    };

    setReducedMotion(query.matches);
    if (typeof query.addEventListener === 'function') query.addEventListener('change', changed);
    else query.addListener(changed);

    return () => {
      if (typeof query.removeEventListener === 'function') {
        query.removeEventListener('change', changed);
      } else {
        query.removeListener(changed);
      }
    };
  }, []);

  useEffect(() => {
    const changed = (): void => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIntersecting(
          entry !== undefined && entry.isIntersecting && entry.intersectionRatio >= 0.25,
        );
      },
      { threshold: 0.25 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const motionAllowed = !reducedMotion || motionOptIn;
  const shouldAnimate = loaded && playing && intersecting && pageVisible && motionAllowed;

  useEffect(() => {
    if (!shouldAnimate) return;

    const frameDuration = 1_000 / frameRate;
    let previousTimestamp: number | null = null;
    let elapsed = 0;

    const tick = (timestamp: number): void => {
      if (previousTimestamp === null) {
        previousTimestamp = timestamp;
      } else {
        elapsed += Math.max(0, timestamp - previousTimestamp);
        previousTimestamp = timestamp;
      }

      let nextPosition = positionRef.current;
      let stopped = false;
      while (elapsed + Number.EPSILON >= frameDuration) {
        elapsed -= frameDuration;
        if (loop === 'once' && nextPosition === sequence.length - 1) {
          stopped = true;
          break;
        }
        nextPosition = (nextPosition + 1) % sequence.length;
      }

      if (nextPosition !== positionRef.current) {
        positionRef.current = nextPosition;
        setPosition(nextPosition);
      }

      if (stopped) {
        frameRequestRef.current = null;
        setPlaying(false);
        return;
      }
      frameRequestRef.current = requestAnimationFrame(tick);
    };

    frameRequestRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRequestRef.current !== null) cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    };
  }, [frameRate, loop, sequence.length, shouldAnimate]);

  const optInRequired = reducedMotion && !motionOptIn;
  const currentFrameIndex = sequence[position] ?? 0;
  const source = !loaded || optInRequired ? (poster ?? frames[0]) : frames[currentFrameIndex];

  const togglePlayback = (): void => {
    if (optInRequired) {
      setMotionOptIn(true);
      setPlaying(true);
      return;
    }
    setPlaying((current) => !current);
  };

  return (
    <div
      ref={containerRef}
      data-wiggle-player=""
      data-playing={shouldAnimate ? 'true' : 'false'}
      /* Which camera's frame is on screen right now. The feed's four-bar mark
         reads this to light the matching bar, so the indicator is the
         playhead rather than a second thing that has to be kept in step. */
      data-frame={currentFrameIndex}
      style={{ position: 'relative', width: '100%' }}
    >
      <button
        type="button"
        onClick={togglePlayback}
        aria-label={shouldAnimate ? 'Pause wiggle animation' : 'Play wiggle animation'}
        disabled={!loaded}
        style={{ display: 'block', width: '100%', padding: 0, border: 0, background: 'none' }}
      >
        <img src={source} alt="" draggable={false} style={{ display: 'block', width: '100%' }} />
        {optInRequired && loaded ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: '50% auto auto 50%',
              transform: 'translate(-50%, -50%)',
              fontSize: '2rem',
            }}
          >
            ▶
          </span>
        ) : null}
      </button>
    </div>
  );
}
