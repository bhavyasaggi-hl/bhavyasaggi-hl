/**
 * Virtualized request list.
 *
 * A busy page produces thousands of rows and the stream repaints several times
 * a second, so only the visible window is mounted. That rules out a `<table>`
 * — virtualization needs absolutely positioned rows — so the list is a div
 * based ARIA grid instead, with a roving tabindex: one row is in the tab order
 * and the arrow keys move between rows.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'preact/compat';
import type { LiteRecord } from '../../shared/types.ts';
import { VerdictChip } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { formatBytes, formatDuration } from '../lib/format.ts';
import { ALL, bucketOf, sizeOf, statusText } from './filters.ts';

const ROW_HEIGHT = 22;
const OVERSCAN = 14;
const AUTOSCROLL_SLACK_PX = 24;
const COLUMNS = 'grid-cols-[62px_minmax(0,1fr)_80px_56px_56px_66px_64px_64px_132px]';

interface Column {
  readonly key: string;
  readonly label: string;
  readonly numeric?: boolean;
}

const COLUMN_DEFS: readonly Column[] = [
  { key: 'verdict', label: 'Verdict' },
  { key: 'name', label: 'Name' },
  { key: 'method', label: 'Method' },
  { key: 'status', label: 'Status', numeric: true },
  { key: 'type', label: 'Type' },
  { key: 'asserts', label: 'Asserts', numeric: true },
  { key: 'size', label: 'Size', numeric: true },
  { key: 'time', label: 'Time', numeric: true },
  { key: 'waterfall', label: 'Waterfall' },
];

function assertionSummary(record: LiteRecord): string {
  const results = record.evaluation?.results ?? [];
  return results.length === 0
    ? '—'
    : `${results.filter((result) => result.passed).length}/${results.length}`;
}

/** Screen-reader sentence for a row, since nine terse cells do not read well. */
function rowLabel(record: LiteRecord): string {
  const verdict = record.evaluation?.verdict ?? 'pending';
  const preflight = record.resourceType === 'preflight' ? ', CORS preflight' : '';
  return `${verdict}, ${record.method} ${record.host}${record.path}, status ${statusText(record)}, ${assertionSummary(record)} assertions passed${preflight}`;
}

function Waterfall({
  record,
  baseline,
  span,
}: {
  readonly record: LiteRecord;
  readonly baseline: number;
  readonly span: number;
}): ReactNode {
  const start = Math.min(Math.max(((record.startedAt - baseline) / span) * 100, 0), 100);
  const width = Math.max(Math.min(((record.responseTime ?? 0) / span) * 100, 100 - start), 0.6);
  const verdict = record.evaluation?.verdict;
  const tone = verdict === 'pass' ? 'bg-pass' : verdict === 'fail' ? 'bg-fail' : 'bg-na';
  return (
    <div className="flex h-full items-center px-1.5">
      <div
        className={cx('h-1.5 min-w-0.5 rounded-sm', tone)}
        style={{ marginLeft: `${String(start)}%`, width: `${String(width)}%` }}
      />
    </div>
  );
}

function Row({
  record,
  index,
  selected,
  focusable,
  scopedHost,
  baseline,
  span,
  onSelect,
  onKeyDown,
  style,
}: {
  readonly record: LiteRecord;
  readonly index: number;
  readonly selected: boolean;
  readonly focusable: boolean;
  readonly scopedHost: string;
  readonly baseline: number;
  readonly span: number;
  readonly onSelect: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly style: CSSProperties;
}): ReactNode {
  const verdict = record.evaluation?.verdict ?? 'pending';
  const cell = 'truncate px-1.5';
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      aria-label={rowLabel(record)}
      tabIndex={focusable ? 0 : -1}
      data-row-index={index}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      style={style}
      className={cx(
        'border-line absolute inset-x-0 grid items-center border-b',
        COLUMNS,
        selected
          ? 'bg-brand text-brand-ink'
          : verdict === 'fail'
            ? 'bg-fail-soft/60 hover:bg-sunken'
            : 'hover:bg-sunken',
      )}
    >
      <div role="gridcell" className="px-1.5">
        <VerdictChip verdict={verdict} />
      </div>
      <div role="gridcell" className={cx(cell, 'font-mono')} title={record.url}>
        {scopedHost === ALL && (
          <span className={selected ? 'opacity-80' : 'text-ink-muted'}>{record.host} </span>
        )}
        {record.path === '' ? '/' : record.path}
      </div>
      <div role="gridcell" className={cx(cell, 'font-mono')}>
        {record.method}
      </div>
      <div role="gridcell" className={cx(cell, 'text-right font-mono')}>
        {statusText(record)}
      </div>
      <div role="gridcell" className={cell}>
        {bucketOf(record)}
      </div>
      <div role="gridcell" className={cx(cell, 'text-right tabular-nums')}>
        {assertionSummary(record)}
      </div>
      <div role="gridcell" className={cx(cell, 'text-right font-mono tabular-nums')}>
        {formatBytes(sizeOf(record))}
      </div>
      <div role="gridcell" className={cx(cell, 'text-right font-mono tabular-nums')}>
        {formatDuration(record.responseTime)}
      </div>
      <div role="gridcell">
        <Waterfall record={record} baseline={baseline} span={span} />
      </div>
    </div>
  );
}

