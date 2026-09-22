/** Policy editor card: CodeMirror with the extension's own linter, plus format and save. */

import { autocompletion } from '@codemirror/autocomplete';
import { type ReactNode, useMemo, useState } from 'preact/compat';
import { errorMessage } from '../../shared/logger.ts';
import { CodeEditor } from '../components/CodeEditor.tsx';
import { Button, Card, Chip } from '../components/ui.tsx';
import { analyze, formatPolicy, policyCompletion } from '../lib/policy-lint.ts';
import { useDebounced } from '../lib/use-debounced.ts';

const SUMMARY_DEBOUNCE_MS = 300;

export function PolicyEditor({
  value,
  dirty,
  busy,
  onChange,
  onSave,
  onReset,
}: {
  readonly value: string;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
}): ReactNode {
  const [formatError, setFormatError] = useState<string | null>(null);
  const settled = useDebounced(value, SUMMARY_DEBOUNCE_MS);
  const analysis = useMemo(() => analyze(settled), [settled]);
  const completion = useMemo(() => autocompletion({ override: [policyCompletion] }), []);

  const errors = analysis.diagnostics.filter((entry) => entry.severity === 'error').length;
  const warnings = analysis.diagnostics.filter((entry) => entry.severity === 'warning').length;

  return (
    <Card
      className="flex min-h-0 flex-col"
      title={<h2 className="text-[13px] font-semibold">Policy document</h2>}
      aside={
        <div className="flex items-center gap-2">
          {errors > 0 && <Chip tone="fail">{errors === 1 ? '1 error' : `${errors} errors`}</Chip>}
          {errors === 0 && warnings > 0 && (
            <Chip tone="warn">{warnings === 1 ? '1 warning' : `${warnings} warnings`}</Chip>
          )}
          {errors === 0 && warnings === 0 && <Chip tone="pass">no problems</Chip>}
          <span className="text-ink-muted">{dirty ? 'unsaved changes' : 'saved'}</span>
        </div>
      }
    >
      <div className="border-line-strong h-[52vh] min-h-64 overflow-hidden rounded border">
        <CodeEditor
          value={value}
          onChange={onChange}
          lintSource={(text) => analyze(text).diagnostics}
          completion={completion}
          ariaLabel="Residency policy document"
          className="h-full"
        />
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={onSave} disabled={busy}>
          {busy ? 'Saving…' : 'Save policy'}
        </Button>
        <Button
          onClick={() => {
            try {
              onChange(formatPolicy(value));
              setFormatError(null);
            } catch (cause) {
              setFormatError(errorMessage(cause));
            }
          }}
          title="Re-indent and normalise the document, preserving comments"
        >
          Format
        </Button>
        <Button onClick={onReset} disabled={busy}>
          Restore starter policy
        </Button>
        <span className="text-ink-muted ml-auto">
          {formatError ??
            'Ctrl/Cmd+F searches · Ctrl/Cmd+Space completes operators and expressions'}
        </span>
      </div>
    </Card>
  );
}
