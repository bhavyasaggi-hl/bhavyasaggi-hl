/**
 * The panel's view of the worker: records, tab totals and the active policy.
 *
 * Everything arrives pushed over the shared port — nothing polls. A snapshot
 * replaces the list wholesale; upserts patch it in place by id, which is what
 * keeps a page load of several hundred finished requests from rebuilding the
 * whole list each time.
 */

import { useCallback, useRef, useState } from 'preact/compat';
import type { UiInbound, UiOutbound } from '../../shared/messages.ts';
import type { ConfigStatus, LiteRecord, PolicyIndex, TabSummary } from '../../shared/types.ts';
import { type AsyncState, failure, success, UNINITIALIZED } from '../lib/async-state.ts';
import { useWorkerPort } from '../lib/use-worker-port.ts';

export interface PanelData {
  readonly records: readonly LiteRecord[];
  readonly tab: TabSummary;
  readonly config: ConfigStatus;
  /** Assertion wording, joined to each record's outcomes by id. */
  readonly policy: PolicyIndex;
}

export interface PanelStream {
  readonly state: AsyncState<PanelData>;
  /** False while the port is down, so the panel can say so without blanking. */
  readonly connected: boolean;
  readonly setRecording: (recording: boolean) => void;
  readonly setPreserveLog: (preserveLog: boolean) => void;
  readonly clear: () => void;
}

export function usePanelStream(tabId: number): PanelStream {
  const [received, setReceived] = useState<AsyncState<PanelData>>(UNINITIALIZED);
  const positions = useRef(new Map<string, number>());

  const onMessage = useCallback((message: UiOutbound): void => {
    if (message.type === 'snapshot') {
      positions.current = new Map(message.records.map((record, index) => [record.id, index]));
      setReceived(
        success({
          records: message.records,
          tab: message.tab,
          config: message.config,
          policy: message.policy,
        }),
      );
      return;
    }
    setReceived((previous) => {
      if (previous.status !== 'success') {
        // Nothing to patch before the first snapshot, which the subscribe
        // always brings.
        return previous;
      }
      if (message.type === 'state') {
        return success({ ...previous.data, tab: message.tab, config: message.config });
      }
      const records = previous.data.records.slice();
      for (const record of message.records) {
        const at = positions.current.get(record.id);
        if (at === undefined) {
          positions.current.set(record.id, records.length);
          records.push(record);
        } else {
          records[at] = record;
        }
      }
      return success({ ...previous.data, records });
    });
  }, []);

  // A dropped port means the next snapshot rebuilds the list, so the index
  // built against the old one must not outlive it.
  const onReset = useCallback((): void => {
    positions.current = new Map();
  }, []);

  const { connected, error, post } = useWorkerPort({
    subscribe: { type: 'subscribe', tabId, records: true },
    onMessage,
    onReset,
  });

  return {
    // Derived, not stored: a port that cannot open is an error state whatever
    // arrived before it.
    state: error === null ? received : failure<PanelData>(error),
    connected,
    setRecording: useCallback(
      (recording: boolean) => {
        post({ type: 'setRecording', recording } satisfies UiInbound);
      },
      [post],
    ),
    setPreserveLog: useCallback(
      (preserveLog: boolean) => {
        post({ type: 'setPreserveLog', preserveLog } satisfies UiInbound);
      },
      [post],
    ),
    clear: useCallback(() => {
      post({ type: 'clear' } satisfies UiInbound);
    }, [post]),
  };
}
