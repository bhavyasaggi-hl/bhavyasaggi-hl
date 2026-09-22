/**
 * First-paint placeholders.
 *
 * A popup or panel opens with nothing on screen until the bundle parses and the
 * service worker answers, which can take a moment if the worker was asleep.
 * These shapes mirror the real layout so the surface looks like it is arriving
 * rather than stuck, and the same components back the `loading` state so there
 * is no flash when React takes over.
 */

import type { ReactNode } from 'preact/compat';
import { cx } from '../lib/cx.ts';

function Bone({ className }: { readonly className?: string }): ReactNode {
  return <span className={cx('bg-line block animate-pulse rounded', className)} />;
}

export function PopupSkeleton({ hint }: { readonly hint: string }): ReactNode {
  return (
    <div className="flex flex-1 flex-col" role="status" aria-label={hint}>
      <div className="bg-line border-line grid grid-cols-4 gap-px border-b">
        {[0, 1, 2, 3].map((cell) => (
          <div key={cell} className="bg-surface px-2.5 py-2">
            <Bone className="h-4 w-8" />
            <Bone className="mt-1.5 h-2 w-12" />
          </div>
        ))}
      </div>
      {[0, 1, 2].map((row) => (
        <div key={row} className="border-line border-b px-3 py-2">
          <Bone className="h-3 w-40" />
          <Bone className="mt-1.5 h-2 w-52" />
          <Bone className="mt-1.5 h-1.5 w-full" />
        </div>
      ))}
      <p className="text-ink-muted px-3 py-3 text-center">{hint}</p>
    </div>
  );
}

/**
 * Placeholder shaped like the options page, not like a list.
 *
 * The options layout is static — a two-column grid with a fixed-height editor —
 * so only its contents are actually waiting. Standing in with a list-shaped
 * block meant the page relaid out when the policy arrived, which measured as a
 * 0.11 cumulative layout shift. Reserving the real shape costs nothing and
 * removes the jump.
 */
export function OptionsSkeleton({ hint }: { readonly hint: string }): ReactNode {
  return (
    <>
      {/* The policy-status banner appears with the content; hold its row. */}
      <div className="mb-3.5">
        <Bone className="h-9 w-full rounded" />
      </div>
      <div
        className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"
        role="status"
        aria-label={hint}
      >
        <div className="flex min-w-0 flex-col gap-3.5">
          <div className="border-line bg-raised rounded-lg border p-3.5">
            <Bone className="mb-2 h-4 w-32" />
            <Bone className="h-4 w-full" />
          </div>
          <div className="border-line bg-raised rounded-lg border p-3.5">
            <Bone className="mb-2 h-4 w-40" />
            <div className="border-line-strong h-[52vh] min-h-64 overflow-hidden rounded border p-2">
              {Array.from({ length: 14 }, (_, row) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
                <Bone key={row} className="mb-1 h-4 w-full" />
              ))}
            </div>
            <p className="text-ink-muted mt-2.5 text-center">{hint}</p>
          </div>
        </div>
        <div className="border-line bg-raised rounded-lg border p-3.5">
          {Array.from({ length: 10 }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
            <Bone key={row} className="mb-1.5 h-4 w-full" />
          ))}
        </div>
      </div>
    </>
  );
}

export function ListSkeleton({
  rows = 12,
  hint,
}: {
  readonly rows?: number;
  readonly hint: string;
}): ReactNode {
  return (
    <div className="p-2" role="status" aria-label={hint}>
      {Array.from({ length: rows }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
        <Bone key={row} className="mb-1 h-4 w-full" />
      ))}
      <p className="text-ink-muted mt-3 text-center">{hint}</p>
    </div>
  );
}
