/**
 * Detail pane for one request, as DevTools-style tabs.
 *
 * A request is judged once, on arrival, and the verdict is what this shows.
 * The headers, query and payloads the policy read are released seconds later,
 * so there is nothing to fetch on demand and nothing to wait for — the record
 * the list already holds is the whole record.
 */

import { type ReactNode, useId, useState } from 'preact/compat';
import {
  type AssertionDefinition,
  type AssertionOutcome,
  explain,
  type LiteRecord,
  type PolicyIndex,
  type TestOutcome,
} from '../../shared/types.ts';
import { Banner, Chip, VerdictChip } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { formatBytes, formatDuration, formatTime } from '../lib/format.ts';

type TabName = 'assertions' | 'request' | 'timing';

const TABS: readonly (readonly [TabName, string])[] = [
  ['assertions', 'Assertions'],
  ['request', 'Request'],
  ['timing', 'Timing'],
];

function Rows({ rows }: { readonly rows: readonly (readonly [string, string])[] }): ReactNode {
  return (
    <dl className="grid grid-cols-[minmax(90px,34%)_1fr] gap-x-2 gap-y-px">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-muted break-words">{label}</dt>
          <dd className="m-0 font-mono break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AssertionCard({
  result,
  definition,
}: {
  readonly result: AssertionOutcome;
  readonly definition: AssertionDefinition | undefined;
}): ReactNode {
  const state = result.passed ? 'pass' : 'fail';
  return (
    <li
      className={cx(
        'border-line bg-raised mx-2 mb-1.5 list-none rounded border border-l-[3px] px-2 py-1.5',
        state === 'pass' ? 'border-l-pass' : 'border-l-fail',
      )}
    >
      <div className="flex items-baseline gap-1.5 font-semibold">
        <VerdictChip verdict={state} />
        <span>{definition?.name ?? result.id}</span>
      </div>
      {definition === undefined ? null : (
        <div className="text-ink-muted mt-0.5 font-mono break-words">
          {definition.expression} <span className="text-brand">{definition.operator}</span>{' '}
          {definition.expected ?? ''}
        </div>
      )}
      <div className="text-ink-muted mt-0.5 font-mono break-words">actual: {result.actual}</div>
      <div className="mt-0.5 break-words">{explain(result, definition)}</div>
      <div className="text-ink-muted mt-0.5 text-[12px]">
        {definition === undefined
          ? 'This assertion is no longer in the policy, so only the outcome is shown.'
          : definition.group}
      </div>
      {result.error !== undefined && (
        <div className="mt-1.5">
          <Banner tone="error" headline={result.error} />
        </div>
      )}
    </li>
  );
}

function TestCard({ outcome }: { readonly outcome: TestOutcome }): ReactNode {
  return (
    <li
      className={cx(
        'border-line bg-raised mx-2 mb-1.5 list-none rounded border border-l-[3px] px-2 py-1.5',
        outcome.passed ? 'border-l-pass' : 'border-l-fail',
      )}
    >
      <div className="flex items-baseline gap-1.5 font-semibold">
        <VerdictChip verdict={outcome.passed ? 'pass' : 'fail'} />
        <span>{outcome.name}</span>
      </div>
      {outcome.error !== undefined && (
        <div className="text-ink-muted mt-0.5 font-mono break-words">{outcome.error}</div>
      )}
    </li>
  );
}

function Assertions({
  record,
  policy,
}: {
  readonly record: LiteRecord;
  readonly policy: PolicyIndex;
}): ReactNode {
  const results = record.evaluation?.results ?? [];
  if (results.length === 0) {
    // A group may carry scripts and no assertions, so an empty result list is
    // not the same as nothing to show.
    return (
      <div>
        <p className="text-ink-muted p-2">
          {record.evaluation?.verdict === 'pending'
            ? 'The response has not arrived yet, so no assertion has run.'
            : 'No policy group scopes this request with assertions.'}
        </p>
        <Tests record={record} />
      </div>
    );
  }
  return (
    <div>
      <p className="text-ink-muted m-0 px-2 py-1.5">
        {results.filter((result) => result.passed).length} of {results.length} passed · groups:{' '}
        {(record.evaluation?.groups ?? []).join(', ')}
      </p>
      <ul className="m-0 p-0">
        {results.map((result) => (
          <AssertionCard key={result.id} result={result} definition={policy[result.id]} />
        ))}
      </ul>
      <Tests record={record} />
    </div>
  );
}

