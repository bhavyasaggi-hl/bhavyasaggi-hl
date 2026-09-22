/**
 * Diffs a panel export against what the test page says it fired.
 *
 * The page tags every request with `?case=NN`, so each captured record can be
 * matched back to the case that caused it. What comes out is the thing a bug
 * report needs and a screenshot cannot give: exactly which requests the
 * extension saw, which it missed, and where what it recorded disagrees with
 * what the browser actually did.
 *
 *   yarn ingest ~/Downloads/residency-tab-123.json ~/Downloads/residency-expectations.json
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

interface ExpectedCase {
  readonly case: string;
  readonly group: string;
  readonly label: string;
  readonly method: string;
  readonly expectedType: string;
  readonly expectsPreflight: boolean;
  readonly expectsOrphanPreflight: boolean;
  readonly expectsNetworkError: boolean;
  readonly expectedStatus?: number;
  /** How many records this case should produce; more than one when fired in parallel. */
  readonly expectedCount?: number;
  readonly fired: { readonly ok: boolean; readonly outcome: string } | null;
}

interface Expectations {
  readonly cases: readonly ExpectedCase[];
}

interface Record_ {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly status?: number;
  readonly error?: string;
  readonly evaluation?: { readonly verdict: string };
}

interface Export {
  readonly records: readonly Record_[];
  readonly exported?: number;
  readonly captured?: number;
  readonly filters?: unknown;
}

const [exportPath, expectationsPath] = process.argv.slice(2);
if (exportPath === undefined || expectationsPath === undefined) {
  console.error('usage: yarn ingest <export.json> <expectations.json>');
  process.exit(2);
}

const data = JSON.parse(readFileSync(exportPath, 'utf8')) as Export;
const expected = JSON.parse(readFileSync(expectationsPath, 'utf8')) as Expectations;
const records = data.records ?? [];

/** The `?case=NN` the page stamped on every url it asked for. */
function caseOf(url: string): string | null {
  const match = /[?&]case=(\d+)/u.exec(url);
  return match?.[1] ?? null;
}

const byCase = new Map<string, Record_[]>();
const untagged: Record_[] = [];
for (const record of records) {
  const id = caseOf(record.url);
  if (id === null) {
    untagged.push(record);
    continue;
  }
  const bucket = byCase.get(id) ?? [];
  bucket.push(record);
  byCase.set(id, bucket);
}

let problems = 0;
const note = (text: string): void => {
  problems += 1;
  console.log(`  ✗ ${text}`);
};

console.log(`export     ${exportPath}`);
if (data.captured === undefined) {
  console.log('            (older export — it does not record whether a filter was on)');
} else {
  console.log(`            ${String(data.exported)} exported of ${String(data.captured)} captured`);
  if (data.exported !== data.captured) {
    console.log('            ⚠ this is a filtered view; clear every filter and export again');
  }
}
console.log(
  `records    ${String(records.length)}  ·  tagged ${String(byCase.size)} cases  ·  untagged ${String(untagged.length)}`,
);
console.log();

console.log('case  group    expected            what was captured');
console.log('────  ───────  ──────────────────  ───────────────────────────────────────');
for (const entry of expected.cases) {
  const seen = byCase.get(entry.case) ?? [];
  const main = seen.find((r) => r.resourceType !== 'preflight');
  const pre = seen.filter((r) => r.resourceType === 'preflight');

  const want = `${entry.method} ${entry.expectedType}`.padEnd(18);
  const got =
    seen.length === 0
      ? 'NOTHING CAPTURED'
      : seen
          .map(
            (r) =>
              `${r.method} ${r.resourceType}${r.status === undefined ? '' : ` ${String(r.status)}`}`,
          )
          .join(' + ');
  console.log(`${entry.case.padEnd(4)}  ${entry.group.padEnd(7)}  ${want}  ${got}`);

  // The page could not fire it, so its absence is not the extension's fault.
  if (
    entry.fired !== null &&
    !entry.fired.ok &&
    !entry.expectsNetworkError &&
    !entry.expectsOrphanPreflight
  ) {
    console.log(`        (the page itself failed here: ${entry.fired.outcome})`);
    continue;
  }

  if (seen.length === 0) {
    note(`case ${entry.case} (${entry.label}) produced no record at all`);
    continue;
  }
  if (main === undefined && !entry.expectsOrphanPreflight) {
    note(`case ${entry.case} captured only a preflight — the request it authorised is missing`);
  }
  if (main !== undefined && main.resourceType !== entry.expectedType) {
    note(`case ${entry.case} typed as "${main.resourceType}", expected "${entry.expectedType}"`);
  }
  const expectedCount = entry.expectedCount ?? 1;
  const mains = seen.filter((r) => r.resourceType !== 'preflight');
  if (mains.length !== expectedCount) {
    note(
      `case ${entry.case} produced ${String(mains.length)} record(s), expected ${String(expectedCount)}` +
        (mains.length < expectedCount
          ? ' — requests sharing a method, url and millisecond are being collapsed'
          : ''),
    );
  }
  if (main !== undefined && main.method !== entry.method) {
    note(`case ${entry.case} recorded method "${main.method}", expected "${entry.method}"`);
  }
  if (entry.expectedStatus !== undefined && main?.status !== entry.expectedStatus) {
    note(
      `case ${entry.case} status ${String(main?.status)}, expected ${String(entry.expectedStatus)}`,
    );
  }
  if (entry.expectsNetworkError && main?.error === undefined) {
    note(`case ${entry.case} should carry a net::ERR_* reason and does not`);
  }
  // Preflights are rows of their own now — nothing is folded into anything, so
  // the only question is whether the OPTIONS was captured at all.
  if (entry.expectsPreflight && pre.length === 0) {
    note(`case ${entry.case} expected a CORS preflight row; none was captured`);
  }
  if (!entry.expectsPreflight && pre.length > 0) {
    note(`case ${entry.case} produced an unexpected preflight`);
  }
}

console.log();
const types = new Map<string, number>();
for (const record of records) {
  types.set(record.resourceType, (types.get(record.resourceType) ?? 0) + 1);
}
console.log('resource types captured:');
for (const [type, count] of [...types].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(12)} ${String(count).padStart(4)}`);
}
for (const missing of ['fetch', 'xhr']) {
  if (!types.has(missing)) {
    note(`not one "${missing}" record was captured — script-initiated requests are being missed`);
  }
}

// A preflight whose request never appeared is the signature of that request
// being missed, so it is worth calling out on its own.
const lonely = records.filter(
  (r) =>
    r.resourceType === 'preflight' &&
    !records.some((other) => other.url === r.url && other.resourceType !== 'preflight'),
);
if (lonely.length > 0) {
  console.log();
  console.log(`preflights whose request was never captured: ${String(lonely.length)}`);
  for (const one of lonely.slice(0, 5)) {
    console.log(`  ${one.url.slice(0, 78)}`);
  }
}

console.log();
console.log(problems === 0 ? 'NO DISCREPANCIES' : `${String(problems)} DISCREPANCY(S)`);
process.exit(problems === 0 ? 0 : 1);
