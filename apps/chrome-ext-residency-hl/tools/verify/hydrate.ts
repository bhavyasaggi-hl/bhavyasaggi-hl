/**
 * Round-trips the session snapshot through a second store instance, which is
 * what an evicted service worker does when it comes back.
 *
 * Run with `yarn verify`. It needs its own script because it deliberately loads
 * two copies of the store module, one per worker generation.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, report } from './harness.ts';

let stored: Record<string, unknown> = {};
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    session: {
      get: async () => stored,
      set: async (items: Record<string, unknown>) => {
        stored = { ...stored, ...items };
      },
    },
    local: { get: async () => ({}), set: async () => undefined },
    onChanged: { addListener: () => undefined },
  },
  tabs: { sendMessage: async () => undefined },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  },
  runtime: {
    id: 'test',
    onMessage: { addListener: () => undefined },
    onConnect: { addListener: () => undefined },
  },
};

const storeUrl = pathToFileURL(resolve('src/background/store.ts')).href;
const first = (await import(
  `${storeUrl}?generation=1`
)) as typeof import('../../src/background/store.ts');
type Rec = import('../../src/shared/types.ts').RequestRecord;

await first.ready();
first.setRecording(7, true);
first.setTabPage(7, 'https://app.acme.com/x', 'Acme');
for (let i = 0; i < 5; i += 1) {
  const record: Rec = {
    id: `r${String(i)}`,
    tabId: 7,
    frameId: 0,
    url: `https://eu.api.acme.com/v1/${String(i)}`,
    host: 'eu.api.acme.com',
    registrableDomain: 'acme.com',
    path: `/v1/${String(i)}`,
    query: {},
    // One of the five is a CORS preflight, which is now an ordinary record.
    method: i === 1 ? 'OPTIONS' : 'GET',
    resourceType: i === 1 ? 'preflight' : 'fetch',
    startedAt: i,
    completedAt: i + 1,
    responseTime: 1,
    status: 200,
    requestHeaders: { authorization: 'Bearer super-secret-token' },
    responseHeaders: { 'x-data-region': 'eu-west-1' },
    responseBody: { text: '{"a":1}', size: 7, truncated: false, source: 'devtools' },
    evaluation: {
      verdict: 'pass',
      results: [],
      groups: ['API'],
      evaluatedAt: 0,
      configRevision: 1,
    },
  };
  first.addRecord(record);
}
await new Promise((resolve_) => setTimeout(resolve_, 2000));
const snapshot = String(Object.values(stored)[0] ?? '');
check('snapshot is a string', typeof Object.values(stored)[0], 'string');
// Headers are the bulk of a record and the only place a credential can appear,
// so neither belongs in storage.
check('no credential written to storage', snapshot.includes('super-secret-token'), false);
check('no headers written to storage', snapshot.includes('x-data-region'), false);

// A new worker generation reads what the last one left behind.
const second = (await import(
  `${storeUrl}?generation=2`
)) as typeof import('../../src/background/store.ts');
await second.ready();
const records = second.listRecords(7);
check('records rehydrated', records.length, 5);
check('verdicts survived', records[0]?.evaluation?.verdict, 'pass');
check('headers did not survive', records[0]?.responseHeaders, {});
check('a preflight rehydrates as its own record', records[1]?.resourceType, 'preflight');
check('keeping the method the toolbar filter reads', records[1]?.method, 'OPTIONS');
check('payloads did not', records[0]?.responseBody, undefined);
check('recording state survived', second.isRecording(7), true);
const summary = second.summarizeTab(7, 'host', (id) => id);
check('page url survived', summary.pageUrl, 'https://app.acme.com/x');
check('totals recomputed', [summary.totals.total, summary.totals.pass], [5, 5]);
check('a tab that never recorded stays off', second.isRecording(99), false);

report('hydration checks');