/**
 * Script results, when the policy has any.
 *
 * They arrive after the assertions — scripts run in a sandboxed frame, not in
 * the worker — so `undefined` means this policy has no scripts, while an empty
 * array means they ran and registered no tests.
 */
function Tests({ record }: { readonly record: LiteRecord }): ReactNode {
  const tests = record.evaluation?.tests;
  if (tests === undefined) {
    return null;
  }
  const passed = tests.filter((outcome) => outcome.passed).length;
  return (
    <>
      <p className="text-ink-muted border-line m-0 border-t px-2 py-1.5">
        {tests.length === 0
          ? 'Scripts ran and registered no tests.'
          : `${passed} of ${tests.length} scripted tests passed`}
      </p>
      <ul className="m-0 p-0">
        {tests.map((outcome) => (
          <TestCard key={outcome.id} outcome={outcome} />
        ))}
      </ul>
    </>
  );
}

function Request({ record }: { readonly record: LiteRecord }): ReactNode {
  const status =
    record.error ??
    (record.status === undefined
      ? 'pending'
      : `${String(record.status)} ${record.statusLine ?? ''}`.trim());
  return (
    <div className="p-2">
      <Rows
        rows={[
          ['Request URL', record.url],
          ['Method', record.method],
          ['Status', status],
          ['Remote address', record.ip ?? '—'],
          ['Resource type', record.resourceType],
          ['Size', formatBytes(record.responseSize)],
          ['From cache', record.fromCache === true ? 'yes' : 'no'],
          ['Initiator', record.initiator ?? '—'],
        ]}
      />
      <p className="text-ink-muted mt-2.5 mb-0">
        Headers and payloads are released once the policy has read them. The Network panel keeps
        them.
      </p>
    </div>
  );
}

function Timing({ record }: { readonly record: LiteRecord }): ReactNode {
  return (
    <div className="p-2">
      <Rows
        rows={[
          ['Started', formatTime(record.startedAt)],
          ['Completed', formatTime(record.completedAt)],
          ['Duration', formatDuration(record.responseTime)],
          ['Evaluated', formatTime(record.evaluation?.evaluatedAt)],
        ]}
      />
      <div className="mt-2">
        <Chip tone="neutral">{record.protocol ?? 'http'}</Chip>
      </div>
    </div>
  );
}

function TabPanel({
  active,
  record,
  policy,
}: {
  readonly active: TabName;
  readonly record: LiteRecord;
  readonly policy: PolicyIndex;
}): ReactNode {
  switch (active) {
    case 'request':
      return <Request record={record} />;
    case 'timing':
      return <Timing record={record} />;
    default:
      return <Assertions record={record} policy={policy} />;
  }
}

export function DetailPane({
  selected,
  policy,
}: {
  readonly selected: LiteRecord;
  readonly policy: PolicyIndex;
}): ReactNode {
  const [active, setActive] = useState<TabName>('assertions');
  const tabsId = useId();

  return (
    <aside
      className="border-line bg-sunken flex min-h-0 flex-col overflow-hidden border-l"
      aria-label="Request detail"
    >
      <h2 className="border-line flex items-baseline gap-1.5 border-b px-2 py-1.5 text-[13px] font-normal">
        <VerdictChip verdict={selected.evaluation?.verdict ?? 'pending'} />
        <span className="font-mono font-semibold">{selected.method}</span>
        <span className="text-ink-muted truncate font-mono" title={selected.url}>
          {selected.url}
        </span>
      </h2>

      <div
        className="border-line flex gap-0.5 border-b px-1.5 pt-1"
        role="tablist"
        aria-label="Request detail sections"
      >
        {TABS.map(([name, label]) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${tabsId}-${name}`}
            aria-selected={name === active}
            aria-controls={`${tabsId}-panel`}
            tabIndex={name === active ? 0 : -1}
            onClick={() => {
              setActive(name);
            }}
            className={cx(
              'rounded-none border-0 border-b-2 px-2 py-0.5',
              name === active
                ? 'border-b-brand text-ink font-semibold'
                : 'text-ink-muted border-b-transparent',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${active}`}
        // The panel scrolls and holds no focusable content of its own, so it
        // has to be reachable by keyboard to be scrollable by keyboard. This is
        // what the ARIA practices prescribe for a tabpanel, and axe fails the
        // page without it; the rule does not model either case.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable tabpanel with no focusable content
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto pb-4"
      >
        <TabPanel active={active} record={selected} policy={policy} />
      </div>
    </aside>
  );
}