export function RequestTable({
  records,
  total,
  selectedId,
  onSelect,
  scopedHost,
  emptyMessage,
}: {
  readonly records: readonly LiteRecord[];
  readonly total: number;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly scopedHost: string;
  readonly emptyMessage: string;
}): ReactNode {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const { baseline, span } = useMemo(() => {
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;
    for (const record of records) {
      earliest = Math.min(earliest, record.startedAt);
      latest = Math.max(latest, record.completedAt ?? record.startedAt);
    }
    return Number.isFinite(earliest)
      ? { baseline: earliest, span: Math.max(latest - earliest, 1) }
      : { baseline: 0, span: 1 };
  }, [records]);

  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  useEffect(() => {
    if (stick.current && records.length > 0) {
      virtualizer.scrollToIndex(records.length - 1);
    }
  }, [records.length, virtualizer]);

  const selectedIndex = records.findIndex((record) => record.id === selectedId);
  const focusIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const move = useCallback(
    (from: number, delta: number): void => {
      const next = Math.min(Math.max(from + delta, 0), records.length - 1);
      const record = records[next];
      if (record === undefined || next === from) {
        return;
      }
      onSelect(record.id);
      virtualizer.scrollToIndex(next);
      requestAnimationFrame(() => {
        scroller.current?.querySelector<HTMLElement>(`[data-row-index="${String(next)}"]`)?.focus();
      });
    },
    [records, onSelect, virtualizer],
  );

  const onRowKeyDown = useCallback(
    (index: number) =>
      (event: KeyboardEvent<HTMLDivElement>): void => {
        const steps: Readonly<Record<string, number>> = {
          ArrowDown: 1,
          ArrowUp: -1,
          PageDown: 10,
          PageUp: -10,
        };
        const record = records[index];
        if ((event.key === 'Enter' || event.key === ' ') && record !== undefined) {
          event.preventDefault();
          onSelect(record.id);
          return;
        }
        const delta = steps[event.key];
        if (delta !== undefined) {
          event.preventDefault();
          move(index, delta);
        }
      },
    [move, onSelect, records],
  );

  return (
    <section className="flex min-h-0 flex-col" aria-label="Captured requests">
      <div
        role="grid"
        aria-rowcount={records.length + 1}
        aria-colcount={COLUMN_DEFS.length}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div
          role="row"
          aria-rowindex={1}
          className={cx(
            'border-line bg-sunken text-ink-muted grid border-b text-[12px] font-semibold tracking-wide uppercase',
            COLUMNS,
          )}
        >
          {COLUMN_DEFS.map((column) => (
            <div
              key={column.key}
              role="columnheader"
              className={cx('truncate px-1.5 py-1', column.numeric === true && 'text-right')}
            >
              {column.label}
            </div>
          ))}
        </div>

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current =
              node.scrollTop + node.clientHeight >= node.scrollHeight - AUTOSCROLL_SLACK_PX;
          }}
        >
          {records.length === 0 ? (
            <p className="text-ink-muted px-3 py-6 text-center">{emptyMessage}</p>
          ) : (
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              role="rowgroup"
            >
              {virtualizer.getVirtualItems().map((item) => {
                const record = records[item.index];
                return record === undefined ? null : (
                  <Row
                    key={record.id}
                    record={record}
                    index={item.index}
                    selected={record.id === selectedId}
                    focusable={item.index === focusIndex}
                    scopedHost={scopedHost}
                    baseline={baseline}
                    span={span}
                    style={{ height: item.size, transform: `translateY(${String(item.start)}px)` }}
                    onSelect={() => {
                      onSelect(record.id);
                    }}
                    onKeyDown={onRowKeyDown(item.index)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      <p className="border-line bg-sunken text-ink-muted m-0 border-t px-2 py-0.5 tabular-nums">
        {records.length} shown of {total} requests
      </p>
    </section>
  );
}
