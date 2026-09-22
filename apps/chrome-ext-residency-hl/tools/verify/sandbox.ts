/**
 * Drives the sandboxed test runner directly, without a browser.
 *
 * `src/sandbox/main.ts` only needs `addEventListener`, `parent.postMessage` and
 * `new Function`, so Node can stand in for the frame. What this cannot cover is
 * the frame itself — the opaque origin, the CSP and a wedged script — which is
 * why those are verified against a real Chrome and recorded in verification.md.
 */

import type { TestOutcome } from '../../src/shared/types.ts';
import { check, report, section } from './harness.ts';

type Listener = (event: { data: unknown }) => void;

let onMessage: Listener | null = null;
const sent: { id: number; results: { recordId: string; outcomes: TestOutcome[] }[] }[] = [];

(globalThis as unknown as { addEventListener: unknown }).addEventListener = (
  kind: string,
  fn: Listener,
) => {
  if (kind === 'message') {
    onMessage = fn;
  }
};
(globalThis as unknown as { parent: unknown }).parent = {
  postMessage: (message: unknown) => {
    const payload = message as { type: string };
    if (payload.type === 'result') {
      sent.push(message as (typeof sent)[number]);
    }
  },
};

await import('../../src/sandbox/main.ts');

const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

const context = (tenant: string): Record<string, unknown> => ({
  req: {
    url: 'https://eu.api.acme.com/v1/contacts',
    method: 'GET',
    headers: { authorization: `Bearer ${jwt({ tenant, region: 'eu-west-1' })}` },
  },
  res: { status: 200, headers: { 'x-data-region': 'eu-west-1' }, body: { residency: 'eu' } },
});

let batchId = 0;
function run(
  items: {
    recordId: string;
    scripts: { id: string; code: string }[];
    context: Record<string, unknown>;
  }[],
) {
  batchId += 1;
  sent.length = 0;
  onMessage?.({ data: { type: 'run', id: batchId, items } });
  return sent.at(-1);
}

section('the worked example: decode an Authorization header');
const AUTH = `
test("request is authenticated", function () {
  expect(req.headers).to.have.property('authorization');
  expect(req.headers['authorization']).to.match(/^Bearer /);
});
test("token is scoped to the EU tenant", function () {
  const claims = JSON.parse(atob(req.headers['authorization'].slice('Bearer '.length).split('.')[1]));
  expect(claims).to.have.property('tenant', 'acme-eu');
});`;

const authed = run([
  { recordId: 'a', scripts: [{ id: 's0', code: AUTH }], context: context('acme-eu') },
]);
check(
  'both tests pass for the right tenant',
  authed?.results[0]?.outcomes.map((o) => o.passed),
  [true, true],
);

const wrong = run([
  { recordId: 'a', scripts: [{ id: 's0', code: AUTH }], context: context('acme-us') },
]);
check(
  'the wrong tenant fails the second test',
  wrong?.results[0]?.outcomes.map((o) => o.passed),
  [true, false],
);
check(
  'and chai says which value it got',
  wrong?.results[0]?.outcomes[1]?.error?.includes("but got 'acme-us'"),
  true,
);

section('bodies, which no fixed operator set could cover');
const body = run([
  {
    recordId: 'b',
    context: context('acme-eu'),
    scripts: [
      {
        id: 's1',
        code: `test("body declares residency", function () { expect(res.body).to.have.property('residency', 'eu'); });`,
      },
    ],
  },
]);
check('a response body assertion runs', body?.results[0]?.outcomes[0]?.passed, true);

section('a batch is answered per record');
const batch = run([
  { recordId: 'r1', scripts: [{ id: 's0', code: AUTH }], context: context('acme-eu') },
  { recordId: 'r2', scripts: [{ id: 's0', code: AUTH }], context: context('acme-us') },
  { recordId: 'r3', scripts: [{ id: 's0', code: AUTH }], context: context('acme-eu') },
]);
check('every record in the batch gets a result', batch?.results.length, 3);
check(
  'and they are keyed by record id',
  batch?.results.map((r) => r.recordId),
  ['r1', 'r2', 'r3'],
);
check(
  'each judged on its own context',
  batch?.results.map((r) => r.outcomes.every((o) => o.passed)),
  [true, false, true],
);

section('a script that misbehaves is contained');
const broke = run([
  { recordId: 'c', context: context('acme-eu'), scripts: [{ id: 's2', code: 'nope.boom();' }] },
]);
check(
  'a throw outside a test is reported',
  broke?.results[0]?.outcomes[0]?.name,
  'script did not run',
);
check('with the reason', broke?.results[0]?.outcomes[0]?.error, 'nope is not defined');

const flood = run([
  {
    recordId: 'd',
    context: context('acme-eu'),
    scripts: [
      { id: 's3', code: 'for (let i = 0; i < 5000; i += 1) { test("t" + i, function () {}); }' },
    ],
  },
]);
check('a script cannot register unbounded tests', flood?.results[0]?.outcomes.length, 200);

section('compiled once, not per record');
const SAME = `test("cheap", function () { expect(res.status).to.equal(200); });`;
const many = Array.from({ length: 200 }, (_, i) => ({
  recordId: `m${String(i)}`,
  scripts: [{ id: 's4', code: SAME }],
  context: context('acme-eu'),
}));
const started = performance.now();
const bulk = run(many);
const ms = performance.now() - started;
check('200 records in one batch all answered', bulk?.results.length, 200);
check(
  'all passing',
  bulk?.results.every((r) => r.outcomes[0]?.passed),
  true,
);
console.log(`     200 records in ${ms.toFixed(1)} ms (${((ms / 200) * 1000).toFixed(1)} µs each)`);
check('a page load of scripts stays well under a frame', ms < 200, true);

report('sandbox checks');
