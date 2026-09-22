/**
 * In-memory record store with `chrome.storage.session` write-behind.
 *
 * An MV3 service worker is evicted aggressively, so the store rehydrates from
 * session storage on start-up and flushes on a debounce. Session storage is
 * memory-backed and cleared when the browser closes, which is the right
 * lifetime for captured traffic.
 */

import type { Grouping } from '../config/schema.ts';
import { summarizeDomains, summarizeTotals } from '../engine/aggregate.ts';
import {
  MAX_BODY_BYTES_TOTAL,
  MAX_RECORDS_PER_TAB,
  MAX_TABS,
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_RECORDS,
  PERSIST_RECORDS_PER_TAB,
  SESSION_BUDGET_BYTES,
  SESSION_STORE_KEY,
} from '../shared/constants.ts';
import { errorMessage, logger } from '../shared/logger.ts';
import type { LiteRecord, RequestRecord, TabSummary } from '../shared/types.ts';
import { toLite } from './lite.ts';

interface TabState {
  tabId: number;
  title?: string;
  pageUrl?: string;
  closed: boolean;
  /** Capture is per tab so a panel can pause one page without affecting others. */
  recording: boolean;
  recordingStartedAt: number;
  /** `null` follows the policy's `clearOnNavigate`; a boolean overrides it. */
  preserveLog: boolean | null;
  lastActivityAt: number;
  records: RequestRecord[];
}

/** Session-storage shape. Fields added after a release may be missing. */
type PersistedTab = Partial<Omit<TabState, 'tabId' | 'records'>> & {
  tabId: number;
  records: LiteRecord[];
};

/**
 * Widens a stored row back into a record.
 *
 * The observation fields come back empty rather than absent so nothing has to
 * null-check them. They are empty on a live record of any age too — the sweep
 * releases them seconds after capture — so a restored record is not a lesser
 * one, and needs no marker saying so.
 */
function fromPersisted(stored: LiteRecord): RequestRecord {
  return { ...stored, requestHeaders: {}, responseHeaders: {}, query: {} };
}

const tabs = new Map<number, TabState>();
const index = new Map<string, RequestRecord>();

/**
 * Tabs with DevTools open right now.
 *
 * Kept out of `TabState` on purpose: it is a fact about this moment, and a
 * snapshot that outlived the worker would restore it as a stale `true` and
 * promise capture that cannot happen.
 */
const attached = new Set<number>();

let hydrated = false;
let hydrating: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function reindex(): void {
  index.clear();
  for (const tab of tabs.values()) {
    for (const record of tab.records) {
      index.set(record.id, record);
    }
  }
}

/**
 * Revives one stored tab.
 *
 * Every field is defaulted: the snapshot was written by a previous worker
 * generation, possibly an older build of this extension, so nothing in it is
 * guaranteed to be there.
 */
function reviveTab(entry: PersistedTab, now: number): TabState {
  return {
    tabId: entry.tabId,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.pageUrl === undefined ? {} : { pageUrl: entry.pageUrl }),
    closed: entry.closed ?? false,
    recording: entry.recording ?? recordByDefault,
    recordingStartedAt: entry.recordingStartedAt ?? now,
    preserveLog: entry.preserveLog ?? null,
    lastActivityAt: entry.lastActivityAt ?? now,
    records: (entry.records ?? []).map(fromPersisted),
  };
}

async function hydrate(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(SESSION_STORE_KEY);
    const value = stored[SESSION_STORE_KEY];
    const raw: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(raw)) {
      const now = Date.now();
      for (const entry of raw as PersistedTab[]) {
        tabs.set(entry.tabId, reviveTab(entry, now));
      }
      reindex();
    }
  } catch (cause) {
    logger.error('failed to rehydrate the record store', errorMessage(cause));
  }
  hydrated = true;
}

/** Resolves once the store has been rehydrated; every mutation awaits this. */
export function ready(): Promise<void> {
  if (hydrated) {
    return Promise.resolve();
  }
  hydrating ??= hydrate();
  return hydrating;
}

/**
 * Drops the oldest captured payloads once they exceed the memory budget.
 *
 * Verdicts are computed at capture time and kept, so trimming costs only the
 * Payload and Response tabs of older requests, which the detail pane reports
 * honestly as "not captured".
 */
