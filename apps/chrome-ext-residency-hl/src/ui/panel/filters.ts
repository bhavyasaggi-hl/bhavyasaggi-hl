/** Facet definitions and the predicate that drives the request list. */

import type { LiteRecord, PolicyIndex } from '../../shared/types.ts';

export const ALL = 'all';

export const VERDICT_FACETS: readonly { readonly value: string; readonly label: string }[] = [
  { value: ALL, label: 'All' },
  { value: 'fail', label: 'Failing' },
  { value: 'pass', label: 'Passing' },
  { value: 'not-applicable', label: 'Unscoped' },
];

export const TYPE_FACETS: readonly { readonly value: string; readonly label: string }[] = [
  { value: ALL, label: 'All' },
  { value: 'xhr', label: 'Fetch/XHR' },
  { value: 'doc', label: 'Doc' },
  { value: 'js', label: 'JS' },
  { value: 'css', label: 'CSS' },
  { value: 'img', label: 'Img' },
  { value: 'media', label: 'Media' },
  { value: 'font', label: 'Font' },
  { value: 'other', label: 'Other' },
];

/** DevTools resource types, grouped the way the Network panel groups them. */
const TYPE_BUCKETS: Readonly<Record<string, string>> = {
  document: 'doc',
  fetch: 'xhr',
  xhr: 'xhr',
  websocket: 'xhr',
  eventsource: 'xhr',
  preflight: 'xhr',
  script: 'js',
  stylesheet: 'css',
  image: 'img',
  media: 'media',
  font: 'font',
  manifest: 'other',
  ping: 'other',
};

/**
 * Preflights whose request never appeared.
 *
 * The browser sends an `OPTIONS` because a real request is about to follow, so
 * a preflight with nothing behind it has two causes: the preflight was refused,
 * or the request it authorised was made where this extension cannot see it —
 * an extension that replaces `fetch`/`XMLHttpRequest` re-issues calls from its
 * own context, which `chrome.devtools.network` does not report. A handful is
 * ordinary; a great many is the second case. Either way, counting them is the
 * difference between a confusing gap and a known one.
 */
export function orphanPreflights(records: readonly LiteRecord[]): number {
  const answered = new Set<string>();
  for (const record of records) {
    if (record.resourceType !== 'preflight') {
      answered.add(record.url);
    }
  }
  let orphans = 0;
  for (const record of records) {
    if (record.resourceType === 'preflight' && !answered.has(record.url)) {
      orphans += 1;
    }
  }
  return orphans;
}

export function bucketOf(record: LiteRecord): string {
  return TYPE_BUCKETS[record.resourceType] ?? 'other';
}

/** Response size, read at capture time and kept as a number. */
export function sizeOf(record: LiteRecord): number | undefined {
  return record.responseSize;
}

export function statusText(record: LiteRecord): string {
  if (record.error !== undefined) {
    return record.error.replace('net::', '');
  }
  return record.status === undefined ? '…' : String(record.status);
}

function haystack(record: LiteRecord, policy: PolicyIndex): string {
  const assertions = (record.evaluation?.results ?? [])
    .map((result) => {
      const definition = policy[result.id];
      return `${definition?.name ?? result.id} ${definition?.expression ?? ''} ${result.detail}`;
    })
    .join(' ');
  return `${record.method} ${record.url} ${record.status ?? ''} ${record.ip ?? ''} ${assertions}`.toLowerCase();
}

export interface Filters {
  readonly host: string;
  readonly verdict: string;
  readonly type: string;
  readonly search: string;
  /** CORS preflights are their own rows, hidden unless this is on. */
  readonly showPreflights: boolean;
}

export function matches(record: LiteRecord, filters: Filters, policy: PolicyIndex): boolean {
  if (!filters.showPreflights && record.resourceType === 'preflight') {
    return false;
  }
  if (
    filters.host !== ALL &&
    record.host !== filters.host &&
    record.registrableDomain !== filters.host
  ) {
    return false;
  }
  if (filters.verdict !== ALL && (record.evaluation?.verdict ?? 'pending') !== filters.verdict) {
    return false;
  }
  if (filters.type !== ALL && bucketOf(record) !== filters.type) {
    return false;
  }
  return filters.search === '' || haystack(record, policy).includes(filters.search);
}
