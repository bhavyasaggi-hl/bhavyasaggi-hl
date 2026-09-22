/**
 * Verifies the capture boundary: mapping a DevTools network entry to a record,
 * including what a hostile or broken server can put in one.
 *
 * Run with `yarn verify`. This is the only place untrusted remote data enters
 * the extension, so the probes here are adversarial by design.
 */

import { check, installChrome, report, section } from './harness.ts';

installChrome();

const { buildContext, resolveExpression } = await import('../../src/engine/expression.ts');
const { toRecord, toBody } = await import('../../src/devtools/har.ts');
type Har = import('../../src/devtools/har.ts').HarEntry;

section('HAR mapping');

const har = {
  startedDateTime: '2026-09-22T10:00:00.000Z',
  time: 42,
  serverIPAddress: '52.28.4.9',
  _resourceType: 'fetch',
  _initiator: { url: 'https://app.acme.com/' },
  request: {
    method: 'POST',
    url: 'https://eu.api.acme.com/v1/contacts?page=2',
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: 'a=1' },
    ],
    postData: { mimeType: 'application/json', text: '{"a":1}' },
  },
  response: {
    status: 200,
    statusText: 'OK',
    headers: [
      { name: 'X-Data-Region', value: 'eu-west-1' },
      { name: 'Set-Cookie', value: 'b=2' },
    ],
    content: { mimeType: 'application/json', size: 7 },
  },
} as unknown as Har;

const mapped = toRecord(har, 'h1', 7);
check('HAR url and host', [mapped.host, mapped.path], ['eu.api.acme.com', '/v1/contacts']);
check('HAR query parsed', mapped.query, { page: '2' });
check('HAR remote IP becomes res.ip', mapped.ip, '52.28.4.9');
check('HAR headers lowercased', mapped.responseHeaders['x-data-region'], 'eu-west-1');
check('HAR request body captured', mapped.requestBody?.json, { a: 1 });
check('HAR timing', [mapped.responseTime, (mapped.completedAt ?? 0) - mapped.startedAt], [42, 42]);
check('HAR initiator', mapped.initiator, 'https://app.acme.com/');
check('HAR resource type preserved', mapped.resourceType, 'fetch');
// A real capture reports `https`, not `https:` — the scheme without the colon.
// A fixture that disagreed with this is how a policy asserting `'https:'` came
// to fail against every request on a live page.
check('HAR protocol is the bare scheme', mapped.protocol, 'https');

const failed = toRecord(
  {
    startedDateTime: '2026-09-22T10:00:00.000Z',
    time: 5,
    _resourceType: 'fetch',
    request: { method: 'GET', url: 'https://nope.invalid/x', headers: [] },
    response: { status: 0, statusText: '', headers: [], _error: 'net::ERR_NAME_NOT_RESOLVED' },
  } as unknown as Har,
  'h2',
  7,
);
check('failed request has no status', failed.status, undefined);
check('failed request carries the error', failed.error, 'net::ERR_NAME_NOT_RESOLVED');
check('failed request has no ip', failed.ip, undefined);

const hostileHeaders = toRecord(
  {
    startedDateTime: '2026-09-22T10:00:00.000Z',
    time: -50,
    _resourceType: 'fetch',
    request: { method: 'GET', url: `https://a.example.com/${'x'.repeat(9000)}`, headers: [] },
    response: {
      status: 200,
      statusText: 'OK',
      content: {},
      headers: [
        { name: 'constructor', value: 'x' },
        { name: '__proto__', value: 'y' },
      ],
    },
  } as unknown as Har,
  'h5',
  7,
);
check(
  'constructor header is not the Object constructor',
  hostileHeaders.responseHeaders['constructor'],
  'x',
);
check('__proto__ header is kept as data', hostileHeaders.responseHeaders['__proto__'], 'y');
check('negative duration is clamped', hostileHeaders.responseTime, 0);
check('url is bounded', hostileHeaders.url.length <= 2048, true);
// Structured clone across the IPC boundary restores Object.prototype, so the
// read path has to stay safe too, not just the build path.
const cloned = JSON.parse(JSON.stringify(hostileHeaders)) as typeof hostileHeaders;
check(
  'constructor header survives the round trip as data',
  resolveExpression("res.headers['constructor']", buildContext(cloned)),
  'x',
);
check(
  'a header that was never sent stays undefined',
  resolveExpression("res.headers['toString']", buildContext(cloned)),
  undefined,
);

const preflight = toRecord(
  {
    startedDateTime: '2026-09-22T10:00:00.000Z',
    time: 3,
    _resourceType: 'preflight',
    serverIPAddress: '52.28.4.9',
    request: { method: 'OPTIONS', url: 'https://eu.api.acme.com/v1/contacts?page=2', headers: [] },
    response: { status: 204, statusText: '', headers: [], content: {} },
  } as unknown as Har,
  'h3',
  7,
);
// Preflights are ordinary records; DevTools' own resource type is what the
// panel's toolbar checkbox filters on, so that mapping has to survive.
check('preflight typed by DevTools', preflight.resourceType, 'preflight');
check('and keeps its own method', preflight.method, 'OPTIONS');
check('and its own remote address', preflight.ip, '52.28.4.9');

// `postData.text` is null for a request that carried no payload. It used to be
// checked against `undefined`, so null went straight into `toBody` and threw
// while mapping — which takes the whole capture path down, not one body.
const nullPost = toRecord(
  {
    startedDateTime: '2026-09-22T10:00:00.000Z',
    time: 1,
    _resourceType: 'fetch',
    request: {
      method: 'POST',
      url: 'https://eu.api.acme.com/v1/x',
      headers: [],
      postData: { mimeType: 'application/json', text: null },
    },
    response: { status: 204, statusText: '', headers: [], content: {} },
  } as unknown as Har,
  'h9',
  7,
);
check('a null request payload maps without a body', nullPost.requestBody, undefined);
check('and the record itself still maps', [nullPost.method, nullPost.status], ['POST', 204]);

const base64 = toBody('aGVsbG8=', 'image/png', 'base64');
check('base64 body is not parsed as json', base64.json, undefined);
check('base64 body keeps its size', base64.size, 8);

report('capture checks');
