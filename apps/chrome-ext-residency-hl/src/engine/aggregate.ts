/** Rolls captured records up into the per-domain and per-tab numbers the UI shows. */

import type { Grouping } from '../config/schema.ts';
import type { DomainStats, RequestRecord, Verdict } from '../shared/types.ts';

interface Counters {
  total: number;
  pass: number;
  fail: number;
  notApplicable: number;
  pending: number;
  lastActivityAt: number;
}

function emptyCounters(): Counters {
  return { total: 0, pass: 0, fail: 0, notApplicable: 0, pending: 0, lastActivityAt: 0 };
}

function tally(counters: Counters, verdict: Verdict, activityAt: number): void {
  counters.total += 1;
  counters.lastActivityAt = Math.max(counters.lastActivityAt, activityAt);
  switch (verdict) {
    case 'pass':
      counters.pass += 1;
      break;
    case 'fail':
      counters.fail += 1;
      break;
    case 'not-applicable':
      counters.notApplicable += 1;
      break;
    default:
      counters.pending += 1;
  }
}

/** Share of judged requests that passed. Unjudged requests are not counted. */
function passRate(counters: Pick<Counters, 'pass' | 'fail'>): number | null {
  const judged = counters.pass + counters.fail;
  return judged === 0 ? null : counters.pass / judged;
}

/** Key a record is grouped under in the report. */
function groupKey(record: RequestRecord, grouping: Grouping): string {
  const key = grouping === 'domain' ? record.registrableDomain : record.host;
  return key === '' ? '(no host)' : key;
}

function topFailures(
  records: readonly RequestRecord[],
  nameOf: (id: string) => string,
): DomainStats['topFailures'] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const record of records) {
    for (const result of record.evaluation?.results ?? []) {
      if (result.passed) {
        continue;
      }
      const existing = counts.get(result.id);
      if (existing === undefined) {
        counts.set(result.id, { name: nameOf(result.id), count: 1 });
      } else {
        existing.count += 1;
      }
    }
  }
  return [...counts.entries()]
    .map(([id, value]) => ({ id, name: value.name, count: value.count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);
}

/** Groups records by host (or registrable domain) and computes per-group statistics. */
export function summarizeDomains(
  records: readonly RequestRecord[],
  grouping: Grouping,
  nameOf: (id: string) => string,
): readonly DomainStats[] {
  const buckets = new Map<string, RequestRecord[]>();
  for (const record of records) {
    const key = groupKey(record, grouping);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [record]);
    } else {
      bucket.push(record);
    }
  }

  const stats: DomainStats[] = [];
  for (const [host, bucket] of buckets) {
    const counters = emptyCounters();
    for (const record of bucket) {
      tally(
        counters,
        record.evaluation?.verdict ?? 'pending',
        record.completedAt ?? record.startedAt,
      );
    }
    stats.push({
      host,
      total: counters.total,
      pass: counters.pass,
      fail: counters.fail,
      notApplicable: counters.notApplicable,
      pending: counters.pending,
      passRate: passRate(counters),
      lastActivityAt: counters.lastActivityAt,
      topFailures: topFailures(bucket, nameOf),
    });
  }

  return stats.sort((left, right) => {
    const leftRate = left.passRate ?? 2;
    const rightRate = right.passRate ?? 2;
    return leftRate === rightRate ? right.total - left.total : leftRate - rightRate;
  });
}

/** Aggregate counters across every record in a tab. */
export function summarizeTotals(
  records: readonly RequestRecord[],
): Omit<DomainStats, 'host' | 'topFailures'> {
  const counters = emptyCounters();
  for (const record of records) {
    tally(
      counters,
      record.evaluation?.verdict ?? 'pending',
      record.completedAt ?? record.startedAt,
    );
  }
  return {
    total: counters.total,
    pass: counters.pass,
    fail: counters.fail,
    notApplicable: counters.notApplicable,
    pending: counters.pending,
    passRate: passRate(counters),
    lastActivityAt: counters.lastActivityAt,
  };
}
