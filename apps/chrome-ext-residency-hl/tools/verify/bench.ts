/** Throughput of the paths that run per request. */

import { DEFAULT_CONFIG_YAML } from '../../src/config/default-config.ts';
import { parseConfig } from '../../src/config/parse.ts';
import { summarizeDomains, summarizeTotals } from '../../src/engine/aggregate.ts';
import { evaluateRecord } from '../../src/engine/evaluate.ts';
import type { RequestRecord } from '../../src/shared/types.ts';
import { analyze } from '../../src/ui/lib/policy-lint.ts';

const policy = parseConfig(`
name: Bench
ipRanges: { eu: ['52.28.0.0/16'] }
runtime:
  assertions:
    - { name: https, expression: req.url, operator: startsWith, value: 'https://' }
    - { name: ok, expression: res.status, operator: lt, value: '500', severity: warn }
folders:
  - name: API
    match: { hosts: ['*.api.acme.com'], resourceTypes: [fetch] }
    runtime:
      assertions:
        - name: region
          expression: res.headers['x-data-region']
          operator: in
          value: [eu-west-1, eu-central-1]
        - { name: egress, expression: res.ip, operator: inCidr, value: $eu }
        - name: served
          expression: res.headers['x-served-by']
          operator: matches
          value: '^(?:ams|fra|dub)'
`);
const config = { ...policy.config!, revision: 1, source: 'user' as const, loadedAt: 0 };

const headers: Record<string, string> = {
  'content-type': 'application/json',
  'x-data-region': 'eu-west-1',
  'x-served-by': 'fra-1',
  'cache-control': 'no-store',
  'content-length': '4210',
  server: 'nginx',
  date: new Date().toUTCString(),
};
const records: RequestRecord[] = Array.from({ length: 20_000 }, (_, i) => ({
  id: `r${String(i)}`,
  tabId: i % 8,
  frameId: 0,
  url: `https://eu.api.acme.com/v1/resource/${String(i)}`,
  host: 'eu.api.acme.com',
  registrableDomain: 'acme.com',
  path: `/v1/resource/${String(i)}`,
  query: {},
  method: 'GET',
  resourceType: 'fetch',
  startedAt: i,
  completedAt: i + 8,
  responseTime: 8,
  status: 200,
  ip: '52.28.4.9',
  requestHeaders: {},
  responseHeaders: { ...headers },
}));

const time = (label: string, runs: number, fn: () => void): void => {
  fn();
  const started = performance.now();
  fn();
  const ms = performance.now() - started;
  console.log(
    `  ${label.padEnd(38)} ${ms.toFixed(1).padStart(8)} ms   ${Math.round(runs / (ms / 1000)).toLocaleString()} /s`,
  );
};

console.log('\nper-request paths (20,000 records, 5 assertions each)');
time('evaluate', records.length, () => {
  for (const record of records) {
    record.evaluation = evaluateRecord(record, config);
  }
});
time('summarizeDomains', records.length, () => void summarizeDomains(records, 'host', (id) => id));
time('summarizeTotals', records.length, () => void summarizeTotals(records));

console.log('\npolicy paths');
time('parseConfig (starter policy)', 1, () => void parseConfig(DEFAULT_CONFIG_YAML));
time(
  'analyze (starter policy, cold)',
  1,
  () => void analyze(`${DEFAULT_CONFIG_YAML}\n# ${String(Math.random())}`),
);

const big = `name: big\nruntime:\n  assertions:\n${Array.from(
  { length: 500 },
  (_, i) => `    - { name: a${String(i)}, expression: res.status, operator: lt, value: '400' }`,
).join('\n')}\n`;
time('analyze (500-assertion policy)', 1, () => void analyze(`${big}# ${String(Math.random())}`));

// ---------- HAR entry -> record mapping (once per finished request) ----------
const { toRecord } = await import('../../src/devtools/har.ts');
type HarE = import('../../src/devtools/har.ts').HarEntry;

const harHeaders = Array.from({ length: 14 }, (_, i) => ({
  name: `X-Header-${String(i)}`,
  value: 'v'.repeat(40),
}));
const entry = {
  startedDateTime: '2026-09-22T10:00:00.000Z',
  time: 42,
  serverIPAddress: '52.28.4.9',
  _resourceType: 'fetch',
  _initiator: { url: 'https://app.acme.com/' },
  request: {
    method: 'POST',
    url: 'https://eu.api.acme.com/v1/contacts?page=2&filter=active',
    headers: harHeaders,
    postData: { mimeType: 'application/json', text: '{"a":1}' },
  },
  response: {
    status: 200,
    statusText: 'OK',
    headers: harHeaders,
    content: { mimeType: 'application/json', size: 412 },
  },
} as unknown as HarE;

console.log('\ncapture path (what runs per finished request)');
time('toRecord (HAR entry -> record)', 20_000, () => {
  for (let i = 0; i < 20_000; i += 1) {
    toRecord(entry, `h${String(i)}`, 7);
  }
});
time('toRecord + evaluate', 20_000, () => {
  for (let i = 0; i < 20_000; i += 1) {
    const record = toRecord(entry, `h${String(i)}`, 7);
    record.evaluation = evaluateRecord(record, config);
  }
});
