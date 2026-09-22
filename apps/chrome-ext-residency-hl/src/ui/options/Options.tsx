/** Options page shell: load the policy, edit it, save it. */

import { type ReactNode, useCallback, useEffect, useState } from 'preact/compat';
import { errorMessage } from '../../shared/logger.ts';
import { sendMessage } from '../../shared/messages.ts';
import type { ConfigStatus } from '../../shared/types.ts';
import { AsyncBoundary } from '../components/AsyncBoundary.tsx';
import { OptionsSkeleton } from '../components/skeletons.tsx';
import { Banner } from '../components/ui.tsx';
import { type AsyncState, failure, LOADING, success, UNINITIALIZED } from '../lib/async-state.ts';
import { useSlowHint } from '../lib/use-slow-hint.ts';
import { AiAssist } from './AiAssist.tsx';
import { PolicyEditor } from './PolicyEditor.tsx';
import { Reference } from './Reference.tsx';

interface Loaded {
  readonly text: string;
  readonly status: ConfigStatus;
}

function SavedPolicyBanner({
  status,
  note,
}: {
  readonly status: ConfigStatus;
  readonly note: string | null;
}): ReactNode {
  return (
    <Banner
      tone={status.valid ? 'ok' : 'error'}
      headline={
        status.valid
          ? `${status.name} — ${status.assertionCount} assertions in ${status.groupCount} groups${note === null ? '' : ` · ${note}`}`
          : 'Not applied — the saved document has errors'
      }
      problems={[...status.errors, ...status.warnings]}
    />
  );
}

function Editor({ loaded }: { readonly loaded: Loaded }): ReactNode {
  const [text, setText] = useState(loaded.text);
  const [saved, setSaved] = useState(loaded.text);
  const [status, setStatus] = useState(loaded.status);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState<AsyncState<ConfigStatus>>(UNINITIALIZED);

  const run = useCallback(async (action: 'save' | 'reset', body: string): Promise<void> => {
    setSaving(LOADING);
    try {
      const response =
        action === 'save'
          ? await sendMessage({ type: 'setConfig', text: body })
          : await sendMessage({ type: 'resetConfig' });
      setStatus(response.status);
      setSaving(success(response.status));
      if (action === 'reset') {
        setText(response.text);
        setSaved(response.text);
        setNote('starter policy restored');
      } else if (response.status.valid) {
        setSaved(body);
        setNote('saved');
      } else {
        setNote(null);
      }
    } catch (cause) {
      setSaving(failure(errorMessage(cause)));
    }
  }, []);

  return (
    <>
      {status.migrationNotes.length > 0 && (
        <div className="mb-3.5">
          <Banner
            tone="warn"
            headline="This policy was rewritten onto the OpenCollection document shape."
            problems={[...status.migrationNotes, 'Review it below and save to keep the rewrite.']}
          />
        </div>
      )}

      <div className="mb-3.5" aria-live="polite">
        {saving.status === 'error' ? (
          <Banner tone="error" headline={saving.message} />
        ) : (
          <SavedPolicyBanner status={status} note={note} />
        )}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <AiAssist current={text} onApply={setText} />
          <PolicyEditor
            value={text}
            dirty={text !== saved}
            busy={saving.status === 'loading'}
            onChange={(next) => {
              setText(next);
              setNote(null);
            }}
            onSave={() => void run('save', text)}
            onReset={() => void run('reset', text)}
          />
        </div>
        <Reference />
      </div>
    </>
  );
}

export function Options(): ReactNode {
  const [state, setState] = useState<AsyncState<Loaded>>(UNINITIALIZED);
  const hint = useSlowHint('Reading the saved policy…', 'Waking the recorder…');

  useEffect(() => {
    let live = true;
    setState(LOADING);
    void (async (): Promise<void> => {
      try {
        const loaded = await sendMessage({ type: 'getConfig' });
        if (live) {
          setState(success(loaded));
        }
      } catch (cause) {
        if (live) {
          setState(failure(errorMessage(cause)));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="mx-auto max-w-[1280px] px-5 pt-5 pb-12" aria-busy={state.status !== 'success'}>
      <header className="mb-3.5">
        <h1 className="text-lg font-semibold">Residency policy</h1>
        <p className="text-ink-muted max-w-[70ch]">
          Rules in the OpenCollection{' '}
          <a
            className="text-brand underline"
            href="https://docs.usebruno.com/opencollection-yaml/structure-reference#runtime-assertions"
            target="_blank"
            rel="noreferrer noopener"
          >
            runtime-assertions
          </a>{' '}
          dialect. Saving applies to requests captured from then on.
        </p>
      </header>

      <AsyncBoundary state={state} fallback={<OptionsSkeleton hint={hint} />}>
        {(loaded) => <Editor loaded={loaded} />}
      </AsyncBoundary>
    </main>
  );
}
