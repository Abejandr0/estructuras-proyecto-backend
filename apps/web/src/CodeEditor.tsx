import {useEffect, useRef} from 'react';
import {basicSetup} from 'codemirror';
import {javascript} from '@codemirror/lang-javascript';
import {json} from '@codemirror/lang-json';
import {python} from '@codemirror/lang-python';
import {css} from '@codemirror/lang-css';
import {html} from '@codemirror/lang-html';
import {markdown} from '@codemirror/lang-markdown';
import {EditorView, keymap} from '@codemirror/view';
import type {Extension} from '@codemirror/state';
import {oneDark} from '@codemirror/theme-one-dark';

function codeLanguage(filePath: string): Extension | undefined {
  const extension = filePath.split('.').pop()?.toLowerCase();
  if (['js','jsx','mjs','cjs','ts','tsx','mts','cts'].includes(extension ?? '')) return javascript({typescript: /^(?:ts|tsx|mts|cts)$/.test(extension ?? ''), jsx: /^(?:jsx|tsx)$/.test(extension ?? '')});
  if (['json','jsonc'].includes(extension ?? '')) return json();
  if (extension === 'py') return python();
  if (['css','scss','less'].includes(extension ?? '')) return css();
  if (['html','htm','svg','xml'].includes(extension ?? '')) return html();
  if (['md','markdown','mdx'].includes(extension ?? '')) return markdown();
  return undefined;
}

export default function CodeEditor({filename, value, onChange, onSave, dark, ariaLabel}: {
  filename: string; value: string; onChange: (value: string) => void; onSave: () => void; dark: boolean; ariaLabel: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView|null>(null);
  const callbacks = useRef({onChange, onSave});
  useEffect(() => { callbacks.current = {onChange, onSave}; }, [onChange, onSave]);
  useEffect(() => {
    if (!host.current) return;
    const language = codeLanguage(filename);
    const editor = new EditorView({
      doc: value,
      parent: host.current,
      extensions: [
        keymap.of([{key: 'Mod-s', run: () => { callbacks.current.onSave(); return true; }}]),
        basicSetup,
        EditorView.contentAttributes.of({'aria-label': ariaLabel, spellcheck: 'false'}),
        EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.onChange(update.state.doc.toString()); }),
        ...(language ? [language] : []),
        ...(dark ? [oneDark] : []),
      ],
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, [filename, dark, ariaLabel]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({changes: {from: 0, to: editor.state.doc.length, insert: value}});
  }, [value]);
  return <div className="code-editor-shell" ref={host} data-file={filename}/>;
}
