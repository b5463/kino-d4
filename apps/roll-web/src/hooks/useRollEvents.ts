import { useEffect, useRef } from 'react';
import { rollApi, type CaptureView, type RollApi } from '../api/client';

const EVENT_TYPES = [
  'roll.opened',
  'roll.closed',
  'roll.cleared',
  'capture.created',
  'capture.updated',
  'capture.hidden',
  'capture.deleted',
  'processing.completed',
] as const;

export const EVENT_RECONNECT_MIN_MS = 1_000;
export const EVENT_RECONNECT_MAX_MS = 30_000;

/**
 * How long a capture's refetch waits for the rest of its burst. One photograph
 * emits nine update events as its four asset roles finish, all inside a few
 * hundred milliseconds; 300 ms of trailing quiet turns them into one `GET`.
 */
export const CAPTURE_REFETCH_DEBOUNCE_MS = 300;
/** The same trailing quiet for the roll record, which no guest is watching. */
export const ROLL_REFRESH_DEBOUNCE_MS = 300;

export interface RollEventHandlers {
  /**
   * Which captures this subscriber cares about. Returning false for an id
   * drops the event before anything is requested for it — a single-capture
   * page must not fetch every capture in the roll on every event, which is
   * what happens when the filtering is done after `getCapture` has already
   * answered. Absent means "all of them", which is what the feed wants.
   */
  wants?(captureId: string): boolean;
  /**
   * A capture that just arrived. Named for what it used to do; the feed now
   * files it by shutter time (`useRollFeed.prepend`), so a late upload of an
   * older shot lands where it was taken, not on top.
   */
  prepend?(capture: CaptureView): void;
  replace?(capture: CaptureView): void;
  remove?(captureId: string): void;
  refetchHead?(): void | Promise<void>;
  onRollChanged?(): void | Promise<void>;
  /** The host cleared the roll: everything shown is in the trash now. */
  onRollCleared?(): void | Promise<void>;
  onError?(error: Error): void;
}

interface CaptureEventPayload {
  type: string;
  captureId: string;
}

function payloadOf(event: Event): CaptureEventPayload | null {
  try {
    const parsed: unknown = JSON.parse((event as MessageEvent).data as string);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { type, captureId } = parsed as Record<string, unknown>;
    return typeof type === 'string' && typeof captureId === 'string'
      ? { type, captureId }
      : null;
  } catch {
    return null;
  }
}

