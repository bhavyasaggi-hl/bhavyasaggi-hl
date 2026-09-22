/** AI assist: draft or revise a policy with Chrome's on-device model. */

import { type ReactNode, useEffect, useId, useRef, useState } from 'preact/compat';
import { errorMessage } from '../../shared/logger.ts';
import { AVAILABILITY_HINTS, type Availability, checkAvailability, draftPolicy } from '../ai.ts';
import { Banner, Button, Card, Chip } from '../components/ui.tsx';
import { type AsyncState, failure, LOADING, success, UNINITIALIZED } from '../lib/async-state.ts';
import { analyze } from '../lib/policy-lint.ts';
import { draftToYaml, PRESETS } from '../policy-reference.ts';

interface Draft {
  readonly yaml: string;
  readonly headline: string;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

type ChipTone = 'neutral' | 'pass' | 'warn' | 'fail';

function toneFor(availability: Availability): ChipTone {
  if (availability === 'available') {
    return 'pass';
  }
  return availability === 'unsupported' || availability === 'unavailable' ? 'fail' : 'warn';
}

function review(yaml: string): Draft {
  const analysis = analyze(yaml);
  return analysis.valid
    ? {
        yaml,
        ok: true,
        headline: `Valid — ${String(analysis.assertionCount)} assertions in ${String(analysis.groupCount)} groups`,
        problems: analysis.outcome.warnings,
      }
    : { yaml, ok: false, headline: 'The draft does not parse', problems: analysis.outcome.errors };
}

function DraftPreview({
  draft,
  onApply,
  onDiscard,
}: {
  readonly draft: Draft;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
}): ReactNode {
  return (
    <div className="border-line mt-3 border-t pt-3">
      <Banner
        tone={draft.ok ? 'ok' : 'error'}
        headline={draft.headline}
        problems={draft.problems}
      />
      <pre className="border-line bg-surface mt-2 max-h-80 overflow-auto rounded border px-2.5 py-2 font-mono text-[12px] break-words whitespace-pre-wrap">
        {draft.yaml}
      </pre>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={onApply}>
          {draft.ok ? 'Use this draft' : 'Use it anyway'}
        </Button>
        <Button onClick={onDiscard}>Discard</Button>
        <span className="text-ink-muted ml-auto">
          Replaces the editor. Nothing is saved until you save.
        </span>
      </div>
    </div>
  );
}

/**
 * How the probe reads to the user.
 *
 * The probe has four outcomes, and a failed one must not read as a pending
 * one — that is the difference between "still looking" and "cannot look".
 */
function describeAvailability(
  availability: AsyncState<Availability>,
  ready: Availability | null,
): { readonly label: string; readonly hint: string; readonly tone: ChipTone } {
  if (availability.status === 'error') {
    return {
      label: 'unavailable',
      hint: `Could not check for the on-device model — ${availability.message}`,
      tone: 'fail',
    };
  }
  if (ready === null) {
    return {
      label: 'checking…',
      hint: 'Checking for the on-device model…',
      tone: 'neutral',
    };
  }
  return { label: ready, hint: AVAILABILITY_HINTS[ready], tone: toneFor(ready) };
}

/**
 * Suggestions are pure affordance, so they are withheld rather than disabled
 * when the model is missing: a dead chip is noise, and dimming an already-muted
 * colour drops it under the contrast floor. While a draft is generating they
 * stay legible and only stop responding.
 */
function PresetChips({
  onPick,
  busy,
}: {
  readonly onPick: (instruction: string) => void;
  readonly busy: boolean;
}): ReactNode {
  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Example instructions</legend>
      {PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          disabled={busy}
          onClick={() => {
            onPick(preset.instruction);
          }}
          className="border-line-strong text-ink-muted hover:text-ink rounded-full border border-dashed px-2.5 py-0.5 hover:border-solid disabled:cursor-not-allowed"
        >
          {preset.label}
        </button>
      ))}
    </fieldset>
  );
}

