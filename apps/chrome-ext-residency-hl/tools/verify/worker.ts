/**
 * Verifies the service worker: recording, persistence, retention, the UI port
 * and the DevTools lifecycle.
 *
 * Run with `yarn verify`. Every module is the shipped one, driven against the
 * stubbed `chrome` in `harness.ts`.
 */

import { check, installChrome, makePort, report, section, settle } from './harness.ts';

const stub = installChrome();

const { initConfig, getConfig } = await import('../../src/background/config-store.ts');
const { evaluateRecord } = await import('../../src/engine/evaluate.ts');
const { reduceRecord, scheduleSweep, sweep } = await import('../../src/background/reduce.ts');
const { toLite } = await import('../../src/background/lite.ts');
const { registerPanelStream, notifyRecordChanged } = await import('../../src/background/stream.ts');
const { registerDevtoolsLink, notifyCaptureState } = await import(
  '../../src/background/devtools-link.ts'
);
const ingest = await import('../../src/background/ingest.ts');
const store = await import('../../src/background/store.ts');
const consts = await import('../../src/shared/constants.ts');
const { UI_PORT, DEVTOOLS_PORT } = await import('../../src/shared/messages.ts');
type Rec = import('../../src/shared/types.ts').RequestRecord;

const rec = (over: Partial<Rec>): Rec => ({
  id: 'x',
  tabId: 1,
  frameId: 0,
  url: 'https://eu.api.example.com/v1/contacts',
  host: 'eu.api.example.com',
  registrableDomain: 'example.com',
  path: '/v1/contacts',
  query: {},
  method: 'GET',
  resourceType: 'fetch',
  startedAt: 1000,
  completedAt: 1010,
  responseTime: 10,
  status: 200,
  requestHeaders: {},
  responseHeaders: {},
  ...over,
});

await initConfig();
await store.ready();
registerPanelStream();
registerDevtoolsLink();

section('recording is opt-in');
await store.ready();
check('a fresh tab is not recorded', store.isRecording(4242), false);
store.setRecording(4242, true);
check('turning it on records that tab', store.isRecording(4242), true);
check('and only that tab', store.isRecording(4243), false);
store.setRecording(4242, false);
check('turning it off stops it', store.isRecording(4242), false);
store.setRecordByDefault(true);
check('recordByDefault opts a new tab in', store.isRecording(9001), true);
store.setRecordByDefault(false);

section('persistence budget');
const bigBody = 'x'.repeat(60_000);
const headers: Record<string, string> = {};
for (let i = 0; i < 40; i += 1) {
  headers[`x-header-${String(i)}`] = 'v'.repeat(120);
}
let made = 0;
for (let tab = 0; tab < 12; tab += 1) {
  for (let n = 0; n < 900; n += 1) {
    made += 1;
    store.addRecord({
      ...rec({}),
      id: `p${String(made)}`,
      tabId: tab,
      startedAt: n,
      url: `https://eu.api.acme.com/v1/resource/${String(n)}?q=${'p'.repeat(200)}`,
      requestHeaders: { ...headers },
      responseHeaders: { ...headers },
      responseBody: { text: bigBody, size: bigBody.length, truncated: false, source: 'devtools' },
      requestBody: { text: bigBody, size: bigBody.length, truncated: false, source: 'devtools' },
    });
  }
}
const before = store.listRecords(0).length;
await settle(2200);
const bytes = stub.written()?.length ?? 0;
console.log(
  `     snapshot ${String(Math.round(bytes / 1024))} KB of a ${String(consts.SESSION_BUDGET_BYTES / 1024 / 1024)} MB quota`,
);
check('snapshot within budget', bytes > 0 && bytes <= consts.SESSION_BUDGET_BYTES, true);
check('no payloads persisted', stub.written()?.includes(bigBody.slice(0, 200)) ?? true, false);
check('memory untouched by the write', store.listRecords(0).length, before);
let bodyBytes = 0;
for (let tab = 0; tab < 12; tab += 1) {
  for (const record of store.listRecords(tab)) {
    bodyBytes += (record.requestBody?.text.length ?? 0) + (record.responseBody?.text.length ?? 0);
  }
}
console.log(
  `     payloads held ${String(Math.round(bodyBytes / 1024 / 1024))} MB, uncapped would be ${String(Math.round((made * 2 * bigBody.length) / 1024 / 1024))} MB`,
);
check('payloads trimmed to budget', bodyBytes <= consts.MAX_BODY_BYTES_TOTAL, true);
check('newest payloads kept', store.listRecords(11).at(-1)?.responseBody !== undefined, true);

