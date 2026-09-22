/** Popup: at-a-glance residency for the active tab. */

import type { ReactNode } from 'preact/compat';
import type { DomainStats } from '../../shared/types.ts';
import { AsyncBoundary } from '../components/AsyncBoundary.tsx';
import { PopupSkeleton } from '../components/skeletons.tsx';
import { Banner, Button, PassRate, VerdictBar } from '../components/ui.tsx';
import { formatPercent, formatTime, rateTone } from '../lib/format.ts';
import { useSettledFlag } from '../lib/use-settled-flag.ts';
import { useSlowHint } from '../lib/use-slow-hint.ts';
import { type Snapshot, useTabSummary } from './useTabSummary.ts';

/**
 * No extension API opens DevTools, so the popup cannot start capture on its
 * own. It arms the tab instead: recording is stored immediately and takes
 * effect the moment DevTools attaches. This is the shortcut to get there.
 */
const DEVTOOLS_SHORTCUT = navigator.userAgent.includes('Mac') ? 'Option-Command-I' : 'F12';

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: string;
}): ReactNode {
  return (
    <div className="bg-surface px-2.5 py-2">
      <dd className={`m-0 text-[17px] font-semibold ${tone ?? ''}`}>{value}</dd>
      <dt className="text-ink-muted text-[12px] tracking-wide uppercase">{label}</dt>
    </div>
  );
}

function DomainRow({ stats }: { readonly stats: DomainStats }): ReactNode {
  return (
    <li className="border-line border-b px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold break-all">{stats.host}</span>
        <span className="ml-auto">
          <PassRate rate={stats.passRate} />
        </span>
      </div>
      <p className="text-ink-muted m-0 text-[12px]">
        {stats.total} requests · {stats.pass} pass · {stats.fail} fail ·{' '}
        {stats.notApplicable + stats.pending} unscoped
      </p>
      <div className="mt-1">
        <VerdictBar counts={stats} />
      </div>
    </li>
  );
}

/** What the tab is doing, in the one word the footer has room for. */
function statusWord(tab: Snapshot['tab'], reconnecting: boolean): string {
  if (reconnecting) {
    return 'reconnecting…';
  }
  if (!tab.recording) {
    return 'paused';
  }
  return tab.devtoolsAttached ? 'recording' : 'armed';
}

/** The same distinction, spelled out for someone looking at an empty list. */
function emptyReason(tab: Snapshot['tab']): string {
  if (!tab.recording) {
    return 'This tab is not being recorded.';
  }
  return tab.devtoolsAttached
    ? 'Recording. Reload the page to capture it from the start.'
    : 'Armed — capture starts when DevTools opens.';
}

function Domains({
  tab,
  onRecord,
}: {
  readonly tab: Snapshot['tab'];
  readonly onRecord: () => void;
}): ReactNode {
  if (tab.domains.length > 0) {
    return (
      <ul className="min-h-20 flex-1 overflow-y-auto">
        {tab.domains.map((stats) => (
          <DomainRow key={stats.host} stats={stats} />
        ))}
      </ul>
    );
  }
  return (
    <div className="flex-1 px-3 py-6 text-center">
      <p className="text-ink-muted m-0">{emptyReason(tab)}</p>
      {!tab.recording && (
        <Button variant="primary" className="mt-3" onClick={onRecord}>
          Record this tab
        </Button>
      )}
    </div>
  );
}

function Summary({
  snapshot,
  onClear,
  onRecord,
  reconnecting,
}: {
  readonly snapshot: Snapshot;
  readonly onClear: () => void;
  readonly onRecord: () => void;
  readonly reconnecting: boolean;
}): ReactNode {
  const { tab, config } = snapshot;
  const totals = tab.totals;
  return (
    <>
      {!config.valid && (
        <div className="p-3 pb-0">
          <Banner
            tone="error"
            headline="Policy has errors and was not applied."
            problems={config.errors.slice(0, 3)}
          />
        </div>
      )}

      <dl className="bg-line border-line m-0 grid grid-cols-4 gap-px border-b">
        <Stat label="Requests" value={String(totals.total)} />
        <Stat
          label="Pass rate"
          value={formatPercent(totals.passRate)}
          tone={rateTone(totals.passRate)}
        />
        <Stat
          label="Failing"
          value={String(totals.fail)}
          tone={totals.fail > 0 ? 'text-fail' : ''}
        />
        <Stat label="Unscoped" value={String(totals.notApplicable + totals.pending)} />
      </dl>

      <Domains tab={tab} onRecord={onRecord} />

      {tab.devtoolsAttached ? null : (
        <p className="border-line bg-sunken text-ink-muted m-0 border-t px-3 py-2">
          Requests are read from DevTools, so capture needs it open (
          <strong className="text-ink font-semibold">{DEVTOOLS_SHORTCUT}</strong>). Closing it stops
          the recording.
        </p>
      )}

      <footer className="border-line bg-sunken flex items-center gap-2 border-t px-3 py-2">
        <Button variant={tab.recording ? 'default' : 'primary'} onClick={onRecord}>
          {tab.recording ? 'Stop recording' : 'Record this tab'}
        </Button>
        <Button onClick={onClear}>Clear</Button>
        <span className="text-ink-muted ml-auto tabular-nums">
          {statusWord(tab, reconnecting)}
          {totals.total === 0 ? '' : ` · since ${formatTime(tab.recordingStartedAt)}`}
        </span>
      </footer>
    </>
  );
}

export function Popup(): ReactNode {
  const stream = useTabSummary();
  const state = stream.state;
  // A worker eviction drops the port and it is back in a moment; only a wait
  // long enough to notice is worth saying out loud.
  const reconnecting = useSettledFlag(!stream.connected);

  const policy = state.status === 'success' ? state.data.config : null;
  const hint = useSlowHint('Reading captures…', 'Waking the recorder…');

  return (
    <main className="flex max-h-[580px] w-[400px] flex-col" aria-busy={state.status !== 'success'}>
      <header className="border-line bg-sunken flex items-center gap-2 border-b px-3 py-2.5">
        <div>
          <h1 className="text-[13px] font-semibold">Residency Auditor</h1>
          <p className="text-ink-muted m-0 text-[12px]">
            {policy === null
              ? 'Loading policy…'
              : `${policy.name} · ${policy.assertionCount} assertions in ${policy.groupCount} groups`}
          </p>
        </div>
        <Button
          className="ml-auto"
          onClick={() => {
            void chrome.runtime.openOptionsPage();
          }}
        >
          Policy
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col" aria-live="polite">
        <AsyncBoundary state={state} fallback={<PopupSkeleton hint={hint} />}>
          {(snapshot) => (
            <Summary
              snapshot={snapshot}
              onClear={stream.clear}
              onRecord={() => {
                stream.setRecording(!snapshot.tab.recording);
              }}
              reconnecting={reconnecting}
            />
          )}
        </AsyncBoundary>
      </div>
    </main>
  );
}
