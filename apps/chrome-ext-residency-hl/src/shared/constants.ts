/** Hard limits that keep the service worker inside MV3 memory and storage budgets. */

/** Maximum number of request records retained per tab (oldest are evicted first). */
export const MAX_RECORDS_PER_TAB = 1500;

/** Maximum number of tabs retained at once (least recently active are evicted first). */
export const MAX_TABS = 20;

/** Longest URL retained; the rest is dropped rather than held per record. */
export const MAX_URL_CHARS = 2048;

/** Maximum number of bytes captured for a single request or response body. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Debounce applied before flushing the in-memory store to `chrome.storage.session`. */
export const PERSIST_DEBOUNCE_MS = 1500;

/**
 * Byte budget for the session snapshot.
 *
 * `chrome.storage.session` allows 10 MB for the whole extension. Persistence
 * exists only so an evicted service worker can pick up where it left off, so it
 * takes a conservative slice and drops whatever does not fit rather than
 * failing the write.
 *
 * A persisted row is a sixth the size of a live record, so this is a sixth of
 * what it was and still holds more requests than before.
 */
export const SESSION_BUDGET_BYTES = 1.5 * 1024 * 1024;

/**
 * Ceiling on captured payloads held in memory across every tab.
 *
 * Without it the worst case is `MAX_BODY_BYTES * MAX_RECORDS_PER_TAB * MAX_TABS`,
 * which is gigabytes. Payloads are dropped oldest first; the records keep their
 * verdicts and metadata.
 */
export const MAX_BODY_BYTES_TOTAL = 24 * 1024 * 1024;

/**
 * Newest records persisted per tab.
 *
 * Matched to `MAX_RECORDS_PER_TAB` so the tab in front of you restores whole;
 * the byte budget, not this, is what binds when many tabs are busy.
 */
export const PERSIST_RECORDS_PER_TAB = 1500;

/** Ceiling on persisted records, which bounds the work a flush can do. */
export const PERSIST_MAX_RECORDS = 6000;

/**
 * `chrome.storage.session` key holding the serialized record store.
 *
 * Bumped with the stored shape: a v1 payload holds whole records and would
 * rehydrate as rows that claim detail they no longer have.
 */
export const SESSION_STORE_KEY = 'residency.store.v2';

/** `chrome.storage.local` key holding the raw user config YAML. */
export const CONFIG_TEXT_KEY = 'residency.config.yaml.v1';