section('persisted rows carry no headers');
store.addRecord({
  ...rec({ id: 'secret', tabId: 78 }),
  requestHeaders: { authorization: 'Bearer super-secret-token' },
  responseHeaders: { 'x-data-region': 'eu-west-1' },
});
await settle(2200);
check(
  'no credential reaches storage',
  stub.written()?.includes('super-secret-token') ?? true,
  false,
);
check('no headers reach storage', stub.written()?.includes('x-data-region') ?? true, false);
check('the row itself does', stub.written()?.includes('"secret"') ?? false, true);

section('batched ingest');
store.setRecording(31, true);
const batch = [1, 2, 3].map((n) => ({ ...rec({}), id: `b${String(n)}`, tabId: 31, startedAt: n }));
check('a batch is accepted in one call', ingest.ingestRecords(batch), true);
check('every record in the batch landed', store.listRecords(31).length, 3);
store.setRecording(31, false);
check('a batch for a paused tab is refused', ingest.ingestRecords(batch), false);
check('an empty batch is refused', ingest.ingestRecords([]), false);

section('capture boundary hardening');
store.setRecording(41, true);
const malformed = [
  { ...rec({}), id: '', tabId: 41 },
  { ...rec({}), id: 'ok-shape', tabId: 41, startedAt: Number.NaN },
  {
    ...rec({}),
    id: 'no-headers',
    tabId: 41,
    responseHeaders: null as unknown as Record<string, string>,
  },
];
ingest.ingestRecords(malformed);
check('malformed records are rejected', store.listRecords(41).length, 0);
ingest.ingestRecords([{ ...rec({}), id: 'good', tabId: 41 }]);
check('a well-formed record still lands', store.listRecords(41).length, 1);
store.setRecording(41, false);

