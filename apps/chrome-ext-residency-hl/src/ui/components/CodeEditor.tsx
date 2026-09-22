/**
 * CodeMirror 6 wrapper.
 *
 * CodeMirror was chosen over Monaco or Ace because it needs no web workers —
 * which keeps the MV3 bundle simple — and because `@codemirror/lint` accepts an
 * arbitrary diagnostic source, so the extension's own policy parser drives the
 * squiggles directly instead of a generic YAML schema check.
 */

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { type Diagnostic, linter, lintGutter, lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { type ReactNode, useEffect, useRef } from 'preact/compat';

/** Colours come from the Tailwind theme tokens so the editor follows the OS scheme. */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--color-brand)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-pass)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-warn)' },
  { tag: tags.comment, color: 'var(--color-ink-muted)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.atom], color: 'var(--color-warn)' },
  { tag: tags.punctuation, color: 'var(--color-ink-muted)' },
]);

/*
 * CodeMirror ships light and dark base themes and picks one from a static
 * `dark` flag, which cannot follow `prefers-color-scheme`. Every surface the
 * base theme paints — panels, the search field, buttons, tooltips — is
 * therefore restyled here from the same tokens as the rest of the extension,
 * so the search bar matches the editor in both schemes.
 */
const theme = EditorView.theme({
  '&': {
    color: 'var(--color-ink)',
    backgroundColor: 'var(--color-surface)',
    colorScheme: 'light dark',
    fontSize: '12.5px',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-sunken)',
    color: 'var(--color-ink-muted)',
    border: 'none',
    borderRight: '1px solid var(--color-line)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-ink)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-brand) 7%, transparent)' },
  '.cm-content': { caretColor: 'var(--color-brand)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-brand)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-brand) 28%, transparent)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--color-warn) 25%, transparent)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--color-warn) 30%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--color-warn) 60%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--color-brand) 45%, transparent)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-sunken)',
    border: '1px solid var(--color-line)',
    color: 'var(--color-ink-muted)',
  },

  // Panels: the search bar and the lint list.
  '.cm-panels': {
    backgroundColor: 'var(--color-sunken)',
    color: 'var(--color-ink)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--color-line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--color-line)' },
  '.cm-panel': { padding: '4px 6px' },
  '.cm-panel label': { color: 'var(--color-ink-muted)' },
  '.cm-textfield': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-ink)',
    border: '1px solid var(--color-line-strong)',
    borderRadius: '4px',
    padding: '2px 6px',
  },
  '.cm-textfield:focus-visible': { outline: '2px solid var(--color-brand)', outlineOffset: '1px' },
  '.cm-button': {
    backgroundColor: 'var(--color-raised)',
    backgroundImage: 'none',
    color: 'var(--color-ink)',
    border: '1px solid var(--color-line-strong)',
    borderRadius: '4px',
    padding: '2px 8px',
  },
  '.cm-button:hover': { borderColor: 'var(--color-brand)' },
  '.cm-button:active': { backgroundColor: 'var(--color-sunken)' },
  '.cm-panel input[type=checkbox]': { accentColor: 'var(--color-brand)' },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--color-ink-muted)',
    backgroundColor: 'transparent',
    border: '0',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': { color: 'var(--color-ink)' },
  '.cm-panel.cm-panel-lint ul li': { color: 'var(--color-ink)' },
  '.cm-panel.cm-panel-lint ul [aria-selected]': {
    backgroundColor: 'var(--color-brand)',
    color: 'var(--color-brand-ink)',
  },

  // Tooltips: autocompletion and lint bubbles.
  '.cm-tooltip': {
    backgroundColor: 'var(--color-raised)',
    border: '1px solid var(--color-line-strong)',
    borderRadius: '5px',
    color: 'var(--color-ink)',
  },
  '.cm-tooltip .cm-tooltip-arrow:before': {
    borderTopColor: 'var(--color-line-strong)',
    borderBottomColor: 'var(--color-line-strong)',
  },
  '.cm-tooltip .cm-tooltip-arrow:after': {
    borderTopColor: 'var(--color-raised)',
    borderBottomColor: 'var(--color-raised)',
  },
  '.cm-tooltip-autocomplete > ul > li': { color: 'var(--color-ink)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-brand)',
    color: 'var(--color-brand-ink)',
  },
  '.cm-completionDetail': { color: 'var(--color-ink-muted)', fontStyle: 'normal' },
  '.cm-completionMatchedText': {
    color: 'var(--color-brand)',
    textDecoration: 'none',
    fontWeight: '600',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail, .cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText':
    { color: 'var(--color-brand-ink)' },

  // Diagnostics.
  '.cm-diagnostic': {
    borderLeftWidth: '3px',
    padding: '3px 8px',
    backgroundColor: 'var(--color-raised)',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--color-fail)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--color-warn)' },
  '.cm-diagnosticSource': { color: 'var(--color-ink-muted)' },
  '.cm-diagnosticAction': {
    backgroundColor: 'var(--color-sunken)',
    color: 'var(--color-ink)',
    borderRadius: '3px',
  },
  // `wavy` is not a border style; the squiggle has to come from text-decoration.
  '.cm-lintRange': {
    backgroundImage: 'none',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-error': { textDecoration: 'underline wavy var(--color-fail)' },
  '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--color-warn)' },
});

export interface CodeEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Diagnostic source; recomputed on every document change. */
  readonly lintSource: (text: string) => readonly Diagnostic[];
  readonly completion?: Extension;
  readonly ariaLabel: string;
  readonly className?: string;
}

export function CodeEditor({
  value,
  onChange,
  lintSource,
  completion,
  ariaLabel,
  className,
}: CodeEditorProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Held in refs so the editor is created once; recreating it would lose
  // cursor, undo history and scroll position on every keystroke.
  const onChangeRef = useRef(onChange);
  const lintRef = useRef(lintSource);
  onChangeRef.current = onChange;
  lintRef.current = lintSource;

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot mount effect
  useEffect(() => {
    if (host.current === null) {
      return;
    }
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          autocompletion({ activateOnTyping: true, icons: false }),
          lintGutter(),
          linter((editorView) => [...lintRef.current(editorView.state.doc.toString())], {
            delay: 350,
          }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...lintKeymap,
            indentWithTab,
          ]),
          yamlLanguage(),
          syntaxHighlighting(highlightStyle),
          indentUnit.of('  '),
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          ...(completion === undefined ? [] : [completion]),
        ],
      }),
    });
    // CodeMirror's scroll container is not focusable, which fails axe's
    // "scrollable region must have keyboard access" check. Put it in the tab
    // order and forward focus straight into the document, so tabbing in lands
    // on the text rather than on a scroll box.
    const scroller = editor.scrollDOM;
    scroller.tabIndex = 0;
    const forwardFocus = (event: FocusEvent): void => {
      if (event.target === scroller) {
        editor.focus();
      }
    };
    scroller.addEventListener('focus', forwardFocus);

    view.current = editor;
    return () => {
      scroller.removeEventListener('focus', forwardFocus);
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor !== null && value !== editor.state.doc.toString()) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className={className} />;
}
