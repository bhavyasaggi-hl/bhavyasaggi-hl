/**
 * Maps a DevTools HAR entry onto a capture record.
 *
 * `chrome.devtools.network` is the capture source: it needs no permissions, it
 * is already scoped to the inspected tab, and it reports things `webRequest`
 * could not — the remote IP for every connection, an explicit `preflight`
 * resource type, and response bodies for every resource type rather than only
 * the `fetch`/XHR calls a page hook could reach.
 */

import type { Entry as HARFormatEntry } from 'har-format';

import { MAX_BODY_BYTES, MAX_URL_CHARS } from '../shared/constants.ts';
import type { BodyCapture, RequestRecord } from '../shared/types.ts';
import { parseUrl } from '../shared/url.ts';

/**
 * The HAR entry as Chrome populates it.
 *
 * `@types/har-format` already models Chrome's extensions — `_resourceType`
 * (which includes `preflight`), `_fromCache` and `_initiator`. Only the error
 * string on a failed response is missing, and the spike confirmed it is there.
 */
export type HarEntry = HARFormatEntry & {
  readonly response?:
    | (HARFormatEntry['response'] & { readonly _error?: string | null })
    | undefined;
};

/**
 * Header names come from a remote server, so the map must not inherit from
 * `Object.prototype`: a `constructor` header would otherwise read back as the
 * Object constructor and be concatenated into the value, and a `__proto__`
 * header would be silently dropped.
 */
function headerMap(
  headers: readonly { readonly name: string; readonly value: string }[] | undefined,
): Record<string, string> {
  const map = Object.create(null) as Record<string, string>;
  for (const header of headers ?? []) {
    const key = header.name.toLowerCase();
    const existing = map[key];
    map[key] = existing === undefined ? header.value : `${existing}, ${header.value}`;
  }
  return map;
}

/** Wraps captured text as a body, truncating to the per-payload cap. */
export function toBody(
  text: string,
  contentType: string | undefined,
  encoding?: string,
): BodyCapture {
  const truncated = text.length > MAX_BODY_BYTES;
  const clipped = truncated ? text.slice(0, MAX_BODY_BYTES) : text;
  let json: unknown;
  const looksJson = (contentType ?? '').includes('json') || /^\s*[[{]/u.test(clipped);
  if (!truncated && encoding !== 'base64' && looksJson && clipped !== '') {
    try {
      json = JSON.parse(clipped);
    } catch {
      json = undefined;
    }
  }
  return {
    text: clipped,
    ...(json === undefined ? {} : { json }),
    ...(contentType === undefined ? {} : { contentType }),
    size: text.length,
    truncated,
    source: 'devtools',
  };
}

/** When the request started, falling back to now if the entry has no usable time. */
function startedAtOf(entry: HarEntry): number {
  const parsed = Date.parse(entry.startedDateTime ?? '');
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** Whoever caused the request, as a URL — DevTools reports it either way round. */
function initiatorOf(entry: HarEntry): string | undefined {
  const raw = entry._initiator;
  return typeof raw === 'string' ? raw : (raw?.url ?? undefined);
}

/**
 * Response size in bytes.
 *
 * Read at capture time rather than from the headers later: the header map is
 * released once the policy has seen it, and the Size column outlives it.
 */
function responseSizeOf(
  entry: HarEntry,
  responseHeaders: Record<string, string>,
): number | undefined {
  const bodySize = entry.response?.content?.size ?? entry.response?.bodySize;
  if (typeof bodySize === 'number' && bodySize >= 0) {
    return bodySize;
  }
  const declared = Number(responseHeaders['content-length']);
  return Number.isFinite(declared) && declared >= 0 ? declared : undefined;
}

/** Converts one HAR entry into a record. Bodies are attached separately. */
export function toRecord(entry: HarEntry, id: string, tabId: number): RequestRecord {
  // Paths are attacker-controllable and one record is held per request, so an
  // unbounded URL would be a memory amplifier.
  const url = (entry.request?.url ?? '').slice(0, MAX_URL_CHARS);
  const parsed = parseUrl(url);
  const started = startedAtOf(entry);
  // A failed request reports status 0; the store treats "no status" as pending,
  // so it has to become undefined and let `error` carry the outcome.
  const status = entry.response?.status;
  // A HAR entry is only as trustworthy as whatever produced it: clamp a
  // negative duration so a request cannot finish before it started.
  const duration = Math.max(entry.time ?? 0, 0);
  const postData = entry.request?.postData;
  const error = entry.response?._error;
  const initiator = initiatorOf(entry);
  const responseHeaders = headerMap(entry.response?.headers);
  const responseSize = responseSizeOf(entry, responseHeaders);

  return {
    id,
    tabId,
    frameId: 0,
    url,
    host: parsed.host,
    registrableDomain: parsed.registrableDomain,
    path: parsed.path,
    query: parsed.query,
    method: entry.request?.method ?? 'GET',
    resourceType: entry._resourceType ?? 'other',
    ...(initiator === undefined ? {} : { initiator }),
    startedAt: started,
    completedAt: started + duration,
    responseTime: duration,
    ...(status === undefined || status === 0 ? {} : { status }),
    ...(entry.response?.statusText === undefined ? {} : { statusLine: entry.response.statusText }),
    ...(entry.serverIPAddress === undefined ? {} : { ip: entry.serverIPAddress }),
    protocol: parsed.protocol,
    fromCache: entry._fromCache !== undefined && entry._fromCache !== null,
    requestHeaders: headerMap(entry.request?.headers),
    responseHeaders,
    ...(responseSize === undefined ? {} : { responseSize }),
    // Checked for a string rather than against `undefined`: a HAR entry is
    // external data, and `postData.text` is null whenever there was no payload.
    ...(typeof postData?.text === 'string' && postData.text !== ''
      ? { requestBody: toBody(postData.text, postData.mimeType) }
      : {}),
    ...(error === undefined || error === null ? {} : { error }),
  };
}

/** Content type the response claims, used when deciding how to read a body. */
export function responseContentType(entry: HarEntry): string | undefined {
  return entry.response?.content?.mimeType ?? headerMap(entry.response?.headers)['content-type'];
}
