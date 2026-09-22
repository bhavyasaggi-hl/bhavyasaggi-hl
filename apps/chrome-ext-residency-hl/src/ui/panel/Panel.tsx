/** DevTools "Residency" panel, laid out like the Network panel. */

import { type ReactNode, useCallback, useDeferredValue, useMemo, useState } from 'preact/compat';
import type { LiteRecord } from '../../shared/types.ts';
import { AsyncBoundary } from '../components/AsyncBoundary.tsx';
import { ListSkeleton } from '../components/skeletons.tsx';
import { cx } from '../lib/cx.ts';
import { formatPercent, formatTime } from '../lib/format.ts';
import { useSettledFlag } from '../lib/use-settled-flag.ts';
import { useSlowHint } from '../lib/use-slow-hint.ts';
import { DetailPane } from './DetailPane.tsx';
import { DomainList } from './DomainList.tsx';
import { ALL, type Filters, matches, orphanPreflights } from './filters.ts';
import { RequestTable } from './RequestTable.tsx';
import { Toolbar } from './Toolbar.tsx';
import { type PanelData, usePanelStream } from './usePanelStream.ts';

const EMPTY_FILTERS: Filters = {
  host: ALL,
  verdict: ALL,
  type: ALL,
  search: '',
  showPreflights: false,
};

function download(name: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The one-line status strip along the bottom of the panel. */
function StatusLine({
  tab,
  preflights,
  unanswered,
  reconnecting,
}: {
  readonly tab: PanelData['tab'];
  readonly preflights: number;
  readonly unanswered: number;
  readonly reconnecting: boolean;
}): ReactNode {
  const totals = tab.totals;
  return (
    <output className="border-line bg-sunken text-ink-muted block overflow-x-auto border-t px-2 py-0.5 tabular-nums whitespace-nowrap">
      {totals.fail} failing · {totals.notApplicable + totals.pending} unscoped ·{' '}
      {formatPercent(totals.passRate)} pass
      {preflights === 0 ? '' : ` · ${preflights} preflight${preflights === 1 ? '' : 's'} hidden`}
      {unanswered === 0 ? null : (
        <span
          className="text-warn"
          title={
            'A CORS preflight was captured but no request to the same URL followed it. Either the preflight was refused, ' +
            'or the request it authorised was made where this extension cannot see it — another extension that replaces ' +
            'fetch/XMLHttpRequest re-issues calls from its own context, which chrome.devtools.network does not report. ' +
            'Many of these at once points at the second case; audit in a clean profile to confirm.'
          }
        >
          {` · ${unanswered} preflight${unanswered === 1 ? '' : 's'} unanswered`}
        </span>
      )}
      {totals.total === 0
        ? ''
        : ` · ${tab.recording ? 'recording' : 'paused'} since ${formatTime(tab.recordingStartedAt)}`}
      {reconnecting ? ' · reconnecting…' : ''}
    </output>
  );
}

function Workspace({
  data,
  tabId,
  stream,
}: {
  readonly data: PanelData;
  readonly tabId: number;
  readonly stream: ReturnType<typeof usePanelStream>;
}): ReactNode {
  // Ports drop whenever the worker is evicted and are back in a moment, so the
  // footer mentions it only once it has lasted long enough to matter.
  const reconnecting = useSettledFlag(!stream.connected);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Typing in the filter box must not block the incoming stream.
  const applied = useDeferredValue(filters);

  const visible = useMemo(
    () => data.records.filter((record) => matches(record, applied, data.policy)),
    [data.records, applied, data.policy],
  );
  const preflights = useMemo(
    () =>
      data.records.reduce(
        (count, record) => count + (record.resourceType === 'preflight' ? 1 : 0),
        0,
      ),
    [data.records],
  );
  // The signature of another extension intercepting the page's fetch/XHR: the
  // browser asked permission for a call this extension never got to see.
  const unanswered = useMemo(() => orphanPreflights(data.records), [data.records]);
  // Derived, not stored: a cleared or navigated tab drops the open request by
  // simply not finding it, with no effect needed to chase the id.
  const selected = useMemo<LiteRecord | null>(
    () => data.records.find((record) => record.id === selectedId) ?? null,
    [data.records, selectedId],
  );

  const emptyMessage =
    data.records.length === 0
      ? data.tab.recording
        ? 'Recording. Reload the page to capture it from the start.'
        : 'Not recording this tab. Press Record to start.'
      : 'No requests match the current filters.';

  return (
    <>
      <Toolbar
        tab={data.tab}
        config={data.config}
        filters={filters}
        onFilters={setFilters}
        onRecord={() => {
          stream.setRecording(!data.tab.recording);
        }}
        onClear={stream.clear}
        onPreserve={stream.setPreserveLog}
        onExport={() => {
          // The export is the filtered view, which is usually what you want
          // and occasionally very confusing — a file with the parents filtered
          // out looks like the extension lost them. It now says so.
          download(`residency-tab-${String(tabId)}.json`, {
            exportedAt: new Date().toISOString(),
            exported: visible.length,
            captured: data.records.length,
            filters: applied,
            tab: data.tab,
            records: visible,
          });
        }}
      />

      <div
        className={cx(
          'grid min-h-0',
          selected === null
            ? 'grid-cols-[200px_minmax(280px,1fr)]'
            : 'grid-cols-[200px_minmax(280px,1fr)_minmax(320px,32%)]',
        )}
      >
        <DomainList
          tab={data.tab}
          selectedHost={filters.host}
          onSelect={(host) => {
            setFilters((previous) => ({ ...previous, host }));
          }}
        />
        <RequestTable
          records={visible}
          total={data.records.length - (filters.showPreflights ? 0 : preflights)}
          selectedId={selectedId}
          onSelect={setSelectedId}
          scopedHost={filters.host}
          emptyMessage={emptyMessage}
        />
        {selected !== null && <DetailPane selected={selected} policy={data.policy} />}
      </div>

      <StatusLine
        tab={data.tab}
        preflights={filters.showPreflights ? 0 : preflights}
        unanswered={unanswered}
        reconnecting={reconnecting}
      />
    </>
  );
}

export function Panel({ tabId }: { readonly tabId: number }): ReactNode {
  const stream = usePanelStream(tabId);
  const hint = useSlowHint('Loading captured requests…', 'Waking the recorder…');
  const render = useCallback(
    (data: PanelData) => <Workspace data={data} tabId={tabId} stream={stream} />,
    [stream, tabId],
  );

  return (
    <main
      className="grid h-screen grid-rows-[auto_auto_minmax(0,1fr)_auto]"
      aria-busy={stream.state.status !== 'success'}
    >
      <h1 className="sr-only">Residency audit for the inspected tab</h1>
      <AsyncBoundary state={stream.state} fallback={<ListSkeleton rows={16} hint={hint} />}>
        {render}
      </AsyncBoundary>
    </main>
  );
}