export function AiAssist({
  current,
  onApply,
}: {
  readonly current: string;
  readonly onApply: (yaml: string) => void;
}): ReactNode {
  const [availability, setAvailability] = useState<AsyncState<Availability>>(UNINITIALIZED);
  const [instruction, setInstruction] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [draft, setDraft] = useState<AsyncState<Draft>>(UNINITIALIZED);
  const abort = useRef<AbortController | null>(null);
  const instructionId = useId();

  useEffect(() => {
    let live = true;
    setAvailability(LOADING);
    void checkAvailability()
      .then((result) => {
        if (live) {
          setAvailability(success(result));
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setAvailability(failure(errorMessage(cause)));
        }
      });
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, []);

  const ready = availability.status === 'success' ? availability.data : null;
  const usable = ready !== null && ready !== 'unsupported' && ready !== 'unavailable';
  const busy = draft.status === 'loading';

  async function generate(useCurrent: boolean): Promise<void> {
    if (instruction.trim() === '') {
      setDraft(failure('Describe what the policy should enforce first.'));
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setDraft(LOADING);
    setStatus('Starting…');
    try {
      const generated = await draftPolicy({
        instruction,
        ...(useCurrent ? { current } : {}),
        signal: controller.signal,
        onStatus: setStatus,
        onDownload: (fraction) => {
          setProgress(fraction);
          setStatus(`Downloading the model — ${String(Math.round(fraction * 100))}%`);
        },
      });
      setDraft(success(review(draftToYaml(generated))));
    } catch (cause) {
      setDraft(failure(errorMessage(cause)));
    } finally {
      abort.current = null;
      setProgress(null);
      setStatus('');
    }
  }

  const { label, hint, tone } = describeAvailability(availability, ready);

  return (
    <Card title="AI assist" aside={<Chip tone={tone}>{label}</Chip>}>
      <p className="text-ink-muted m-0" aria-live="polite">
        {hint}
      </p>

      {/*
        The row keeps its height whether or not the chips are in it. The
        availability probe resolves after first paint, and letting the card grow
        at that moment pushed the editor below it down — a 0.11 layout shift on
        a page that is otherwise static.
      */}
      <div className="mt-2 min-h-7">
        {usable ? <PresetChips onPick={setInstruction} busy={busy} /> : null}
      </div>

      <label className="text-ink-muted mt-2 block" htmlFor={instructionId}>
        What should the policy enforce?
      </label>
      <textarea
        id={instructionId}
        rows={3}
        spellcheck={false}
        disabled={!usable || busy}
        value={instruction}
        onChange={(event) => {
          setInstruction(event.currentTarget.value);
        }}
        placeholder="Requests to *.api.acme.com must answer from eu-west-1 or eu-central-1, and never over plain http."
        className="border-line-strong bg-surface mt-1 mb-2 w-full resize-y rounded border px-2.5 py-2 disabled:border-line disabled:bg-sunken disabled:text-ink-muted"
      />

      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!usable || busy} onClick={() => void generate(false)}>
          Draft policy
        </Button>
        <Button disabled={!usable || busy} onClick={() => void generate(true)}>
          Improve current
        </Button>
        {busy && (
          <Button
            onClick={() => {
              abort.current?.abort();
            }}
          >
            Stop
          </Button>
        )}
        <span className="text-ink-muted ml-auto" aria-live="polite">
          {status}
        </span>
      </div>

      {progress !== null && (
        <progress className="mt-2 h-1.5 w-full" max={1} value={progress}>
          {Math.round(progress * 100)}%
        </progress>
      )}

      <div aria-live="polite">
        {draft.status === 'error' && (
          <div className="mt-3">
            <Banner tone="error" headline={draft.message} />
          </div>
        )}
        {draft.status === 'success' && (
          <DraftPreview
            draft={draft.data}
            onApply={() => {
              onApply(draft.data.yaml);
              setDraft(UNINITIALIZED);
            }}
            onDiscard={() => {
              setDraft(UNINITIALIZED);
            }}
          />
        )}
      </div>
    </Card>
  );
}
