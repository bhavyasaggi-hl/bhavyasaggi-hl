/**
 * Narrows a stored record to what the panel renders.
 *
 * Headers, query and payloads exist only long enough for the policy to read
 * them, and nothing in the UI shows them, so they are dropped on the way out
 * rather than masked on the way out. The worker stays the only holder of a
 * credential a page put in a request header.
 */

import type { LiteRecord, RequestRecord } from '../shared/types.ts';

export function toLite(record: RequestRecord): LiteRecord {
  const {
    requestBody: _requestBody,
    responseBody: _responseBody,
    requestHeaders: _requestHeaders,
    responseHeaders: _responseHeaders,
    query: _query,
    ...lite
  } = record;
  return lite;
}
