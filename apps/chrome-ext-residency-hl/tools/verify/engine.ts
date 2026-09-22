/**
 * Verifies the pure layers: policy parsing, evaluation, aggregation, the editor
 * diagnostics, the AI draft serializer and the ReDoS screen.
 *
 * Run with `yarn verify`. Nothing here touches the browser.
 */

import { installChrome } from './harness.ts';

// Imported for its side effect: the modules below read `chrome` at import time.
installChrome();

const { check, report, section } = await import('./harness.ts');
const { parseConfig } = await import('../../src/config/parse.ts');
const { DEFAULT_CONFIG_YAML } = await import('../../src/config/default-config.ts');
const { evaluateRecord, scriptsFor, withTests } = await import('../../src/engine/evaluate.ts');
const { buildContext, resolveExpression } = await import('../../src/engine/expression.ts');
const { ipInCidr, parseCidr } = await import('../../src/engine/ip.ts');
const { summarizeDomains, summarizeTotals } = await import('../../src/engine/aggregate.ts');
const { OPERATOR_NAMES } = await import('../../src/engine/operators.ts');
const { catastrophicRisk } = await import('../../src/engine/regex-safety.ts');
const { draftToYaml, POLICY_SCHEMA, PRESETS, systemPrompt } = await import(
  '../../src/ui/policy-reference.ts'
);
const { analyze, formatPolicy } = await import('../../src/ui/lib/policy-lint.ts');
const { matches, orphanPreflights } = await import('../../src/ui/panel/filters.ts');
type LiteRecord = import('../../src/shared/types.ts').LiteRecord;
type Rec = import('../../src/shared/types.ts').RequestRecord;

section('policy + engine');
const base = parseConfig(DEFAULT_CONFIG_YAML);
check('starter policy parses', base.errors, []);
check(
  'starter groups',
  base.config?.groups.map((g) => g.name),
  ['Every request', 'First-party API (example)'],
);

const policy = parseConfig(`
info: { name: EU }
items:
  - info: { name: Global, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - { description: HTTPS, expression: req.url, operator: startsWith, value: 'https://' }
  - info: { name: API, type: http }
    http: { url: '*.api.acme.com' }
    runtime:
      assertions:
        - { description: Region, expression: "res.headers['x-data-region']", operator: in, value: 'eu-west-1, eu-central-1' }
        - { description: Egress, expression: res.ip, operator: inCidr, value: '52.28.0.0/16, 2a05:d000::/29' }
        - { description: Fast, expression: res.responseTime, operator: lt, value: '2000' }
`);
check('policy parses', policy.errors, []);
const config = { ...policy.config!, revision: 1, source: 'user' as const, loadedAt: 0 };

