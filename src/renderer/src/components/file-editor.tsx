import { useEffect, useLayoutEffect, useRef, type ReactElement } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { python } from '@codemirror/lang-python'

function language(path: string): Extension[] {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'json' || ext === 'jsonl') return [json()]
  if (ext === 'md' || ext === 'markdown') return [markdown()]
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return [javascript({ jsx: true })]
  if (ext === 'ts' || ext === 'tsx') return [javascript({ jsx: ext === 'tsx', typescript: true })]
  if (ext === 'html' || ext === 'htm') return [html()]
  if (ext === 'css') return [css()]
  if (ext === 'py') return [python()]
  return []
}

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'var(--bg)',
    color: 'var(--on-surface)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    lineHeight: '1.5'
  },
  '.cm-gutters': {
    backgroundColor: 'var(--surface1)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--surface3)'
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface1)' },
  '.cm-cursor': { borderLeftColor: 'var(--on-surface)' }
})

export default function FileEditor(props: {
  path: string
  text: string
  onChange: (text: string) => void
  onSave: () => void
}): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })

  useEffect(() => {
    if (!host.current) return
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.text,
        extensions: [
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                latest.current.onSave()
                return true
              }
            },
            indentWithTab
          ]),
          basicSetup,
          EditorView.lineWrapping,
          theme,
          ...language(props.path),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
          })
        ]
      })
    })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
    }
  }, [props.path])

  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === props.text) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.text } })
  }, [props.text])

  return <div ref={host} className="file-view-editor" />
}
