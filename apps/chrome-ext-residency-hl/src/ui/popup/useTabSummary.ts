/**
 * The popup's view of the active tab: totals, per-domain rates, policy status.
 *
 * It subscribes for the summary only, so the worker never sends it a request
 * record. Updates are pushed on the same coalescing timer the panel uses, which
 * is what replaced the popup's old one-and-a-half-second refresh loop.
 *
 * Resolving the active tab is its own asynchronous step, so the port is not
 * opened until there is a tab id to subscribe with.
 */

import { useCallback, useEffect, useState } from 'preact/compat';
import { errorMessage } from '../../shared/logger.ts';
import type { UiInbound, UiOutbound } from '../../shared/messages.ts';
import type { ConfigStatus, TabSummary } from '../../shared/types.ts';
import { type AsyncState, failure, success, UNINITIALIZED } from '../lib/async-state.ts';
import { useWorkerPort } from '../lib/use-worker-port.ts';

export interface Snapshot {
  readonly tab: TabSummary;
  readonly config: ConfigStatus;
}

export interface PopupStream {
  readonly state: AsyncState<Snapshot>;
  readonly connected: boolean;
  readonly setRecording: (recording: boolean) => void;
  readonly clear: () => void;
}

export function useTabSummary(): PopupStream {
  const [tabId, setTabId] = useState<number | null>(null);
  const [tabError, setTabError] = useState<string | null>(null);
  const [received, setReceived] = useState<AsyncState<Snapshot>>(UNINITIALIZED);

  useEffect(() => {
    let live = true;
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([active]) => {
        if (!live) {
          return;
        }
        if (active?.id === undefined) {
          setTabError('No auditable tab is active.');
          return;
        }
        setTabId(active.id);
      })
      .catch((cause: unknown) => {
        if (live) {
          setTabError(errorMessage(cause));
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const onMessage = useCallback((message: UiOutbound): void => {
    // A summary subscriber is only ever sent `state`; the other shapes belong
    // to the panel.
    if (message.type === 'state') {
      setReceived(success({ tab: message.tab, config: message.config }));
    }
  }, []);

  const { connected, error, post } = useWorkerPort({
    subscribe: { type: 'subscribe', tabId: tabId ?? -1, records: false },
    onMessage,
    enabled: tabId !== null,
  });

  const problem = tabError ?? error;
  return {
    state: problem === null ? received : failure<Snapshot>(problem),
    connected,
    setRecording: useCallback(
      (recording: boolean) => {
        post({ type: 'setRecording', recording } satisfies UiInbound);
      },
      [post],
    ),
    clear: useCallback(() => {
      post({ type: 'clear' } satisfies UiInbound);
    }, [post]),
  };
}