section('retention');
{
  await initConfig();
  await store.ready();

  // A token that appears nowhere in the policy, so it is an honest canary.
  const bodyText = '{"meta":{"residency":"eu"},"marker":"payload-canary-9f3a"}';
  const make = (id: string, startedAt: number): Rec => ({
    id,
    tabId: 3,
    frameId: 0,
    url: 'https://eu.api.example.com/v1/contacts?page=3&token=abc',
    host: 'eu.api.example.com',
    registrableDomain: 'example.com',
    path: '/v1/contacts',
    query: { page: '3', token: 'abc' },
    method: 'GET',
    resourceType: 'fetch',
    startedAt,
    completedAt: startedAt + 41,
    responseTime: 41,
    status: 200,
    statusLine: 'OK',
    ip: '52.28.4.9',
    protocol: 'https',
    fromCache: false,
    responseSize: 4096,
    requestHeaders: { authorization: 'Bearer super-secret-token', accept: 'application/json' },
    responseHeaders: { 'x-data-region': 'eu-west-1', 'x-served-by': 'fra-1' },
    responseBody: { text: bodyText, size: bodyText.length, truncated: false, source: 'devtools' },
  });

  // Evaluation happens on arrival, against the full observation.
  const record = make('r1', 1000);
  record.evaluation = evaluateRecord(record, getConfig());
  const verdict = record.evaluation.verdict;
  const detail = record.evaluation.results.map((result) => result.detail);
  check('the policy judged the request', verdict, 'pass');
  check(
    'and it read real values',
    record.evaluation.results.some((r) => r.actual.includes('eu-west-1')),
    true,
  );

  reduceRecord(record);
  check('the verdict is kept', record.evaluation?.verdict, verdict);
  check(
    'so is what each assertion observed',
    record.evaluation?.results.map((r) => r.detail),
    detail,
  );
  check('request headers are released', record.requestHeaders, {});
  check('response headers are released', record.responseHeaders, {});
  check('query is released', record.query, {});
  check('the response payload is released', record.responseBody, undefined);
  check(
    'the row keeps what it renders',
    [record.status, record.ip, record.responseSize, record.responseTime, record.protocol],
    [200, '52.28.4.9', 4096, 41, 'https'],
  );

  // A reduced record is ~a seventh of a live one.
  const live = make('r2', 1000);
  live.evaluation = evaluateRecord(live, getConfig());
  const liveBytes = JSON.stringify(live).length;
  const reducedBytes = JSON.stringify(record).length;
  console.log(
    `     live ${String(liveBytes)} B -> reduced ${String(reducedBytes)} B (${String(Math.round((liveBytes / reducedBytes) * 10) / 10)}x)`,
  );
  // Headers here are two short ones; a real request carries ~2 KB of them, so
  // this only has to show the direction, not the production ratio.
  check('reduction is a real saving', reducedBytes < liveBytes, true);

  // The sweep respects the retention window, which has to clear a preflight fold.
  store.setRecording(3, true);
  const fresh = make('fresh', Date.now());
  fresh.evaluation = evaluateRecord(fresh, getConfig());
  const stale = make('stale', Date.now() - 20_000);
  store.addRecord(fresh);
  store.addRecord(stale);
  // The store already holds the persistence section's records, so the count is
  // not fixed; what matters is which of these two it touched.
  const first = sweep();
  check('the sweep released something', first.reduced > 0, true);
  check('the fresh one still has its headers', Object.keys(fresh.responseHeaders).length, 2);
  check('the stale one does not', Object.keys(stale.responseHeaders).length, 0);
  check(
    'and it reports when the next one is due',
    first.nextDueIn !== null && first.nextDueIn > 0,
    true,
  );
  check('a second sweep has nothing to release', sweep().reduced, 0);

  // Nothing is on a clock once everything has been released: the timer is armed
  // by capture, not by a ticking interval.
  reduceRecord(fresh);
  check('and nothing is left pending', sweep().nextDueIn, null);
  scheduleSweep();
  check('scheduling with nothing to do is harmless', sweep().reduced, 0);

  // Nothing observation-shaped reaches a page or storage.
  const lite = toLite(fresh) as Record<string, unknown>;
  check('the wire format has no headers', 'responseHeaders' in lite, false);
  check('the wire format has no payload', 'responseBody' in lite, false);
  check('the wire format has no query', 'query' in lite, false);
  check(
    'the wire format keeps the verdict',
    (lite['evaluation'] as { verdict: string } | undefined)?.verdict,
    'pass',
  );

  await settle(2200);
  check(
    'no credential reaches storage',
    stub.written()?.includes('super-secret-token') ?? true,
    false,
  );
  check(
    'no payload reaches storage',
    stub.written()?.includes('payload-canary-9f3a') ?? true,
    false,
  );
  check('the row does', stub.written()?.includes('"fresh"') ?? false, true);
}

