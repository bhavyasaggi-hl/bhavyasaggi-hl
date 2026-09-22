/**
 * Live state stream for the extension's pages.
 *
 * The panel needs Network-panel responsiveness without a message per event, so
 * changed records are collected into a dirty set and flushed on a short timer.
 * Observations are stripped from the stream: the panel renders verdicts and
 * timings, so headers, query and payloads never cross to a page.
 */

import { errorMessage, logger } from '../shared/logger.ts';
import { UI_PORT, type UiInbound, type UiOutbound } from '../shared/messages.ts';
import type { RequestRecord } from '../shared/types.ts';
import { refreshBadge } from './badge.ts';
import { whenReady } from './bootstrap.ts';
import { assertionName, getConfig, getConfigStatus, getPolicyIndex } from './config-store.ts';
import { toLite } from './lite.ts';
import {
  clearTab,
  getRecord,
  listRecords,
  setPreserveLog,
  setRecording,
  summarizeTab,
} from './store.ts';

/** Coalescing window for record updates pushed to a panel. */
const FLUSH_MS = 180;

interface Subscriber {
  readonly port: chrome.runtime.Port;
  tabId: number | null;
  /** The popup subscribes for totals only, so it is never sent a record. */
  wantsRecords: boolean;
  readonly dirty: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

const subscribers = new Set<Subscriber>();

function send(subscriber: Subscriber, message: UiOutbound): void {
  try {
    subscriber.port.postMessage(message);
  } catch (cause) {
    logger.debug('panel port send failed', errorMessage(cause));
  }
}

function sendSnapshot(subscriber: Subscriber): void {
  if (subscriber.tabId === null) {
    return;
  }
  subscriber.dirty.clear();
  if (!subscriber.wantsRecords) {
    sendState(subscriber);
    return;
  }
  send(subscriber, {
    type: 'snapshot',
    records: listRecords(subscriber.tabId).map(toLite),
    tab: summarizeTab(subscriber.tabId, getConfig().settings.grouping, assertionName),
    config: getConfigStatus(),
    policy: getPolicyIndex(),
  });
}

function sendState(subscriber: Subscriber): void {
  if (subscriber.tabId === null) {
    return;
  }
  send(subscriber, {
    type: 'state',
    tab: summarizeTab(subscriber.tabId, getConfig().settings.grouping, assertionName),
    config: getConfigStatus(),
  });
}

function flush(subscriber: Subscriber): void {
  subscriber.timer = null;
  if (subscriber.tabId === null || subscriber.dirty.size === 0) {
    return;
  }
  if (!subscriber.wantsRecords) {
    subscriber.dirty.clear();
    sendState(subscriber);
    return;
  }
  const records = [...subscriber.dirty]
    .map((id) => getRecord(id))
    .filter((record): record is RequestRecord => record !== undefined)
    .map(toLite);
  subscriber.dirty.clear();
  if (records.length > 0) {
    send(subscriber, { type: 'upsert', records });
  }
  sendState(subscriber);
}

function schedule(subscriber: Subscriber): void {
  subscriber.timer ??= setTimeout(() => {
    flush(subscriber);
  }, FLUSH_MS);
}

/** Queues a created or updated record for delivery to any panel watching its tab. */
export function notifyRecordChanged(record: RequestRecord): void {
  for (const subscriber of subscribers) {
    if (subscriber.tabId === record.tabId) {
      subscriber.dirty.add(record.id);
      schedule(subscriber);
    }
  }
}

/** Pushes a fresh snapshot to every panel, e.g. after the policy changed. */
export function notifyAllPanels(): void {
  for (const subscriber of subscribers) {
    sendSnapshot(subscriber);
  }
}

/** Pushes current state to every page watching one tab. */
function notifyTabState(tabId: number): void {
  for (const subscriber of subscribers) {
    if (subscriber.tabId === tabId) {
      sendState(subscriber);
    }
  }
}

/** Pushes a fresh snapshot to the pages watching one tab. */
export function notifyTabReset(tabId: number): void {
  for (const subscriber of subscribers) {
    if (subscriber.tabId === tabId) {
      sendSnapshot(subscriber);
    }
  }
}

function handle(subscriber: Subscriber, message: UiInbound): void {
  switch (message.type) {
    case 'subscribe':
      subscriber.tabId = message.tabId;
      subscriber.wantsRecords = message.records;
      sendSnapshot(subscriber);
      break;
    case 'setRecording':
      if (subscriber.tabId !== null) {
        setRecording(subscriber.tabId, message.recording);
        // Every page watching this tab is told, not just the one that asked:
        // the popup and the panel can both be open on it.
        notifyTabState(subscriber.tabId);
      }
      break;
    case 'setPreserveLog':
      if (subscriber.tabId !== null) {
        setPreserveLog(subscriber.tabId, message.preserveLog);
        notifyTabState(subscriber.tabId);
      }
      break;
    default:
      if (subscriber.tabId !== null) {
        const { tabId } = subscriber;
        clearTab(tabId);
        notifyTabReset(tabId);
        void refreshBadge(tabId);
      }
  }
}

/** Registers the panel port listener. Must run synchronously at worker start-up. */
export function registerPanelStream(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== UI_PORT || port.sender?.id !== chrome.runtime.id) {
      return;
    }
    const subscriber: Subscriber = {
      port,
      tabId: null,
      wantsRecords: true,
      dirty: new Set(),
      timer: null,
    };
    subscribers.add(subscriber);

    port.onMessage.addListener((message: UiInbound) => {
      void whenReady().then(() => {
        handle(subscriber, message);
      });
    });

    port.onDisconnect.addListener(() => {
      if (subscriber.timer !== null) {
        clearTimeout(subscriber.timer);
      }
      subscribers.delete(subscriber);
    });
  });
}
