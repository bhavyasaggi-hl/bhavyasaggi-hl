/** Action badge showing the failing-request count for the active tab. */

import { getConfig } from './config-store.ts';
import { isRecording, listRecords } from './store.ts';

const COLOR_FAIL = '#c0392b';
const COLOR_OK = '#1e7b4f';

function countsFor(tabId: number): { readonly fail: number; readonly judged: number } {
  let fail = 0;
  let judged = 0;
  for (const record of listRecords(tabId)) {
    const verdict = record.evaluation?.verdict;
    if (verdict === 'fail') {
      fail += 1;
      judged += 1;
    } else if (verdict === 'pass') {
      judged += 1;
    }
  }
  return { fail, judged };
}

/**
 * Coalescing window for badge writes.
 *
 * A page load finalizes hundreds of requests, and each badge update is three
 * `chrome.action` round trips. Writing once per burst keeps that off the hot
 * path without the count ever looking stale to a user.
 */
const BADGE_DEBOUNCE_MS = 250;

const pending = new Map<number, ReturnType<typeof setTimeout>>();

/** Queues a badge refresh for `tabId`, collapsing bursts into one write. */
export function scheduleBadge(tabId: number): void {
  if (tabId < 0 || pending.has(tabId)) {
    return;
  }
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      void refreshBadge(tabId);
    }, BADGE_DEBOUNCE_MS),
  );
}

/** Refreshes the badge for one tab; silently ignores tabs that no longer exist. */
export async function refreshBadge(tabId: number): Promise<void> {
  if (tabId < 0) {
    return;
  }
  if (!isRecording(tabId)) {
    try {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({
        tabId,
        title: `${getConfig().name} — not recording this tab`,
      });
    } catch {
      // The tab was closed between the capture and the badge update.
    }
    return;
  }
  const { fail, judged } = countsFor(tabId);
  const text = fail > 0 ? String(fail) : judged > 0 ? '✓' : '';
  const color = fail > 0 ? COLOR_FAIL : COLOR_OK;
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setTitle({
      tabId,
      title:
        judged === 0
          ? `${getConfig().name} — nothing evaluated yet`
          : `${getConfig().name} — ${fail} failing of ${judged} evaluated`,
    });
  } catch {
    // The tab was closed between the capture and the badge update.
  }
}
