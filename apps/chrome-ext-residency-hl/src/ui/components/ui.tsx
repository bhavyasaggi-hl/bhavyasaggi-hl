/** Small presentational primitives shared by the popup, panel and options page. */

import type { ButtonHTMLAttributes, ReactNode } from 'preact/compat';
import type { Verdict } from '../../shared/types.ts';
import { cx } from '../lib/cx.ts';
import { formatPercent, rateTone } from '../lib/format.ts';

const VERDICT_STYLE: Readonly<Record<string, string>> = {
  pass: 'text-pass bg-pass-soft',
  fail: 'text-fail bg-fail-soft',
  'not-applicable': 'text-na bg-na-soft',
  pending: 'text-na bg-na-soft',
};

const VERDICT_LABEL: Readonly<Record<string, string>> = {
  pass: 'Pass',
  fail: 'Fail',
  'not-applicable': 'N/A',
  pending: 'Pending',
};

export function Chip({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'pass' | 'warn' | 'fail';
  children: ReactNode;
  className?: string;
}): ReactNode {
  const tones = {
    neutral: 'text-na bg-na-soft',
    pass: 'text-pass bg-pass-soft',
    warn: 'text-warn bg-warn-soft',
    fail: 'text-fail bg-fail-soft',
  } as const;
  return (
    <span
      className={cx(
        'inline-block rounded-full px-2 py-px text-[12px] font-semibold whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict: Verdict }): ReactNode {
  return (
    <span
      className={cx(
        'inline-block rounded-full px-2 py-px text-[12px] font-semibold whitespace-nowrap',
        VERDICT_STYLE[verdict] ?? VERDICT_STYLE['pending'],
      )}
    >
      {VERDICT_LABEL[verdict] ?? verdict}
    </span>
  );
}

export interface VerdictCounts {
  readonly pass: number;
  readonly fail: number;
  readonly notApplicable: number;
  readonly pending: number;
}

export function VerdictBar({ counts }: { counts: VerdictCounts }): ReactNode {
  const unscoped = counts.notApplicable + counts.pending;
  const total = counts.pass + counts.fail + unscoped;
  const segments = [
    { key: 'pass', value: counts.pass, className: 'bg-pass' },
    { key: 'fail', value: counts.fail, className: 'bg-fail' },
    { key: 'na', value: unscoped, className: 'bg-na' },
  ].filter((segment) => segment.value > 0);

  return (
    <div
      className="bg-na-soft flex h-1.5 w-full overflow-hidden rounded-full"
      role="img"
      aria-label={`${counts.pass} passing, ${counts.fail} failing, ${unscoped} unscoped`}
    >
      {total > 0 &&
        segments.map((segment) => (
          <span
            key={segment.key}
            className={segment.className}
            style={{ width: `${(segment.value / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

export function PassRate({ rate }: { rate: number | null }): ReactNode {
  return (
    <span className={cx('font-semibold tabular-nums', rateTone(rate))}>{formatPercent(rate)}</span>
  );
}

export function Button({
  variant = 'default',
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  variant?: 'default' | 'primary' | 'ghost';
  className?: string;
}): ReactNode {
  const variants = {
    default: 'border-line-strong bg-raised hover:border-brand',
    primary: 'border-brand bg-brand text-brand-ink hover:opacity-90',
    ghost: 'border-transparent hover:border-line-strong',
  } as const;
  return (
    <button
      type="button"
      {...props}
      className={cx(
        // A disabled button goes flat grey rather than translucent: fading a
        // variant halves its contrast against the page and leaves the label
        // unreadable, which is the opposite of what "unavailable" should mean.
        'rounded border px-2.5 py-1 text-[13px]',
        'disabled:cursor-not-allowed disabled:border-line disabled:bg-sunken disabled:text-ink-muted disabled:hover:border-line disabled:hover:opacity-100',
        variants[variant],
        className,
      )}
    />
  );
}

export function Card({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={cx('border-line bg-raised rounded-lg border p-3.5', className)}>
      {(title !== undefined || aside !== undefined) && (
        <header className="mb-1.5 flex items-center gap-2">
          {typeof title === 'string' ? (
            <h2 className="text-[13px] font-semibold">{title}</h2>
          ) : (
            title
          )}
          <div className="ml-auto">{aside}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Banner({
  tone,
  headline,
  problems,
  max = 8,
}: {
  tone: 'ok' | 'warn' | 'error';
  headline: ReactNode;
  problems?: readonly string[];
  max?: number;
}): ReactNode {
  const shown = (problems ?? []).slice(0, max);
  const hidden = (problems ?? []).length - shown.length;
  return (
    <div
      className={cx(
        'rounded border px-3 py-2',
        {
          ok: 'border-pass bg-pass-soft text-pass',
          warn: 'border-warn bg-warn-soft text-warn',
          error: 'border-fail bg-fail-soft text-fail',
        }[tone],
      )}
    >
      <strong className="font-semibold">{headline}</strong>
      {shown.length > 0 && (
        <ul className="mt-1.5 list-disc pl-5">
          {shown.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
          {hidden > 0 && <li className="opacity-70">…and {hidden} more</li>}
        </ul>
      )}
    </div>
  );
}