function failureOf(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

/**
 * Lossless mobile-safe Roll event subscription.
 *
 * Native EventSource performs short reconnects itself, while this hook owns the
 * lifecycle native EventSource cannot know about: page suspension, explicit
 * teardown, a bounded exponential retry after hard failures, and a head refetch
 * whenever a fresh connection may have missed state. `createRollApi.events`
 * retains the last delivered stream id, so every reopened source also asks the
 * server to replay its gap.
 */
export function useRollEvents(
  slug: string,
  handlers: RollEventHandlers,
  api: RollApi = rollApi,
  enabled = true,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = EVENT_RECONNECT_MIN_MS;
    let stopped = false;
    let paused = document.hidden;

    const report = (caught: unknown): void => {
      handlersRef.current.onError?.(failureOf(caught));
    };

    const invoke = (work: (() => void | Promise<void>) | undefined): void => {
      if (work === undefined) return;
      try {
        void Promise.resolve(work()).catch(report);
      } catch (caught) {
        report(caught);
      }
    };

    const wanted = (captureId: string): boolean =>
      handlersRef.current.wants?.(captureId) ?? true;

    /**
     * Per capture id: the trailing-debounce timer, whether a `GET` for it is on
     * the wire, whether another event landed while it was, and how the next
     * answer should be filed.
     */
    interface CaptureSlot {
      timer: ReturnType<typeof setTimeout> | null;
      open: boolean;
      again: boolean;
      mode: 'prepend' | 'replace';
      /** The capture was hidden or deleted; an answer still in flight is stale. */
      dropped: boolean;
    }

    const slots = new Map<string, CaptureSlot>();
    let rollTimer: ReturnType<typeof setTimeout> | null = null;

    const slotFor = (captureId: string): CaptureSlot => {
      const found = slots.get(captureId);
      if (found !== undefined) return found;
      const fresh: CaptureSlot = {
        timer: null,
        open: false,
        again: false,
        mode: 'replace',
        dropped: false,
      };
      slots.set(captureId, fresh);
      return fresh;
    };

    /**
     * The roll's own record — title, status, photo count — re-read on a trailing
     * debounce instead of in the same tick as the capture fetch.
     *
     * Measured through a tunnel that reaps idle sockets after 5 to 9 s and
     * charges about 2.2 s per new connection: `capture.created` used to put
     * `getCapture` and `getRoll` on the wire together, the browser opened two
     * cold connections and served them one after the other, and the guest waited
     * 4,439 ms for a tile the origin had answered in 10 to 17 ms. Now the
     * arrival gets the connection to itself and the roll record follows on it
     * while it is still warm.
     */
    const refreshRollSoon = (): void => {
      if (rollTimer !== null) clearTimeout(rollTimer);
      rollTimer = setTimeout(() => {
        rollTimer = null;
        if (stopped) return;
        invoke(handlersRef.current.onRollChanged);
      }, ROLL_REFRESH_DEBOUNCE_MS);
    };

    const runFetch = (captureId: string, slot: CaptureSlot): void => {
      const mode = slot.mode;
      slot.mode = 'replace';
      slot.open = true;
      void api
        .getCapture(slug, captureId)
        .then((capture) => {
          if (stopped || slot.dropped) return;
          if (mode === 'prepend') handlersRef.current.prepend?.(capture);
          else handlersRef.current.replace?.(capture);
        })
        .catch(report)
        .finally(() => {
          slot.open = false;
          if (stopped) return;
          // An arrival is the one event a guest is waiting on, so the roll
          // record is re-read only after its picture is in hand.
          if (mode === 'prepend' && !slot.dropped) refreshRollSoon();
          if (slot.again) {
            slot.again = false;
            // Whatever landed mid-flight is still unanswered: ask once more, so
            // a debounce can never leave a capture showing a stale state.
            requestCapture(captureId, slot.mode);
            return;
          }
          if (slot.timer === null && !slot.dropped) slots.delete(captureId);
        });
    };

    /**
     * One `GET` per capture id at a time, and one per burst of updates.
     *
     * A single photograph announces itself as `capture.created`, then five
     * `capture.updated` and four `processing.completed` as its four asset roles
     * finish. That was eleven round trips per photograph per open tab, ten of
     * them for the same id. `capture.created` still goes out immediately — that
     * is the one the guest is waiting for; the rest collapse into one refetch
     * once the burst stops.
     */
    function requestCapture(captureId: string, mode: 'prepend' | 'replace'): void {
      if (!wanted(captureId)) {
        // Not this subscriber's capture, but the roll's count still moved.
        if (mode === 'prepend') refreshRollSoon();
        return;
      }
      const slot = slotFor(captureId);
      slot.dropped = false;
      // A created outranks a queued update: an arrival has to be filed into the
      // list, and `replace` only patches a card that is already there.
      if (mode === 'prepend') slot.mode = 'prepend';

      if (slot.open) {
        slot.again = true;
        return;
      }
      if (slot.mode === 'prepend') {
        if (slot.timer !== null) clearTimeout(slot.timer);
        slot.timer = null;
        runFetch(captureId, slot);
        return;
      }
      if (slot.timer !== null) clearTimeout(slot.timer);
      slot.timer = setTimeout(() => {
        slot.timer = null;
        if (stopped) return;
        runFetch(captureId, slot);
      }, CAPTURE_REFETCH_DEBOUNCE_MS);
    }

    /** The capture is gone: cancel its queued refetch and ignore any answer. */
    const forgetCapture = (captureId: string): void => {
      const slot = slots.get(captureId);
      if (slot === undefined) return;
      if (slot.timer !== null) clearTimeout(slot.timer);
      slot.timer = null;
      slot.again = false;
      slot.dropped = true;
      slots.delete(captureId);
    };

    const closeSource = (): void => {
      source?.close();
      source = null;
    };

    let connect: (recovering: boolean) => void;

    const scheduleReconnect = (): void => {
      closeSource();
      if (stopped || paused || reconnectTimer !== null) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, EVENT_RECONNECT_MAX_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (stopped || paused) return;
        invoke(handlersRef.current.refetchHead);
        connect(true);
      }, delay);
    };

    connect = (_recovering: boolean): void => {
      if (stopped || paused || source !== null) return;
      try {
        source = api.events(slug);
      } catch (caught) {
        report(caught);
        scheduleReconnect();
        return;
      }

      source.addEventListener('open', () => {
        reconnectDelay = EVENT_RECONNECT_MIN_MS;
      });
      source.addEventListener('error', scheduleReconnect);

      source.addEventListener('capture.created', (event) => {
        const payload = payloadOf(event);
        if (payload === null) return;
        requestCapture(payload.captureId, 'prepend');
      });

      for (const type of ['capture.updated', 'processing.completed'] as const) {
        source.addEventListener(type, (event) => {
          const payload = payloadOf(event);
          if (payload !== null) requestCapture(payload.captureId, 'replace');
        });
      }

      for (const type of ['capture.hidden', 'capture.deleted'] as const) {
        source.addEventListener(type, (event) => {
          const payload = payloadOf(event);
          if (payload === null) return;
          forgetCapture(payload.captureId);
          if (wanted(payload.captureId)) handlersRef.current.remove?.(payload.captureId);
          invoke(handlersRef.current.onRollChanged);
        });
      }

      for (const type of ['roll.opened', 'roll.closed'] as const) {
        source.addEventListener(type, () => invoke(handlersRef.current.onRollChanged));
      }

      // One event for the whole roll (see the API's `RollEvent`): the list
      // empties in one step and the roll's count is re-read.
      source.addEventListener('roll.cleared', () => {
        invoke(handlersRef.current.onRollCleared);
        invoke(handlersRef.current.onRollChanged);
      });
    };

    const pause = (): void => {
      paused = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      closeSource();
    };

    const resume = (): void => {
      if (stopped || !paused) return;
      paused = false;
      invoke(handlersRef.current.refetchHead);
      connect(true);
    };

    const visibilityChanged = (): void => {
      if (document.hidden) pause();
      else resume();
    };
    const pageHidden = (): void => pause();
    const pageShown = (): void => resume();

    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('pagehide', pageHidden);
    window.addEventListener('pageshow', pageShown);

    if (!paused) connect(false);

    return () => {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (rollTimer !== null) clearTimeout(rollTimer);
      for (const slot of slots.values()) if (slot.timer !== null) clearTimeout(slot.timer);
      slots.clear();
      closeSource();
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('pagehide', pageHidden);
      window.removeEventListener('pageshow', pageShown);
    };
  }, [api, enabled, slug]);
}

export { EVENT_TYPES };
