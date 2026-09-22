/**
 * Validates the policies this extension ships and accepts against the real
 * OpenCollection schema.
 *
 * The rule is that a policy is a strict **subset** of that schema: a field may
 * be omitted, never added. Asserting that in prose drifts; this validates the
 * starter policy — the document every user begins from — against the published
 * schema itself, vendored beside this file so the check is offline and pinned.
 *
 * Schema: https://schema.opencollection.com/opencollection/v1.0.0.json
 */

import { readFileSync as read, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { check, installChrome, report, section } from './harness.ts';

installChrome();
const { DEFAULT_CONFIG_YAML } = await import('../../src/config/default-config.ts');
const { parseConfig } = await import('../../src/config/parse.ts');

const here = dirname(fileURLToPath(import.meta.url));
const schema: unknown = JSON.parse(readFileSync(join(here, 'opencollection-v1.0.0.json'), 'utf8'));

// `strict: false` because the schema uses keywords ajv does not police, not
// because anything here is skipped: `additionalProperties: false` is exactly
// what must be enforced, and it is.
const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(schema as object);

function conforms(label: string, yaml: string): void {
  const document: unknown = parseYaml(yaml);
  const valid = validate(document);
  if (valid) {
    check(label, true, true);
    return;
  }
  check(
    label,
    (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`),
    [],
  );
}

section('the shipped policy is a valid OpenCollection document');
conforms('the starter policy validates against the published schema', DEFAULT_CONFIG_YAML);
check(
  'and this extension parses it with no errors or warnings',
  [parseConfig(DEFAULT_CONFIG_YAML).errors, parseConfig(DEFAULT_CONFIG_YAML).warnings],
  [[], []],
);

section('the schema rejects what this extension rejects');
const withExtras = DEFAULT_CONFIG_YAML.replace(
  '        - description: Transport is encrypted',
  '        - name: Transport is encrypted\n          severity: warn',
);
const parsedExtras = parseConfig(withExtras);
check(
  'an assertion with name/severity is not schema-valid',
  validate(parseYaml(withExtras)),
  false,
);
check(
  'and this extension reports both as unknown keys',
  [
    parsedExtras.warnings.some((w) => w.includes('"name"')),
    parsedExtras.warnings.some((w) => w.includes('"severity"')),
  ],
  [true, true],
);

const legacyShape = `
name: Old shape
runtime:
  assertions:
    - { expression: req.url, operator: startsWith, value: 'https://' }
folders:
  - name: API
    match: { hosts: ['*.api.example.com'] }
`;
// The schema seals every nested object but leaves the root open, so validation
// alone would accept the pre-restructure document. Being a subset at the root
// is this extension's own discipline, and it is the stricter of the two.
check('the schema tolerates unknown root keys', validate(parseYaml(legacyShape)), true);
const parsedLegacy = parseConfig(legacyShape);
check(
  'this extension does not, and names each one',
  ['name', 'runtime', 'folders'].every((key) =>
    parsedLegacy.warnings.some((w) => w.includes(`"${key}"`)),
  ),
  true,
);
check('so the old shape yields no groups at all', parsedLegacy.config?.groups.length, 0);

section('nested objects are sealed, and that the schema does enforce');
const mutations: { readonly label: string; readonly yaml: string }[] = [
  {
    label: 'an unknown key on an item',
    yaml: DEFAULT_CONFIG_YAML.replace('      type: http', '      type: http\n      colour: blue'),
  },
  {
    label: 'an unknown key on http',
    yaml: DEFAULT_CONFIG_YAML.replace("      url: '*'", "      url: '*'\n      retries: 3"),
  },
  {
    label: 'an unknown key on runtime',
    yaml: DEFAULT_CONFIG_YAML.replace('    runtime:', '    runtime:\n      retries: 3'),
  },
];
for (const mutation of mutations) {
  check(`${mutation.label} is rejected by the schema`, validate(parseYaml(mutation.yaml)), false);
}

section('a policy written before the restructure migrates onto the schema');
const { migrateLegacy } = await import('../../src/config/migrate.ts');

const legacy = `
name: EU residency
version: 1

settings:
  grouping: domain
  recordByDefault: true
  mergePreflights: false

ignore:
  resourceTypes: [ping]

ipRanges:
  eu: ['52.28.0.0/16']

runtime:
  assertions:
    - name: Transport is encrypted
      expression: req.url
      operator: startsWith
      value: 'https://'

folders:
  - name: First-party API
    description: The APIs we own.
    match:
      hosts: ['*.api.acme.com', '*.eu.acme.com']
      resourceTypes: [fetch, xhr]
      methods: [GET]
      excludeHosts: ['status.api.acme.com']
    runtime:
      assertions:
        - name: Region header
          expression: res.headers['x-data-region']
          operator: in
          value: [eu-west-1, eu-central-1]
        - name: Turned off
          expression: res.ip
          operator: isNotEmpty
          enabled: false
        - name: Advisory once
          expression: res.responseTime
          operator: lt
          value: '2000'
          severity: warn
      scripts:
        - type: tests
          code: 'test("ok", function () { expect(res.status).to.equal(200); });'
`;

const migrated = migrateLegacy(legacy);
check('a legacy document is recognised', migrated !== null, true);
conforms('the migrated document validates against the published schema', migrated?.text ?? '');

const reparsed = parseConfig(migrated?.text ?? '');
check('and this extension parses it with no errors', reparsed.errors, []);
check('and no unknown keys', reparsed.warnings, []);
check(
  'the global rules became an item scoped to everything',
  [reparsed.config?.groups[0]?.name, reparsed.config?.groups[0]?.scope[0]?.url],
  ['Every request', undefined],
);
check('the folder became an item', reparsed.config?.groups[1]?.name, 'First-party API');
check(
  'two host patterns became one regex',
  reparsed.config?.groups[1]?.scope[0]?.url?.source.startsWith('regex:^(?:'),
  true,
);
check(
  'resource types became tags',
  [...(reparsed.config?.groups[1]?.scope[0]?.resourceTypes ?? [])],
  ['fetch', 'xhr'],
);
check('the single method carried across', reparsed.config?.groups[1]?.scope[0]?.method, 'GET');
check(
  'name became description',
  reparsed.config?.groups[1]?.assertions[0]?.description,
  'Region header',
);
check(
  'the list value became a string',
  reparsed.config?.groups[1]?.assertions[0]?.expected,
  'eu-west-1, eu-central-1',
);
check(
  'enabled: false became disabled, so it is not compiled',
  reparsed.config?.groups[1]?.assertions.map((a) => a.description),
  ['Region header', 'Advisory once'],
);
check('the script carried across', reparsed.config?.groups[1]?.scripts.length, 1);
check(
  'settings moved under extensions',
  [reparsed.config?.settings.grouping, reparsed.config?.settings.recordByDefault],
  ['domain', true],
);

check('and it says what it could not carry', (migrated?.notes ?? []).length >= 4, true);
// `mergePreflights` is gone: preflights are their own rows, shown or hidden by
// the toolbar checkbox, so a saved policy that still sets it is told as much.
check(
  'the dropped mergePreflights setting does not survive',
  Object.keys(reparsed.config?.settings ?? {}).includes('mergePreflights'),
  false,
);
check(
  'and the migrated document no longer mentions it',
  (migrated?.text ?? '').includes('mergePreflights'),
  false,
);
for (const fragment of ['ignore', 'ipRanges', 'exclusions', 'regex', 'mergePreflights']) {
  check(
    `the notes mention ${fragment}`,
    (migrated?.notes ?? []).some((note) => note.includes(fragment)),
    true,
  );
}

check(
  'a document already in the new shape is left alone',
  migrateLegacy(DEFAULT_CONFIG_YAML),
  null,
);
check('and so is unparseable text', migrateLegacy('name: [unclosed'), null);

section('every policy shipped for manual testing');
// Authoring these by hand keeps tripping over YAML: a bracketed expression in a
// flow map reads as the start of a sequence. A broken one must not ship.
for (const file of ['manual-test-policy.yaml', 'tools/manual/test-page-policy.yaml']) {
  const yaml = read(join(here, '..', '..', file), 'utf8');
  conforms(`${file} validates against the published schema`, yaml);
  const parsedPolicy = parseConfig(yaml);
  check(`${file} parses with no errors`, parsedPolicy.errors, []);
  check(`${file} has no unknown keys`, parsedPolicy.warnings, []);
  check(`${file} compiles at least one group`, (parsedPolicy.config?.groups.length ?? 0) > 0, true);
}

section('the manual-test policy');
const manual = read(join(here, '..', '..', 'manual-test-policy.yaml'), 'utf8');
const { OPERATOR_NAMES } = await import('../../src/engine/operators.ts');

conforms('it validates against the published schema', manual);
const manualParsed = parseConfig(manual);
check('it parses with no errors', manualParsed.errors, []);
check('and no unknown keys', manualParsed.warnings, []);

const groups = manualParsed.config?.groups ?? [];
const operatorsUsed = new Set(groups.flatMap((g) => g.assertions.map((a) => a.operator)));
// Three operators need a JSON response body, which no site guarantees, so they
// ship disabled. Every other operator is live.
const bodyOnly = ['isNull', 'isArray', 'isJson'];
check(
  'every operator that can hold universally is exercised',
  OPERATOR_NAMES.filter((name) => !(operatorsUsed.has(name) || bodyOnly.includes(name))),
  [],
);
check(
  'it covers a folder, so nested naming is visible',
  groups.some((g) => g.name.includes(' / ')),
  true,
);
check(
  'and both script paths',
  groups.reduce((n, g) => n + g.scripts.length, 0),
  2,
);

report('conformance checks');
