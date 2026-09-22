// Offline preview harness: the slice of the extension API the UI touches.
const HOSTS = ['eu.api.acme.com', 'cdn.acme.com', 'metrics.thirdparty.io'];
const POLICY_INDEX = {
  'runtime.assertions[0]': {
    id: 'runtime.assertions[0]',
    name: 'Transport is encrypted',
    description: 'Data in transit must never leave the browser over plaintext HTTP.',
    expression: 'req.url',
    operator: 'startsWith',
    expected: 'https://',
    severity: 'error',
    group: 'Global',
  },
  'folders[0].runtime.assertions[0]': {
    id: 'folders[0].runtime.assertions[0]',
    name: 'Served from an approved EU region',
    description: 'The API must answer from an EU region for EU-resident tenants.',
    expression: "res.headers['x-data-region']",
    operator: 'in',
    expected: 'eu-west-1, eu-central-1',
    severity: 'error',
    group: 'First-party API',
  },
};

const TYPES = ['xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'main_frame'];
const t0 = Date.now() - 9000;
const records = [];
for (let i = 0; i < 30; i += 1) {
  const host = HOSTS[i % HOSTS.length];
  const type = TYPES[i % TYPES.length];
  const verdict =
    i % 7 === 0 ? 'fail' : i % 5 === 0 ? 'warn' : i % 11 === 3 ? 'not-applicable' : 'pass';
  const started = t0 + i * 190;
  const region = verdict === 'fail' ? 'us-east-1' : 'eu-west-1';
  const results =
    verdict === 'not-applicable'
      ? []
      : [
          {
            id: 'runtime.assertions[0]',
            actual: '"https://x"',
            passed: true,
            detail: 'starts with "https://"',
          },
          {
            id: 'folders[0].runtime.assertions[0]',
            actual: `"${region}"`,
            passed: verdict !== 'fail',
            detail: `"${region}" is ${verdict === 'fail' ? 'not ' : ''}one of "eu-west-1", "eu-central-1"`,
          },
        ];
  const record = {
    id: `r${i}`,
    tabId: 7,
    frameId: 0,
    url: `https://${host}/v1/resource/${i}`,
    host,
    registrableDomain: host.split('.').slice(-2).join('.'),
    path: `/v1/resource/${i}`,
    query: {},
    method: i % 6 === 0 ? 'POST' : 'GET',
    resourceType: type,
    startedAt: started,
    completedAt: started + 40,
    responseTime: 40,
    status: 200,
    statusLine: 'HTTP/1.1 200 OK',
    ip: '52.28.4.9',
    protocol: 'https',
    fromCache: false,
    responseSize: 412,
    evaluation: {
      verdict,
      results,
      groups: verdict === 'not-applicable' ? [] : ['Global', 'First-party API'],
      evaluatedAt: started,
      configRevision: 2,
    },
  };
  records.push(record);
}

// One CORS preflight with no request behind it, so the panel's "unanswered"
// note is rendered — and therefore contrast-checked and axe-audited — rather
// than only existing on a page nobody screenshots.
records.push({
  ...records[0],
  id: 'preflight-orphan',
  url: 'https://eu.api.acme.com/v1/intercepted',
  path: '/v1/intercepted',
  method: 'OPTIONS',
  resourceType: 'preflight',
  status: 204,
  statusLine: 'HTTP/1.1 204 No Content',
});

const count = (v) => records.filter((r) => r.evaluation.verdict === v).length;
const totals = {
  total: records.length,
  pass: count('pass'),
  fail: count('fail'),
  warn: count('warn'),
  notApplicable: count('not-applicable'),
  pending: 0,
  lastActivityAt: Date.now(),
};
totals.passRate = (totals.pass + totals.warn) / (totals.pass + totals.warn + totals.fail);
const domains = HOSTS.map((host) => {
  const bucket = records.filter((r) => r.host === host);
  const c = (v) => bucket.filter((r) => r.evaluation.verdict === v).length;
  const s = {
    host,
    total: bucket.length,
    pass: c('pass'),
    fail: c('fail'),
    warn: c('warn'),
    notApplicable: c('not-applicable'),
    pending: 0,
    lastActivityAt: Date.now(),
    topFailures: [],
  };
  const judged = s.pass + s.warn + s.fail;
  s.passRate = judged === 0 ? null : (s.pass + s.warn) / judged;
  return s;
});
const tab = {
  tabId: 7,
  title: 'Acme',
  pageUrl: 'https://app.acme.com/contacts',
  closed: false,
  recording: true,
  devtoolsAttached: globalThis.__RESIDENCY_DEVTOOLS__ !== false,
  recordingStartedAt: t0,
  preserveLog: false,
  lastActivityAt: Date.now(),
  totals,
  domains,
};
const config = {
  revision: 2,
  valid: true,
  source: 'user',
  name: 'EU residency',
  groupCount: 2,
  assertionCount: 5,
  errors: [],
  warnings: [],
  migrationNotes:
    globalThis.__RESIDENCY_MIGRATED__ === true
      ? [
          '`ignore` was dropped: the schema has no field for it.',
          'First-party API: 2 patterns became one regex.',
        ]
      : [],
  updatedAt: Date.now(),
};
const POLICY = `# Residency policy
opencollection: '1.0.0'

info:
  name: EU residency
  version: '1'

items:
  - info: { name: Every request, type: http }
    http: { url: '*' }
    runtime:
      assertions:
        - description: Transport is encrypted
          expression: req.url
          operator: startsWith
          value: 'https://'

  - info:
      name: First-party API
      type: http
      tags: [fetch, xhr]
    http: { url: '*.api.acme.com' }
    runtime:
      assertions:
        - description: Served from an approved EU region
          expression: res.headers['x-data-region']
          operator: in
          value: 'eu-west-1, eu-central-1'
        - description: Unknown operator on purpose
          expression: res.ip
          operator: isInEurope
          value: yes

extensions:
  residency:
    grouping: host
`;
const DRAFT = {
  name: 'EU residency for Acme API',
  items: [
    {
      name: 'Acme API',
      url: '*.api.acme.com',
      tags: ['fetch', 'xhr'],
      assertions: [
        {
          description: 'Region header present',
          expression: "res.headers['x-data-region']",
          operator: 'isNotEmpty',
        },
      ],
    },
  ],
};

globalThis.chrome = {
  runtime: {
    id: 'preview',
    connect() {
      const listeners = [];
      return {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onDisconnect: { addListener: () => undefined },
        disconnect: () => undefined,
        postMessage(message) {
          if (message.type === 'subscribe') {
            const reply = message.records
              ? { type: 'snapshot', records, tab, config, policy: POLICY_INDEX }
              : { type: 'state', tab, config };
            setTimeout(() => {
              for (const fn of listeners) fn(reply);
            }, 0);
          }
        },
      };
    },
    sendMessage: async (message) => {
      if (message.type === 'getConfig') return { ok: true, data: { text: POLICY, status: config } };
      return { ok: true, data: { ok: true } };
    },
    openOptionsPage: async () => undefined,
    getURL: (p) => p,
  },
  tabs: {
    query: async () => [{ id: 7 }],
    create: async () => undefined,
    sendMessage: async () => undefined,
  },
  devtools: {
    inspectedWindow: { tabId: 7 },
    panels: { create: () => undefined },
    network: {
      onRequestFinished: { addListener: () => undefined, removeListener: () => undefined },
      onNavigated: { addListener: () => undefined, removeListener: () => undefined },
      getHAR: (done) => {
        done({ entries: [] });
      },
    },
  },
  storage: {
    local: { get: async () => ({}), set: async () => undefined },
    onChanged: { addListener: () => undefined },
  },
};
globalThis.LanguageModel = {
  availability: async () => 'available',
  params: async () => ({ defaultTopK: 3, maxTemperature: 2 }),
  create: async () => ({ prompt: async () => JSON.stringify(DRAFT), destroy: () => undefined }),
};
window.addEventListener('error', (e) => {
  document.title = 'ERROR: ' + e.message;
});
