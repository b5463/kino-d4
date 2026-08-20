import { useEffect, useRef } from 'react';
import { rollApi, type CaptureView, type RollApi } from '../api/client';

const EVENT_TYPES = [
  'roll.opened',
  'roll.closed',
  'capture.created',
  'capture.updated',
  'capture.hidden',
  'capture.deleted',
  'processing.completed',
] as const;

export const EVENT_RECONNECT_MIN_MS = 1_000;
export const EVENT_RECONNECT_MAX_MS = 30_000;

export interface RollEventHandlers {
  prepend?(capture: CaptureView): void;
  replace?(capture: CaptureView): void;
  remove?(captureId: string): void;
  refetchHead?(): void | Promise<void>;
  onRollChanged?(): void | Promise<void>;
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

    const fetchCapture = (captureId: string, mode: 'prepend' | 'replace'): void => {
      void api
        .getCapture(slug, captureId)
        .then((capture) => {
          if (stopped) return;
          if (mode === 'prepend') handlersRef.current.prepend?.(capture);
          else handlersRef.current.replace?.(capture);
        })
        .catch(report);
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
        fetchCapture(payload.captureId, 'prepend');
        invoke(handlersRef.current.onRollChanged);
      });

      for (const type of ['capture.updated', 'processing.completed'] as const) {
        source.addEventListener(type, (event) => {
          const payload = payloadOf(event);
          if (payload !== null) fetchCapture(payload.captureId, 'replace');
        });
      }

      for (const type of ['capture.hidden', 'capture.deleted'] as const) {
        source.addEventListener(type, (event) => {
          const payload = payloadOf(event);
          if (payload === null) return;
          handlersRef.current.remove?.(payload.captureId);
          invoke(handlersRef.current.onRollChanged);
        });
      }

      for (const type of ['roll.opened', 'roll.closed'] as const) {
        source.addEventListener(type, () => invoke(handlersRef.current.onRollChanged));
      }
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
      closeSource();
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('pagehide', pageHidden);
      window.removeEventListener('pageshow', pageShown);
    };
  }, [api, enabled, slug]);
}

export { EVENT_TYPES };
