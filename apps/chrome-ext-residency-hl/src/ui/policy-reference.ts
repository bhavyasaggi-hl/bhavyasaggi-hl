/**
 * Single source of truth for the policy vocabulary.
 *
 * The options page reference tables, the JSON schema the on-device model is
 * constrained to, and the system prompt are all derived from these lists, so
 * the docs, the AI and the parser cannot drift apart.
 */

import { stringify } from 'yaml';
import { OPERATOR_NAMES } from '../engine/operators.ts';

export interface ReferenceRow {
  readonly term: string;
  readonly meaning: string;
}

export const STRUCTURE: readonly ReferenceRow[] = [
  { term: 'opencollection', meaning: 'Spec version the document follows.' },
  { term: 'info.name', meaning: 'Label shown in the panel and popup.' },
  { term: 'items[]', meaning: 'One request the policy describes, and the rules for it.' },
  { term: 'items[].info.name', meaning: 'Group name, shown against every verdict it produces.' },
  { term: 'items[].info.tags', meaning: 'Resource types this item covers: fetch, xhr, document…' },
  { term: 'items[].http.url', meaning: 'Which requests it covers. A glob; "*" means every one.' },
  { term: 'items[].http.method', meaning: 'Narrows the item to one verb.' },
  { term: 'items[].runtime.assertions', meaning: 'Applied to every request the item covers.' },
  {
    term: 'items[].runtime.scripts',
    meaning: 'JavaScript tests, run in a sandbox. type must be "tests"; code holds the script.',
  },
  {
    term: 'extensions.residency',
    meaning: 'grouping (host|domain), clearOnNavigate, recordUnscoped, recordByDefault, debug.',
  },
];

export const SCRIPT_FIELDS: readonly ReferenceRow[] = [
  { term: 'type', meaning: 'Must be "tests". before-request and after-response are refused.' },
  { term: 'code', meaning: 'JavaScript. Sees req, res, test() and chai\u2019s expect().' },
];

/** What a `tests` script can reach. Nothing else is in scope. */
export const SCRIPT_GLOBALS: readonly ReferenceRow[] = [
  { term: 'req', meaning: 'Same request object the assertion expressions read.' },
  { term: 'res', meaning: 'Same response object, including headers, body and ip.' },
  { term: 'test(name, fn)', meaning: 'Registers one test. A throw inside fn fails it.' },
  { term: 'expect(value)', meaning: 'Chai\u2019s expect. expect(res.status).to.equal(200).' },
];

export const ASSERTION_FIELDS: readonly ReferenceRow[] = [
  { term: 'expression', meaning: "Property path to read, e.g. res.headers['x-data-region']." },
  { term: 'operator', meaning: 'Comparison to apply.' },
  {
    term: 'value',
    meaning: 'Expected value, always a string. For in / notIn, separate members with commas.',
  },
  {
    term: 'description',
    meaning: 'Shown on the assertion card and appended to the explanation.',
  },
  { term: 'disabled', meaning: 'true keeps the rule in the file but skips it.' },
];

export const EXPRESSIONS: readonly ReferenceRow[] = [
  { term: 'req.method', meaning: 'HTTP method' },
  { term: 'req.url', meaning: 'Absolute URL' },
  { term: 'req.host', meaning: 'Hostname' },
  { term: 'req.domain', meaning: 'Registrable domain (eTLD+1)' },
  { term: 'req.path', meaning: 'URL path' },
  { term: "req.query['k']", meaning: 'Query parameter' },
  { term: "req.headers['x']", meaning: 'Request header' },
  { term: 'req.body', meaning: 'Parsed request payload' },
  { term: 'req.type', meaning: 'fetch, xhr, document, script, image, preflight…' },
  { term: 'res.status', meaning: 'HTTP status code' },
  { term: "res.headers['x']", meaning: 'Response header' },
  { term: 'res.body', meaning: 'Parsed response payload' },
  { term: 'res.bodyText', meaning: 'Raw response text' },
  { term: 'res.ip', meaning: 'IP that served the response' },
  { term: 'res.protocol', meaning: 'URL scheme' },
  { term: 'res.responseTime', meaning: 'Duration in ms' },
  { term: 'res.fromCache', meaning: 'Served from cache' },
  { term: 'res.error', meaning: 'net::ERR_* reason' },
];

export const VERDICTS: readonly ReferenceRow[] = [
  { term: 'pass', meaning: 'At least one assertion applied and all passed.' },
  { term: 'fail', meaning: 'An assertion or a scripted test failed.' },
  { term: 'not-applicable', meaning: 'No group scopes the request.' },
];

