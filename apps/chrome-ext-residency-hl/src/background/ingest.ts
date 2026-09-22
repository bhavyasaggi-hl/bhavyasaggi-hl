/**
 * Accepts records captured by the DevTools panel.
 *
 * The panel is the only capture source: `chrome.devtools.network` is scoped to
 * the inspected tab and needs no permissions. Everything downstream — the
 * store, the policy, persistence, the badge and the popup — is unchanged, so
 * the panel produces and the worker remains the single source of truth.
 */

import { evaluateRecord, isScoped, scriptsFor, withTests } from '../engine/evaluate.ts';
import { logger } from '../shared/logger.ts';
import type { RequestRecord, TestOutcome } from '../shared/types.ts';
import { scheduleBadge } from './badge.ts';
import { getConfig } from './config-store.ts';
import { requestScriptRun } from './devtools-link.ts';
import { scheduleSweep } from './reduce.ts';
import {
  addRecord,
  clearTab,
  getRecord,
  isRecording,
  setTabPage,
  shouldPreserveLog,
  touchRecord,
} from './store.ts';
import { notifyRecordChanged } from './stream.ts';

/** Judges a record and publishes the result. */
function publish(record: RequestRecord): void {
  const config = getConfig();
  record.evaluation = evaluateRecord(record, config);
  touchRecord(record);
  // The policy has read the observation; it is now on a clock.
  scheduleSweep();
  notifyRecordChanged(record);
  scheduleBadge(record.tabId);

  // Scripts cannot run here — MV3 forbids `eval` in a worker — so they are
  // handed to the sandbox the DevTools page hosts, and land back asynchronously.
  const scripts = scriptsFor(record, config);
  if (scripts.length > 0) {
    requestScriptRun(record, scripts);
  }
}

/**
 * Folds a sandbox run's outcomes into the record it judged.
 *
 * The record may have been cleared or released while the scripts ran, so a
 * missing one is normal rather than an error.
 */
export function attachTests(recordId: string, outcomes: readonly TestOutcome[]): void {
  const record = getRecord(recordId);
  if (record?.evaluation === undefined) {
    return;
  }
  record.evaluation = withTests(record.evaluation, outcomes);
  touchRecord(record);
  notifyRecordChanged(record);
  scheduleBadge(record.tabId);
}

/**
 * Records arrive over IPC from the panel rather than being built here, so the
 * shape is checked before anything downstream relies on it. This guards
 * against a producer bug poisoning the store or the session snapshot, not
 * against a hostile sender — the message listener already rejects those.
 */
function isMap(value: unknown): boolean {
  // `typeof null === 'object'`, which is exactly the hole a shape check has to close.
  return typeof value === 'object' && value !== null;
}

function isWellFormed(record: RequestRecord): boolean {
  return (
    typeof record.id === 'string' &&
    record.id !== '' &&
    Number.isInteger(record.tabId) &&
    typeof record.url === 'string' &&
    typeof record.host === 'string' &&
    typeof record.method === 'string' &&
    typeof record.resourceType === 'string' &&
    Number.isFinite(record.startedAt) &&
    isMap(record.requestHeaders) &&
    isMap(record.responseHeaders) &&
    isMap(record.query)
  );
}

/**
 * Stores and judges a batch of captured requests. Returns false when the tab
 * is not being recorded, which lets the panel stop sending.
 */
export function ingestRecords(records: readonly RequestRecord[]): boolean {
  const tabId = records[0]?.tabId;
  if (tabId === undefined || !isRecording(tabId)) {
    return false;
  }
  for (const record of records) {
    if (isWellFormed(record)) {
      ingestOne(record);
    } else {
      logger.warn('malformed record rejected at the ingest boundary', record.id);
    }
  }
  return true;
}

function ingestOne(record: RequestRecord): void {
  const config = getConfig();
  if (
    !(
      config.settings.recordUnscoped ||
      isScoped(config, {
        host: record.host,
        url: record.url,
        method: record.method,
        resourceType: record.resourceType,
      })
    )
  ) {
    return;
  }
  addRecord(record);
  publish(record);
}

/** Re-runs the policy over a record whose body arrived after it was stored. */
export function reevaluate(record: RequestRecord): void {
  publish(record);
}

/**
 * A top-level navigation starts a new page. Unless the tab is preserving its
 * log, the previous page's records go with it — the same rule the Network
 * panel follows.
 */
export function notePageLoad(tabId: number, url: string): boolean {
  setTabPage(tabId, url);
  if (shouldPreserveLog(tabId, getConfig().settings.clearOnNavigate)) {
    return false;
  }
  clearTab(tabId);
  return true;
}
