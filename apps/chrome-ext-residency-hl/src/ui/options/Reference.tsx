/** Compact reference column: one line per key, expression, operator and verdict. */

import type { ReactNode } from 'preact/compat';
import { OPERATOR_NAMES } from '../../engine/operators.ts';
import { Card } from '../components/ui.tsx';
import {
  ASSERTION_FIELDS,
  EXPRESSIONS,
  type ReferenceRow,
  SCRIPT_FIELDS,
  SCRIPT_GLOBALS,
  STRUCTURE,
  VERDICTS,
} from '../policy-reference.ts';

function Table({ rows }: { rows: readonly ReferenceRow[] }): ReactNode {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {rows.map((row) => (
          <tr key={row.term} className="border-line border-b last:border-0">
            <td className="text-brand w-px py-1 pr-3 align-top font-mono text-[11.5px] whitespace-nowrap">
              {row.term}
            </td>
            <td className="py-1 align-top">{row.meaning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Reference(): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <Card title="How it works">
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>
            Every request a tab makes is matched against each{' '}
            <code className="font-mono">items[]</code> — an item describes requests to match, not
            requests to send.
          </li>
          <li>The assertions and tests of every matching item run against that request.</li>
          <li>The panel reports the verdict per request and the pass rate per domain.</li>
        </ul>
      </Card>

      <Card title="Document structure">
        <Table rows={STRUCTURE} />
      </Card>

      <Card title="Assertion fields">
        <Table rows={ASSERTION_FIELDS} />
      </Card>

      <Card title="Scripts">
        <p className="text-ink-muted mb-1">
          For checks that need logic. Only <code className="font-mono">type: tests</code> is
          supported — this audits requests a page already sent, so there is nothing to run before
          one. Scripts run in a sandbox with no access to the browser, the extension or the network.
        </p>
        <Table rows={SCRIPT_FIELDS} />
        <h3 className="text-ink-muted mt-2.5 mb-1 text-[12px] font-semibold tracking-wide uppercase">
          In scope
        </h3>
        <Table rows={SCRIPT_GLOBALS} />
      </Card>

      <Card title="Expressions">
        <p className="text-ink-muted mb-1">
          Property paths, not code. A missing path resolves to{' '}
          <code className="font-mono">undefined</code>; header lookups ignore case.
        </p>
        <Table rows={EXPRESSIONS} />
      </Card>

      <Card title="Operators">
        <div className="flex flex-wrap gap-1">
          {[...OPERATOR_NAMES]
            .sort((left, right) => left.localeCompare(right))
            .map((name) => (
              <code
                key={name}
                className="border-line bg-sunken rounded border px-1.5 py-px font-mono text-[11.5px]"
              >
                {name}
              </code>
            ))}
        </div>
        <p className="text-ink-muted mt-2">
          <code className="font-mono">inCidr</code> and <code className="font-mono">notInCidr</code>{' '}
          accept one or more CIDR ranges, comma separated.
        </p>
      </Card>

      <Card title="Verdicts">
        <Table rows={VERDICTS} />
        <p className="text-ink-muted mt-2">
          Pass rate counts judged requests only — unscoped and pending are excluded.
        </p>
      </Card>
    </div>
  );
}
