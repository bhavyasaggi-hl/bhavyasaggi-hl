/**
 * Long-lived subscription to the service worker, shared by the panel and popup.
 *
 * The worker pushes; nothing here polls. An idle MV3 worker is evicted and its
 * ports close, so a closed port is reconnected and the worker answers with
 * fresh state.
 *
 * The effect owns the port for exactly as long as it is mounted: everything it
 * creates — the port, the retry timer — is torn down by its cleanup, and a
 * `disposed` flag stops an in-flight reconnect from resurrecting one. The
 * caller's handlers are read through refs so that re-rendering with a new
 * closure never reconnects, which would replay the subscription.
 */

import { useEffect, useRef, useState } from 'preact/compat';
import { errorMessage } from '../../shared/logger.ts';
import { UI_PORT, type UiInbound, type UiOutbound } from '../../shared/messages.ts';

/** Backoff between reconnect attempts, capped so a dead worker is not hammered. */
const RETRY_MS = [250, 500, 1000, 2000, 4000] as const;

export interface WorkerPort {
  /** False while reconnecting, so a page can say so without hiding its data. */
  readonly connected: boolean;
  /** Set when the port could not be opened at all. */
  readonly error: string | null;
  readonly post: (message: UiInbound) => void;
}

export function useWorkerPort({
  subscribe,
  onMessage,
  onReset,
  enabled,
}: {
  /** Sent on every (re)connect. Read through a ref, so it may change freely. */
  readonly subscribe: UiInbound;
  readonly onMessage: (message: UiOutbound) => void;
  /** Called when a reconnect is about to replace the current state. */
  readonly onReset?: () => void;
  /** False while the caller has nothing to subscribe with yet. Defaults true. */
  readonly enabled?: boolean;
}): WorkerPort {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const port = useRef<chrome.runtime.Port | null>(null);

  const latest = useRef({ subscribe, onMessage, onReset });
  latest.current = { subscribe, onMessage, onReset };

  const tabId = subscribe.type === 'subscribe' ? subscribe.tabId : null;

  // `tabId` is what the subscription is *for*, so a change to it has to open a
  // new port. The effect reads it through the ref rather than directly, which
  // the rule cannot see.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabId is the reconnect trigger, not a read
  useEffect(() => {
    if (enabled === false) {
      return;
    }
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = (): void => {
      if (disposed) {
        return;
      }
      try {
        const opened = chrome.runtime.connect({ name: UI_PORT });
        port.current = opened;

        opened.onMessage.addListener((message: UiOutbound) => {
          if (disposed) {
            return;
          }
          attempt = 0;
          setConnected(true);
          setError(null);
          latest.current.onMessage(message);
        });

        opened.onDisconnect.addListener(() => {
          port.current = null;
          if (disposed) {
            return;
          }
          setConnected(false);
          latest.current.onReset?.();
          const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 4000;
          attempt += 1;
          retry = setTimeout(connect, delay);
        });

        opened.postMessage(latest.current.subscribe);
      } catch (cause) {
        // `connect` throws only when the extension context is gone, which no
        // amount of retrying fixes.
        setConnected(false);
        setError(errorMessage(cause));
      }
    };

    connect();
    return () => {
      disposed = true;
      if (retry !== null) {
        clearTimeout(retry);
      }
      port.current?.disconnect();
      port.current = null;
    };
  }, [tabId, enabled]);

  const post = useRef((message: UiInbound): void => {
    try {
      port.current?.postMessage(message);
    } catch {
      // The worker was evicted mid-click; the reconnect resyncs state.
    }
  }).current;

  return { connected, error, post };
}