section('ui port');
{
  await initConfig();
  await store.ready();
  registerPanelStream();

  const record = (id: string): Rec => ({
    id,
    tabId: 12,
    frameId: 0,
    url: 'https://eu.api.example.com/v1/a',
    host: 'eu.api.example.com',
    registrableDomain: 'example.com',
    path: '/v1/a',
    query: {},
    method: 'GET',
    resourceType: 'fetch',
    startedAt: Date.now(),
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
  });

  store.setRecording(12, true);
  store.addRecord(record('a1'));

  // The panel subscribes for records.
  const panel = makePort(UI_PORT);
  stub.connect(panel);
  panel.deliver({ type: 'subscribe', tabId: 12, records: true });
  await settle();
  check('the panel is sent a snapshot', panel.sent.at(-1)?.['type'], 'snapshot');
  const snapshot = panel.sent.at(-1) ?? {};
  check('with the records in it', (snapshot['records'] as unknown[] | undefined)?.length, 1);
  check('and the policy to join them against', typeof snapshot['policy'], 'object');

  // The popup subscribes for totals only and must never receive a record.
  const popup = makePort(UI_PORT);
  stub.connect(popup);
  popup.deliver({ type: 'subscribe', tabId: 12, records: false });
  await settle();
  check('the popup is sent state, not a snapshot', popup.sent.at(-1)?.['type'], 'state');
  const totals = popup.sent.at(-1)?.['tab'] as { totals: { total: number } } | undefined;
  check('with the totals it renders', totals?.totals.total, 1);

  // A new request reaches both, each in its own shape.
  const panelBefore = panel.sent.length;
  const popupBefore = popup.sent.length;
  store.addRecord(record('a2'));
  notifyRecordChanged(store.listRecords(12).at(-1)!);
  await settle();
  const panelPush = panel.sent.slice(panelBefore);
  const popupPush = popup.sent.slice(popupBefore);
  check(
    'the panel gets the record',
    panelPush.some((m) => m['type'] === 'upsert'),
    true,
  );
  check(
    'the popup does not',
    popupPush.some((m) => m['type'] === 'upsert'),
    false,
  );
  check(
    'but the popup does get new totals',
    popupPush.some((m) => m['type'] === 'state'),
    true,
  );
  check(
    'and no message to the popup carries a record',
    popup.sent.every((m) => !('records' in m) || (m['records'] as unknown[]).length === 0),
    true,
  );

  // One page acting on the tab updates every page watching it.
  const popupMark = popup.sent.length;
  panel.deliver({ type: 'setRecording', recording: false });
  await settle();
  check(
    'the popup sees the panel stop the recording',
    (popup.sent.slice(popupMark).at(-1)?.['tab'] as { recording: boolean } | undefined)?.recording,
    false,
  );

  // A port that is not ours is ignored.
  const foreign = makePort('someone-else');
  stub.connect(foreign);
  foreign.deliver({ type: 'subscribe', tabId: 12, records: true });
  await settle();
  check('a foreign port gets nothing', foreign.sent.length, 0);
}

section('devtools lifecycle');
{
  await initConfig();
  await store.ready();
  registerDevtoolsLink();

  // A port that is not ours is ignored outright.
  const foreign = makePort('something-else');
  stub.connect(foreign);
  foreign.deliver({ type: 'attach', tabId: 1 });
  await settle();
  check('a foreign port is ignored', foreign.sent.length, 0);

  // The popup can arm a tab before DevTools exists.
  store.setRecording(5, true);
  check('arming works with devtools closed', store.isRecording(5), true);
  check(
    'but the tab knows nothing is attached',
    store.summarizeTab(5, 'host', (id) => id).devtoolsAttached,
    false,
  );

  // Opening DevTools attaches, and the arming takes effect immediately.
  const port = makePort(DEVTOOLS_PORT);
  stub.connect(port);
  port.deliver({ type: 'attach', tabId: 5 });
  await settle();
  check(
    'attaching is visible to the popup',
    store.summarizeTab(5, 'host', (id) => id).devtoolsAttached,
    true,
  );
  check('and the page is told to capture', port.sent.at(-1), {
    type: 'capture',
    recording: true,
    needsBodies: false,
    debug: false,
  });

  // Closing DevTools stops the recording: nothing can capture any more.
  port.drop();
  await settle();
  check(
    'closing devtools detaches',
    store.summarizeTab(5, 'host', (id) => id).devtoolsAttached,
    false,
  );
  check('and stops the recording', store.isRecording(5), false);

  // A second window on the same tab replaces the first rather than doubling up.
  const first = makePort(DEVTOOLS_PORT);
  stub.connect(first);
  first.deliver({ type: 'attach', tabId: 6 });
  await settle();
  const second = makePort(DEVTOOLS_PORT);
  stub.connect(second);
  second.deliver({ type: 'attach', tabId: 6 });
  await settle();
  check(
    'the newest port is the live one',
    store.summarizeTab(6, 'host', (id) => id).devtoolsAttached,
    true,
  );
  const staleCount = first.sent.length;
  const liveCount = second.sent.length;
  store.setRecording(6, true);
  notifyCaptureState(6);
  await settle();
  check('the live port hears about it', second.sent.length > liveCount, true);
  check('the replaced one does not', first.sent.length, staleCount);
}

report('worker checks');