function trimBodies(): void {
  const withBodies: { readonly record: RequestRecord; readonly bytes: number }[] = [];
  let total = 0;
  for (const tab of tabs.values()) {
    for (const record of tab.records) {
      const bytes =
        (record.requestBody?.text.length ?? 0) + (record.responseBody?.text.length ?? 0);
      if (bytes > 0) {
        total += bytes;
        withBodies.push({ record, bytes });
      }
    }
  }
  if (total <= MAX_BODY_BYTES_TOTAL) {
    return;
  }
  withBodies.sort((left, right) => left.record.startedAt - right.record.startedAt);
  for (const entry of withBodies) {
    if (total <= MAX_BODY_BYTES_TOTAL) {
      break;
    }
    entry.record.requestBody = undefined;
    entry.record.responseBody = undefined;
    total -= entry.bytes;
  }
  logger.debug('captured payloads trimmed to the memory budget');
}

/**
 * Builds the session snapshot within a byte budget.
 *
 * Payloads are never persisted: they are the bulk of a record and the only part
 * that can be regenerated by simply reloading the page. Tabs are taken most
 * recently active first and records newest first, so what survives an eviction
 * is what the user is most likely to still care about. The result is a string,
 * which is both what gets stored and what gets measured — there is no guessing
 * about the encoded size.
 */
/**
 * Takes the newest records that still fit, newest-first, and returns them in
 * their original order along with the bytes they cost.
 */
function takeRecords(
  records: readonly RequestRecord[],
  budget: number,
  limit: number,
): { readonly records: LiteRecord[]; readonly spent: number } {
  const kept: LiteRecord[] = [];
  let spent = 0;
  for (let cursor = records.length - 1; cursor >= 0 && kept.length < limit; cursor -= 1) {
    const source = records[cursor];
    if (source === undefined) {
      continue;
    }
    const lean = toLite(source);
    const size = JSON.stringify(lean).length + 1;
    if (size >= budget - spent) {
      break;
    }
    spent += size;
    kept.push(lean);
  }
  kept.reverse();
  return { records: kept, spent };
}

function buildSnapshot(): string {
  const ordered = [...tabs.values()].sort(
    (left, right) => right.lastActivityAt - left.lastActivityAt,
  );
  const snapshot: PersistedTab[] = [];
  // The enclosing `[]` and the comma before each tab after the first are part
  // of the string that gets stored, so they come out of the budget too.
  let budget = SESSION_BUDGET_BYTES - 2;
  let remaining = PERSIST_MAX_RECORDS;

  for (const tab of ordered) {
    const { records: _all, ...meta } = tab;
    const header = JSON.stringify({ ...meta, records: [] }).length + (snapshot.length > 0 ? 1 : 0);
    if (header >= budget) {
      break;
    }
    budget -= header;

    const taken = takeRecords(tab.records, budget, Math.min(remaining, PERSIST_RECORDS_PER_TAB));
    budget -= taken.spent;
    remaining -= taken.records.length;
    snapshot.push({ ...meta, records: taken.records });
  }

  return JSON.stringify(snapshot);
}

/**
 * Writes the snapshot. A failure here costs a warm restart, never data: the
 * in-memory store is the source of truth and is left untouched.
 */
async function flush(): Promise<void> {
  trimBodies();
  try {
    await chrome.storage.session.set({ [SESSION_STORE_KEY]: buildSnapshot() });
  } catch (cause) {
    logger.warn('session snapshot not written; continuing in memory', errorMessage(cause));
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flush();
  }, PERSIST_DEBOUNCE_MS);
}

function evictTabs(): void {
  if (tabs.size <= MAX_TABS) {
    return;
  }
  const ordered = [...tabs.values()].sort(
    (left, right) => left.lastActivityAt - right.lastActivityAt,
  );
  for (const tab of ordered.slice(0, tabs.size - MAX_TABS)) {
    tabs.delete(tab.tabId);
  }
  reindex();
}

/**
 * Whether a tab starts recording on sight.
 *
 * Off by default: the extension observes every request the browser makes, so a
 * tab is audited only once someone asks for it. `settings.recordByDefault`
 * flips it for people who want the old behaviour.
 */
let recordByDefault = false;

export function setRecordByDefault(value: boolean): void {
  recordByDefault = value;
}

function tabState(tabId: number): TabState {
  const existing = tabs.get(tabId);
  if (existing !== undefined) {
    return existing;
  }
  const now = Date.now();
  const created: TabState = {
    tabId,
    closed: false,
    recording: recordByDefault,
    recordingStartedAt: now,
    preserveLog: null,
    lastActivityAt: now,
    records: [],
  };
  tabs.set(tabId, created);
  evictTabs();
  return created;
}