const rec = (over: Partial<Rec>): Rec => ({
  id: 'x',
  tabId: 1,
  frameId: 0,
  url: 'https://eu.api.acme.com/v1/contacts',
  host: 'eu.api.acme.com',
  registrableDomain: 'acme.com',
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

const pass = rec({ responseHeaders: { 'x-data-region': 'eu-west-1' }, ip: '52.28.4.9' });
check('pass verdict', evaluateRecord(pass, config).verdict, 'pass');
check(
  'fail verdict',
  evaluateRecord(
    rec({ id: 'y', responseHeaders: { 'x-data-region': 'us-east-1' }, ip: '3.4.5.6' }),
    config,
  ).verdict,
  'fail',
);
// OpenCollection's Assertion has no severity, so there is no advisory tier:
// anything that fails, fails.
check(
  'a slow response fails rather than warning',
  evaluateRecord(
    rec({
      id: 'w',
      responseHeaders: { 'x-data-region': 'eu-west-1' },
      ip: '52.28.1.1',
      responseTime: 9000,
    }),
    config,
  ).verdict,
  'fail',
);
check(
  'unscoped gets only globals',
  evaluateRecord(rec({ id: 'z', url: 'https://cdn.other.com/a.js', host: 'cdn.other.com' }), config)
    .results.length,
  1,
);
check(
  'http fails the global',
  evaluateRecord(rec({ id: 'h', url: 'http://cdn.other.com/a.js', host: 'cdn.other.com' }), config)
    .verdict,
  'fail',
);

const ctx = buildContext(pass);
check(
  'header lookup is case-insensitive',
  resolveExpression("res.headers['X-Data-Region']", ctx),
  'eu-west-1',
);
check('missing path is undefined', resolveExpression('res.body.meta.missing.deep', ctx), undefined);
check('ipv4 in cidr', ipInCidr('52.28.255.1', parseCidr('52.28.0.0/16')!), true);
check('ipv6 in cidr', ipInCidr('2a05:d007::1', parseCidr('2a05:d000::/29')!), true);
check('ipv6 outside cidr', ipInCidr('2a05:d018::1', parseCidr('2a05:d000::/29')!), false);
check('mixed family never matches', ipInCidr('1.2.3.4', parseCidr('2a05:d000::/29')!), false);

// With no global assertions nothing judges an out-of-scope host, so it must not
// land in the denominator.
const scopedOnly = parseConfig(`
info: { name: Scoped only }
items:
  - info: { name: API, type: http }
    http: { url: '*.api.acme.com' }
    runtime:
      assertions:
        - { description: Region, expression: "res.headers['x-data-region']", operator: isNotEmpty }
`);
const scopedConfig = { ...scopedOnly.config!, revision: 1, source: 'user' as const, loadedAt: 0 };
const summarised = [
  pass,
  rec({ id: 'q', url: 'https://cdn.other.com/a.js', host: 'cdn.other.com' }),
].map((r) => ({ ...r, evaluation: evaluateRecord(r, scopedConfig) }));
const unscoped = summarizeDomains(summarised, 'host', (id) => id).find(
  (d) => d.host === 'cdn.other.com',
);
check('out-of-scope host is not judged', unscoped?.passRate, null);
check('out-of-scope host is counted as unscoped', unscoped?.notApplicable, 1);
check(
  'scoped host still judged',
  summarizeDomains(summarised, 'host', (id) => id).find((d) => d.host === 'eu.api.acme.com')
    ?.passRate,
  1,
);

section('AI draft');
const yaml = draftToYaml({
  name: 'Draft',
  items: [
    {
      name: 'Global',
      url: '*',
      assertions: [
        { description: 'HTTPS', expression: 'req.url', operator: 'startsWith', value: 'https://' },
      ],
    },
    {
      name: 'API',
      url: '*.api.acme.com',
      tags: ['fetch', 'xhr'],
      assertions: [
        {
          description: 'Region',
          expression: "res.headers['x-data-region']",
          operator: 'in',
          value: 'eu-west-1, eu-central-1',
        },
        { description: 'Fast', expression: 'res.responseTime', operator: 'lt', value: '2000' },
      ],
    },
  ],
});
const round = parseConfig(yaml);
check('AI draft round-trips', round.errors, []);
check('with no unknown keys', round.warnings, []);
check('comma list split', round.config?.groups[1]?.assertions[0]?.expectedList, [
  'eu-west-1',
  'eu-central-1',
]);
check(
  'tags become the resource-type scope',
  [...(round.config?.groups[1]?.scope[0]?.resourceTypes ?? [])],
  ['fetch', 'xhr'],
);
const ops = (
  POLICY_SCHEMA.properties.items.items.properties.assertions.items.properties.operator as {
    enum: readonly string[];
  }
).enum;
check('schema enum matches the engine', [...ops].sort(), [...OPERATOR_NAMES].sort());
check(
  'prompt names every operator',
  OPERATOR_NAMES.every((o) => systemPrompt().includes(o)),
  true,
);
check('presets present', PRESETS.length >= 3, true);

section('editor diagnostics');
const broken = `
info: { name: Broken }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - { description: bad, expression: res.status, operator: isInEurope, value: yes }
        - { operator: equals, value: x }
`;
const analysis = analyze(broken);
check('two errors reported', analysis.diagnostics.length, 2);
check(
  'first error points at the operator',
  broken.slice(analysis.diagnostics[0]!.from, analysis.diagnostics[0]!.from + 10),
  'isInEurope',
);
check(
  'syntax errors are yaml-sourced',
  analyze('a:\n  - b\n c: d\n').diagnostics[0]?.source,
  'yaml',
);
check('starter policy is clean', analyze(DEFAULT_CONFIG_YAML).diagnostics.length, 0);
check(
  'format preserves comments',
  formatPolicy('# keep me\nname: x\nfolders: []\n').startsWith('# keep me'),
  true,
);

section('hostile policies');
const redos = parseConfig(`
info: { name: r }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - description: redos
          expression: res.headers['x-region']
          operator: matches
          value: '^(a+)+$'
`);
check('catastrophic regex rejected at parse time', redos.config, null);
check('and explains why', redos.errors[0]?.includes('nested quantifiers'), true);
check(
  'invalid regex rejected too',
  parseConfig(`
info: { name: r }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - { description: bad, expression: res.status, operator: matches, value: '([' }
`).config,
  null,
);
const safeRegex = parseConfig(`
info: { name: r }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - description: fine
          expression: res.headers['x-served-by']
          operator: matches
          value: '^(?:ams|fra|dub)'
`);
check('ordinary regex still allowed', safeRegex.errors, []);

const duplicates = parseConfig(`name: dup
folders:
  - { name: same, runtime: { assertions: [{ description: a, expression: res.status, operator: lt, value: '400' }] } }
  - { name: same, runtime: { assertions: [{ description: b, expression: res.status, operator: gt, value: '100' }] } }
`);
const dupIds = duplicates.config?.groups.flatMap((g) => g.assertions.map((a) => a.id)) ?? [];
check('duplicate group names keep distinct assertion ids', new Set(dupIds).size, dupIds.length);

const walker = buildContext(rec({}));
check('prototype is not reachable', resolveExpression('res.__proto__', walker), undefined);
check(
  'constructor is not reachable',
  resolveExpression('res.headers.constructor', walker),
  undefined,
);
check(
  'methods are not reachable',
  resolveExpression('res.headers.hasOwnProperty', walker),
  undefined,
);

section('preflights are their own records');
// They used to be folded into the request they authorized. They are not any
// more: an OPTIONS is a real request to that host, so it is judged like one and
// the toolbar checkbox decides whether the row is shown.
const options = rec({
  id: 'opt',
  method: 'OPTIONS',
  resourceType: 'preflight',
  startedAt: 900,
  status: 204,
  ip: '52.28.4.9',
  responseHeaders: {
    'access-control-allow-methods': 'GET, POST',
    'access-control-allow-origin': 'https://app.acme.com',
  },
});
const main = rec({ id: 'get', ip: '52.28.4.9', responseHeaders: { 'x-data-region': 'eu-west-1' } });
options.evaluation = evaluateRecord(options, config);
main.evaluation = evaluateRecord(main, config);
check('a preflight is judged, not swallowed', options.evaluation.verdict !== 'pending', true);
check('and it keeps its own method', options.method, 'OPTIONS');
check('the request it authorized keeps its own', main.method, 'GET');
check('both count towards the totals', summarizeTotals([main, options]).total, 2);

// The toolbar checkbox is the only thing that hides them.
const asLite = (record: typeof options) => record as unknown as LiteRecord;
const noFilter = { host: 'all', verdict: 'all', type: 'all', search: '' } as const;
check(
  'unchecked hides the preflight',
  [
    matches(asLite(options), { ...noFilter, showPreflights: false }, {}),
    matches(asLite(main), { ...noFilter, showPreflights: false }, {}),
  ],
  [false, true],
);
check(
  'checked shows it',
  [
    matches(asLite(options), { ...noFilter, showPreflights: true }, {}),
    matches(asLite(main), { ...noFilter, showPreflights: true }, {}),
  ],
  [true, true],
);

section('a preflight with no request is reported, not hidden');

// The browser only sends OPTIONS because a real call is about to follow. One
// with nothing behind it means that call happened where this extension cannot
// see it — the signature of another extension replacing fetch/XHR on the page.
const lite = (id: string, url: string, resourceType: string) =>
  ({ id, url, resourceType }) as unknown as LiteRecord;

check(
  'a preflight answered by its request is not counted',
  orphanPreflights([
    lite('a', 'https://eu.api.acme.com/v1/x', 'preflight'),
    lite('b', 'https://eu.api.acme.com/v1/x', 'fetch'),
  ]),
  0,
);
check(
  'a preflight with nothing behind it is',
  orphanPreflights([
    lite('a', 'https://eu.api.acme.com/v1/x', 'preflight'),
    lite('b', 'https://eu.api.acme.com/v1/y', 'fetch'),
  ]),
  1,
);
check(
  'and each unanswered one counts once',
  orphanPreflights([
    lite('a', 'https://eu.api.acme.com/v1/x', 'preflight'),
    lite('b', 'https://eu.api.acme.com/v1/y', 'preflight'),
    lite('c', 'https://eu.api.acme.com/v1/x', 'fetch'),
  ]),
  1,
);
check('nothing captured means nothing to report', orphanPreflights([]), 0);

section('runtime.scripts');
const scripted = parseConfig(`
info: { name: Scripted }
items:
  - info: { name: Global, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - { expression: res.status, operator: lt, value: '500' }
      scripts:
        - type: tests
          code: |-
            test("status is 200", function () { expect(res.status).to.equal(200); });
  - info: { name: API, type: http }
    http: { url: '*.api.example.com' }
    runtime:
      scripts:
        - type: tests
          code: 'test("region", function () { expect(res.headers["x-data-region"]).to.equal("eu-west-1"); });'
`);
check('a policy with scripts parses', scripted.errors, []);
check(
  'an item may carry both assertions and scripts',
  scripted.config?.groups[0]?.scripts.length,
  1,
);
check(
  'an item may carry scripts with no assertions',
  scripted.config?.groups[1]?.scripts.length,
  1,
);
check('and that item still becomes a group', scripted.config?.groups[1]?.name, 'API');
check(
  'script ids are document paths',
  scripted.config?.groups[0]?.scripts[0]?.id,
  'items[0].runtime.scripts[0]',
);

// `parseConfig` returns the config without the fields the store stamps on.
const scriptedConfig = { ...scripted.config!, revision: 1, source: 'user' as const, loadedAt: 0 };
check(
  'scripts are collected from every matching group',
  scriptsFor(
    rec({ host: 'eu.api.example.com', url: 'https://eu.api.example.com/v1/x' }),
    scriptedConfig,
  ).length,
  2,
);
check(
  'and none from a group that does not match',
  scriptsFor(rec({ host: 'other.example.org', url: 'https://other.example.org/x' }), scriptedConfig)
    .length,
  1,
);

// OpenCollection defines three script types; only one can mean anything here.
const wrongTypes = parseConfig(`
info: { name: Wrong }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      scripts:
        - { type: before-request, code: 'req.setHeader("x", 1)' }
        - { type: after-response, code: 'bru.setVar("t", 1)' }
        - { type: nonsense, code: 'x' }
        - { type: tests }
`);
check(
  'before-request is refused',
  wrongTypes.errors.some((e) => e.includes('before-request')),
  true,
);
check(
  'after-response is refused',
  wrongTypes.errors.some((e) => e.includes('after-response')),
  true,
);
check(
  'an unknown type is refused',
  wrongTypes.errors.some((e) => e.includes('nonsense')),
  true,
);
check(
  'a test with no code is refused',
  wrongTypes.errors.some((e) => e.includes('"code" is required')),
  true,
);
// Errors mean nothing is applied at all, which is the existing contract.
check('and nothing was compiled from them', wrongTypes.config, null);

// A Script is sealed to type and code, so anything else is not a field this
// config may accept.
const extraOnScript = parseConfig(`
info: { name: Off }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      scripts:
        - { type: tests, code: 'test("x", function () {});', enabled: false }
`);
check(
  'an extra key on a script is reported',
  extraOnScript.warnings.some((w) => w.includes('"enabled"')),
  true,
);
check('and the script itself still compiles', extraOnScript.config?.groups[0]?.scripts.length, 1);

section('the config is a subset of the schema');
const sealed = parseConfig(`
info: { name: Sealed }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - { description: A, expression: res.status, operator: lt, value: '500', severity: warn, name: Nope }
        - { description: B, expression: res.status, operator: lt, value: '400', disabled: true }
        - { description: C, expression: res.status, operator: lt, value: '300', enabled: false }
`);
check(
  'severity is reported as an unknown key',
  sealed.warnings.some((w) => w.includes('"severity"')),
  true,
);
check(
  'so is name',
  sealed.warnings.some((w) => w.includes('"name"')),
  true,
);
check(
  'so is enabled',
  sealed.warnings.some((w) => w.includes('"enabled"')),
  true,
);
check(
  'disabled: true removes the assertion, enabled: false does not',
  sealed.config?.groups[0]?.assertions.map((a) => a.description),
  ['A', 'C'],
);

const listValue = parseConfig(`
info: { name: List }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - { description: D, expression: res.status, operator: in, value: ['200', '204'] }
`);
check(
  'a list value is refused, since the schema types it as a string',
  listValue.errors.some((e) => e.includes('must be a string')),
  true,
);

const described = parseConfig(`
info: { name: Described }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - expression: req.url
          operator: startsWith
          value: 'https://'
          description: { content: Transport is encrypted, type: text/plain }
`);
check(
  'description may be the schema object form',
  described.config?.groups[0]?.assertions[0]?.name,
  'Transport is encrypted',
);
check(
  'and an assertion with no description falls back to its expression',
  parseConfig(`
info: { name: N }
items:
  - info: { name: g, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - { expression: res.ip, operator: isNotEmpty }
`).config?.groups[0]?.assertions[0]?.name,
  'res.ip isNotEmpty',
);

section('verdict folding');
const judged = evaluateRecord(
  rec({ responseHeaders: { 'x-data-region': 'eu-west-1' }, ip: '52.28.4.9' }),
  config,
);
check(
  'a passing script leaves the verdict alone',
  withTests(judged, [{ id: 't#0', name: 'ok', passed: true }]).verdict,
  judged.verdict,
);
check(
  'a failing script fails the record',
  withTests(judged, [{ id: 't#0', name: 'nope', passed: false, error: 'boom' }]).verdict,
  'fail',
);
check(
  'outcomes are kept either way',
  withTests(judged, [{ id: 't#0', name: 'ok', passed: true }]).tests?.length,
  1,
);
check('a record with no scripts has no tests field', judged.tests, undefined);

section('regex screen');
const BAD = [
  '^(a+)+$',
  '(a*)*',
  '([a-z]+)*',
  '(\\d+)+$',
  '^(\\w+\\s?)*$',
  '(x+x+)+y',
  '^(a{2,}){3,}$',
  '((ab)+)+',
];
const GOOD = [
  '^eu-',
  '^(?:ams|fra|dub)',
  '\\d{4}-\\d{2}-\\d{2}',
  '^[a-z]+$',
  'a+b+c+',
  '^(us|eu)-[a-z]+-\\d$',
  '^https://',
  '(foo|bar)',
  '^(?:a|b){1,3}$',
  '[a-z]{2,8}',
  '^x*$',
];

for (const pattern of BAD) {
  const risk = catastrophicRisk(pattern);
  check(`rejects ${pattern}`, risk !== null, true);
}
for (const pattern of GOOD) {
  const risk = catastrophicRisk(pattern);
  check(`allows ${pattern}`, risk, null);
}

report('engine checks');
