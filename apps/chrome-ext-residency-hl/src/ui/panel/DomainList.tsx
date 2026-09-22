/** Domain sidebar: pass rate per host, and the scope filter for the list. */

import type { ReactNode } from 'preact/compat';
import type { DomainStats, TabSummary } from '../../shared/types.ts';
import { PassRate, VerdictBar } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { ALL } from './filters.ts';

type Counts = Omit<DomainStats, 'host' | 'topFailures'>;

function Row({
  label,
  counts,
  active,
  onSelect,
}: {
  readonly label: string;
  readonly counts: Counts;
  readonly active: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-current={active}
      onClick={onSelect}
      className={cx(
        'border-line hover:bg-raised block w-full border-b px-2 py-1.5 text-left',
        active && 'bg-raised shadow-[inset_3px_0_0_var(--color-brand)]',
      )}
    >
      <div className="truncate font-semibold">{label}</div>
      <div className="text-ink-muted flex items-baseline gap-1.5 tabular-nums">
        <PassRate rate={counts.passRate} />
        <span>· {counts.total} req</span>
      </div>
      <div className="mt-1">
        <VerdictBar counts={counts} />
      </div>
    </button>
  );
}

export function DomainList({
  tab,
  selectedHost,
  onSelect,
}: {
  readonly tab: TabSummary | null;
  readonly selectedHost: string;
  readonly onSelect: (host: string) => void;
}): ReactNode {
  return (
    <aside className="border-line bg-sunken min-h-0 overflow-auto border-r">
      <h2 className="bg-sunken border-line text-ink-muted sticky top-0 border-b px-2 py-1 text-[12px] font-semibold tracking-wider uppercase">
        Domains
      </h2>
      {tab !== null && (
        <Row
          label="All domains"
          counts={tab.totals}
          active={selectedHost === ALL}
          onSelect={() => {
            onSelect(ALL);
          }}
        />
      )}
      {(tab?.domains ?? []).map((stats) => (
        <Row
          key={stats.host}
          label={stats.host}
          counts={stats}
          active={selectedHost === stats.host}
          onSelect={() => {
            onSelect(stats.host);
          }}
        />
      ))}
    </aside>
  );
}