export const PRESETS: readonly { readonly label: string; readonly instruction: string }[] = [
  {
    label: 'EU residency for my API',
    instruction:
      'Require every XHR/fetch request to *.api.example.com to answer from an EU region: the x-data-region header must be eu-west-1 or eu-central-1, and the response IP must be inside the eu-approved range. Warn when the response takes longer than 2000 ms.',
  },
  {
    label: 'Block plaintext and third parties',
    instruction:
      'Every request must use https. Requests to hosts other than example.com and its subdomains must not carry an authorization header or a cookie header.',
  },
  {
    label: 'Payload declares its region',
    instruction:
      'For JSON API responses from *.api.example.com, res.body.meta.residency must equal eu and res.body.meta.tenantRegion must not be empty.',
  },
  {
    label: 'Tighten what I have',
    instruction:
      'Turn the warnings in this policy into errors and add an assertion that the x-data-region header is always present.',
  },
];

/** Assertion node of the constrained-output schema. */
const ASSERTION_SCHEMA = {
  type: 'object',
  required: ['description', 'expression', 'operator'],
  additionalProperties: false,
  properties: {
    description: { type: 'string' },
    expression: { type: 'string' },
    operator: { type: 'string', enum: [...OPERATOR_NAMES] },
    value: { type: 'string' },
  },
} as const;

export const POLICY_SCHEMA = {
  type: 'object',
  required: ['name', 'items'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'url', 'assertions'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          /** Glob the item covers. `*` means every request. */
          url: { type: 'string' },
          method: { type: 'string' },
          /** Resource types the item covers, e.g. fetch, xhr, document. */
          tags: { type: 'array', items: { type: 'string' } },
          assertions: { type: 'array', items: ASSERTION_SCHEMA },
        },
      },
    },
  },
} as const;

export interface PolicyDraft {
  name?: string;
  items?: {
    name?: string;
    description?: string;
    url?: string;
    method?: string;
    tags?: string[];
    assertions?: Record<string, unknown>[];
  }[];
}

/** Serializes a model draft into the canonical policy document. */
export function draftToYaml(draft: PolicyDraft): string {
  const document: Record<string, unknown> = {
    opencollection: '1.0.0',
    info: { name: draft.name ?? 'Generated residency policy', version: '1' },
    items: (draft.items ?? []).map((item) => {
      const info: Record<string, unknown> = { name: item.name ?? 'Item', type: 'http' };
      if (item.description !== undefined) {
        info['description'] = item.description;
      }
      if ((item.tags?.length ?? 0) > 0) {
        info['tags'] = item.tags;
      }
      const http: Record<string, unknown> = { url: item.url ?? '*' };
      if (item.method !== undefined) {
        http['method'] = item.method;
      }
      return { info, http, runtime: { assertions: item.assertions ?? [] } };
    }),
  };
  return `# Drafted on device by Chrome's built-in AI — review before saving.\n${stringify(document, { lineWidth: 0 })}`;
}

/** Compact dialect briefing given to the model as its system prompt. */
export function systemPrompt(): string {
  return [
    'You write policies for a Chrome extension that audits every network request a tab makes.',
    'Answer only with JSON matching the supplied schema. Never include prose.',
    '',
    'An assertion reads one value from a request or response and compares it with an operator.',
    `Expressions: ${EXPRESSIONS.map((row) => row.term).join(', ')}.`,
    `Operators: ${OPERATOR_NAMES.join(', ')}.`,
    'inCidr and notInCidr take one or more CIDR ranges, comma separated.',
    'in and notIn take a comma-separated value. between takes "low,high". length accepts "> 3".',
    '',
    'Scoping: each item covers the requests its url glob matches, narrowed by method and by the resource types in tags.',
    'Patterns are globs where * matches any characters; a "regex:" prefix switches to a regular expression, and a leading "." means a domain and its subdomains.',
    'globalAssertions apply to every request, so keep them to things true of all traffic.',
    'resourceTypes are DevTools names: document, fetch, xhr, preflight, script, stylesheet, image, font, media, websocket, ping, manifest, other.',
    '',
    'An assertion has exactly description, expression, operator and value — never a name or a severity.',
    'Each item describes the requests it covers: url is a glob ("*" for every request), method narrows by verb, tags name resource types such as fetch or xhr.',
    'Give every assertion a short name, and a description stating the intent rather than restating the comparison.',
    'Prefer few precise assertions over many loose ones. Never invent header names the user did not mention.',
  ].join('\n');
}
