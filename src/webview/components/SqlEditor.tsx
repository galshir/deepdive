import { MySQL, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface SqlEditorHandle {
  /** Selected text, or the whole document when nothing is selected. */
  getRunnableText(): string;
  /** Replaces the selection (or inserts at the cursor) with `text`, as one undoable change. */
  insertText(text: string): void;
  focus(): void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  /** Ctrl/Cmd+Shift+S. */
  onSave?: () => void;
  schema?: Record<string, string[]>;
  defaultTable?: string;
  readOnly?: boolean;
  placeholder?: string;
  minHeight?: number;
  ariaLabel?: string;
}

const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--vscode-editor-font-size, 13px)', backgroundColor: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)' },
  '.cm-content': { fontFamily: 'var(--vscode-editor-font-family, monospace)', caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-activeForeground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--vscode-editorSuggestWidget-background)', color: 'var(--vscode-editorSuggestWidget-foreground)', border: '1px solid var(--vscode-editorSuggestWidget-border)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground)', color: 'var(--vscode-editorSuggestWidget-selectedForeground, inherit)' },
  '.cm-scroller': { overflow: 'auto' },
});

/** Token colours from the active VS Code theme (debug token colours are present in every theme). */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--vscode-debugTokenExpression-name, #569cd6)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--vscode-debugTokenExpression-string, #ce9178)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--vscode-debugTokenExpression-number, #b5cea8)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--vscode-descriptionForeground, #6a9955)', fontStyle: 'italic' },
  { tag: [t.special(t.name), t.propertyName], color: 'var(--vscode-debugTokenExpression-value, #9cdcfe)' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--vscode-symbolIcon-functionForeground, #dcdcaa)' },
  { tag: t.operator, color: 'var(--vscode-editor-foreground)' },
]);

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langConf = useRef(new Compartment());
  const roConf = useRef(new Compartment());
  const latest = useRef(props);
  latest.current = props;

  useImperativeHandle(ref, () => ({
    getRunnableText() {
      const v = view.current;
      if (!v) return latest.current.value;
      const sel = v.state.selection.main;
      return sel.empty ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to);
    },
    insertText(text: string) {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    focus() {
      view.current?.focus();
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    const runKeys = Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            latest.current.onRun?.();
            return true;
          },
        },
        {
          key: 'Mod-Shift-s',
          run: () => {
            if (!latest.current.onSave) return false;
            latest.current.onSave();
            return true;
          },
        },
      ]),
    );
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          runKeys,
          basicSetup,
          Prec.high(syntaxHighlighting(highlight)),
          EditorView.cspNonce.of(nonce),
          langConf.current.of(sql({ dialect: MySQL, upperCaseKeywords: true })),
          roConf.current.of(EditorState.readOnly.of(Boolean(props.readOnly))),
          placeholderExt(props.placeholder ?? 'SELECT …'),
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel ?? 'SQL editor' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. "open in SQL editor").
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: langConf.current.reconfigure(sql({ dialect: MySQL, upperCaseKeywords: true, schema: props.schema, defaultTable: props.defaultTable })),
    });
  }, [props.schema, props.defaultTable]);

  useEffect(() => {
    view.current?.dispatch({ effects: roConf.current.reconfigure(EditorState.readOnly.of(Boolean(props.readOnly))) });
  }, [props.readOnly]);

  return <div className="sql-editor" ref={host} style={{ minHeight: props.minHeight ?? 120 }} />;
});