export function addRecord(record: RequestRecord): void {
  const tab = tabState(record.tabId);
  tab.records.push(record);
  tab.lastActivityAt = record.startedAt;
  index.set(record.id, record);
  if (tab.records.length > MAX_RECORDS_PER_TAB) {
    const dropped = tab.records.splice(0, tab.records.length - MAX_RECORDS_PER_TAB);
    for (const entry of dropped) {
      index.delete(entry.id);
    }
  }
  schedulePersist();
}

export function getRecord(id: string): RequestRecord | undefined {
  return index.get(id);
}

export function touchRecord(record: RequestRecord): void {
  const tab = tabs.get(record.tabId);
  if (tab !== undefined) {
    tab.lastActivityAt = Math.max(tab.lastActivityAt, record.completedAt ?? record.startedAt);
  }
  schedulePersist();
}

export function setTabPage(tabId: number, pageUrl: string | undefined, title?: string): void {
  const tab = tabState(tabId);
  if (pageUrl !== undefined) {
    tab.pageUrl = pageUrl;
  }
  if (title !== undefined) {
    tab.title = title;
  }
  schedulePersist();
}

export function clearTab(tabId: number): void {
  const tab = tabs.get(tabId);
  if (tab === undefined) {
    return;
  }
  for (const record of tab.records) {
    index.delete(record.id);
  }
  tab.records = [];
  tab.recordingStartedAt = Date.now();
  schedulePersist();
}

/** Records whether DevTools is open on a tab; returns true when that changed. */
export function setDevtoolsAttached(tabId: number, value: boolean): boolean {
  if (attached.has(tabId) === value) {
    return false;
  }
  if (value) {
    attached.add(tabId);
  } else {
    attached.delete(tabId);
  }
  return true;
}

type RecordingListener = (tabId: number) => void;

const recordingListeners = new Set<RecordingListener>();

/**
 * Subscribes to recording changes.
 *
 * Refreshing the badge and telling the DevTools page whether to capture are
 * both reactions to this, and both live outside the store — keeping them there
 * avoids an import cycle between the store's callers and the capture pipeline.
 */
export function onRecordingChanged(listener: RecordingListener): void {
  recordingListeners.add(listener);
}

/** Starts or pauses capture for one tab, restarting the "recording since" clock. */
export function setRecording(tabId: number, recording: boolean): void {
  const tab = tabState(tabId);
  if (tab.recording === recording) {
    return;
  }
  tab.recording = recording;
  if (recording) {
    tab.recordingStartedAt = Date.now();
  }
  schedulePersist();
  for (const listener of recordingListeners) {
    listener(tabId);
  }
}

export function isRecording(tabId: number): boolean {
  return tabs.get(tabId)?.recording ?? recordByDefault;
}

/** Overrides the policy's `clearOnNavigate` for one tab; `null` restores it. */
export function setPreserveLog(tabId: number, preserve: boolean | null): void {
  tabState(tabId).preserveLog = preserve;
  schedulePersist();
}

/** Resolves the effective preserve-log choice for a tab against the policy default. */
export function shouldPreserveLog(tabId: number, clearOnNavigate: boolean): boolean {
  return tabs.get(tabId)?.preserveLog ?? !clearOnNavigate;
}

export function markTabClosed(tabId: number): void {
  const tab = tabs.get(tabId);
  if (tab !== undefined) {
    tab.closed = true;
    schedulePersist();
  }
}

export function listRecords(tabId: number): readonly RequestRecord[] {
  return tabs.get(tabId)?.records ?? [];
}

export function allRecords(): readonly RequestRecord[] {
  return [...tabs.values()].flatMap((tab) => tab.records);
}

export function summarizeTab(
  tabId: number,
  grouping: Grouping,
  nameOf: (id: string) => string,
): TabSummary {
  const tab = tabs.get(tabId);
  const records = listRecords(tabId);
  return {
    tabId,
    ...(tab?.title === undefined ? {} : { title: tab.title }),
    ...(tab?.pageUrl === undefined ? {} : { pageUrl: tab.pageUrl }),
    closed: tab?.closed ?? false,
    recording: tab?.recording ?? recordByDefault,
    devtoolsAttached: attached.has(tabId),
    recordingStartedAt: tab?.recordingStartedAt ?? 0,
    preserveLog: tab?.preserveLog ?? false,
    lastActivityAt: tab?.lastActivityAt ?? 0,
    totals: summarizeTotals(records),
    domains: summarizeDomains(records, grouping, nameOf),
  };
}
