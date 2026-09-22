/** Panel toolbars: transport controls, search, and the verdict / type facets. */

import type { ReactNode } from 'preact/compat';
import type { ConfigStatus, TabSummary } from '../../shared/types.ts';
import { Button } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { ALL, type Filters, TYPE_FACETS, VERDICT_FACETS } from './filters.ts';

function Facets({
  label,
  facets,
  value,
  onChange,
}: {
  readonly label: string;
  readonly facets: readonly { readonly value: string; readonly label: string }[];
  readonly value: string;
  readonly onChange: (next: string) => void;
}): ReactNode {
  return (
    <fieldset className="flex gap-1 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      {facets.map((facet) => (
        <button
          key={facet.value}
          type="button"
          aria-pressed={facet.value === value}
          onClick={() => {
            onChange(facet.value);
          }}
          className={cx(
            'rounded border px-2 py-0.5',
            facet.value === value
              ? 'border-brand bg-brand text-brand-ink'
              : 'border-line-strong bg-raised hover:border-brand',
          )}
        >
          {facet.label}
        </button>
      ))}
    </fieldset>
  );
}

export function Toolbar({
  tab,
  config,
  filters,
  onFilters,
  onRecord,
  onClear,
  onPreserve,
  onExport,
}: {
  readonly tab: TabSummary | null;
  readonly config: ConfigStatus | null;
  readonly filters: Filters;
  readonly onFilters: (next: Filters) => void;
  readonly onRecord: () => void;
  readonly onClear: () => void;
  readonly onPreserve: (value: boolean) => void;
  readonly onExport: () => void;
}): ReactNode {
  const recording = tab?.recording ?? true;
  return (
    <>
      <div className="border-line bg-sunken flex items-center gap-1.5 border-b px-2 py-1 whitespace-nowrap">
        <Button
          onClick={onRecord}
          aria-pressed={recording}
          title={recording ? 'Stop recording this tab' : 'Record this tab'}
          className="flex items-center gap-1.5"
        >
          <span
            className={cx(
              'inline-block size-2.5 rounded-full',
              recording
                ? 'bg-fail shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-fail)_25%,transparent)]'
                : 'bg-na',
            )}
          />
          Record
        </Button>
        <Button onClick={onClear} title="Clear the requests recorded here">
          Clear
        </Button>
        <span className="bg-line-strong mx-1 w-px self-stretch" />
        <label
          className="text-ink-muted flex items-center gap-1.5"
          title="Keep requests across page navigations"
        >
          <input
            type="checkbox"
            checked={tab?.preserveLog ?? false}
            onChange={(event) => {
              onPreserve(event.currentTarget.checked);
            }}
          />
          Preserve log
        </label>
        <label
          className="text-ink-muted flex items-center gap-1.5"
          title="Show CORS preflights as their own rows"
        >
          <input
            type="checkbox"
            checked={filters.showPreflights}
            onChange={(event) => {
              onFilters({ ...filters, showPreflights: event.currentTarget.checked });
            }}
          />
          Preflights
        </label>
        <span className="bg-line-strong mx-1 w-px self-stretch" />
        <input
          type="search"
          value={filters.search}
          aria-label="Filter requests"
          placeholder="Filter URL, status, assertion…"
          onChange={(event) => {
            onFilters({ ...filters, search: event.currentTarget.value.trim().toLowerCase() });
          }}
          className="border-line-strong bg-raised min-w-36 flex-1 rounded border px-2 py-0.5"
        />
        <span
          className={cx(
            'ml-auto',
            config?.valid === false ? 'text-fail font-semibold' : 'text-ink-muted',
          )}
        >
          {config === null
            ? ''
            : config.valid
              ? `${config.name} · ${config.assertionCount} assertions`
              : `${config.name} — policy invalid`}
        </span>
        <Button onClick={onExport} title="Export the filtered requests as JSON">
          Export
        </Button>
        <Button
          onClick={() => {
            void chrome.runtime.openOptionsPage();
          }}
        >
          Policy
        </Button>
      </div>

      <div className="border-line bg-sunken flex items-center gap-1.5 overflow-x-auto border-b px-2 py-1">
        <Facets
          label="Verdict filter"
          facets={VERDICT_FACETS}
          value={filters.verdict}
          onChange={(verdict) => {
            onFilters({ ...filters, verdict });
          }}
        />
        <span className="bg-line-strong mx-1 w-px self-stretch" />
        <Facets
          label="Resource type filter"
          facets={TYPE_FACETS}
          value={filters.type}
          onChange={(type) => {
            onFilters({ ...filters, type });
          }}
        />
        {filters.host !== ALL && (
          <Button
            variant="ghost"
            className="text-ink-muted ml-auto"
            onClick={() => {
              onFilters({ ...filters, host: ALL });
            }}
          >
            Scoped to {filters.host} ✕
          </Button>
        )}
      </div>
    </>
  );
}
