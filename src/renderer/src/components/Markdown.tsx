// Renders assistant output as conventional-but-lean markdown.
//
// Why a component and not a raw `dangerouslySetInnerHTML`: this is an Electron
// renderer — a bad/hostile response string must never become live HTML. react-
// markdown produces React elements, no HTML injection, no XSS surface. remark-gfm
// adds the GitHub set (tables, strikethrough, task lists, autolinks) so a normal
// rewrite/answer renders the way the model intended.
//
// Only assistant text flows through here (the user's own typed messages stay raw —
// see PanelApp call-sites). Styling lives in `.md` rules in index.css, keyed off
// THEME_TOKENS vars so it matches the panel in every theme. Links open externally
// via the preload bridge; never in-window (would nav the renderer away).
import { useMemo, type ReactElement, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Brain } from 'lucide-react'
import { splitThinkBlocks } from '../think-blocks'
import { findPaths, hrefToPath, LocalPathLink, PathLabel } from './local-path'
import { WebLink } from './link-card'
import { CopyButton } from './CopyButton'

function codeText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(codeText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return codeText((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }): ReactElement {
  return (
    <div className="group relative">
      <pre>{children}</pre>
      <CopyButton
        label="Copy code"
        copy={() => navigator.clipboard.writeText(codeText(children))}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      />
    </div>
  )
}

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] }

function linkPaths(node: MdNode, cwd?: string): void {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === 'inlineCode' && child.value) {
      const [only] = findPaths(child.value, cwd)
      return only && only.start === 0 && only.end === child.value.length
        ? [{ type: 'link', url: only.path, children: [child] }]
        : [child]
    }
    if (child.type !== 'text' || !child.value) {
      linkPaths(child, cwd)
      return [child]
    }
    const text = child.value
    const out: MdNode[] = []
    let at = 0
    for (const found of findPaths(text, cwd)) {
      if (found.start > at) out.push({ type: 'text', value: text.slice(at, found.start) })
      const raw = text.slice(found.start, found.end)
      out.push({ type: 'link', url: found.path, children: [{ type: 'text', value: raw }] })
      at = found.end
    }
    if (at < text.length) out.push({ type: 'text', value: text.slice(at) })
    return out
  })
}

export function Markdown({ children, cwd }: { children: string; cwd?: string }): ReactElement {
  // Local reasoning models (Qwen via Ollama/Rapid-MLX) inline their deliberation as
  // <think>…</think>. Render it as a collapsed disclosure instead of prose — it's real
  // output worth being able to read, just never the answer. See think-blocks.ts.
  const { reasoning, answer } = splitThinkBlocks(children)
  const remarkPlugins = useMemo(
    () => [remarkGfm, () => (tree: MdNode) => linkPaths(tree, cwd)],
    [cwd]
  )
  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt }) => {
        const local = typeof src === 'string' ? hrefToPath(src, cwd) : undefined
        return (
          <img
            src={local ? window.api.mediaUrl(local) : (src as string | undefined)}
            alt={alt ?? ''}
            loading="lazy"
            className="my-1.5 block max-h-[420px] max-w-full rounded-[10px]"
          />
        )
      },
      a: ({ href, children }) => {
        const local = hrefToPath(href, cwd)
        const text = codeText(children)
        if (local) {
          const bare = /^(?:file:\/\/)?\/\S+$/.test(text)
          return (
            <LocalPathLink path={local} className={bare ? 'link-chip' : undefined}>
              {bare ? <PathLabel path={local} raw={text} /> : children}
            </LocalPathLink>
          )
        }
        if (href && /^https?:\/\//i.test(href)) {
          return (
            <WebLink href={href} short={/^https?:\/\/\S+$/i.test(text)}>
              {children}
            </WebLink>
          )
        }
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault()
              if (href) window.api.openExternal(href)
            }}
          >
            {children}
          </a>
        )
      },
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
    }),
    [cwd]
  )
  return (
    <div className="md">
      {reasoning !== '' && (
        <details className="think">
          <summary>
            <Brain size={13} strokeWidth={1.75} />
            Thought for a moment
          </summary>
          <div className="think-body">{reasoning}</div>
        </details>
      )}
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {answer}
      </ReactMarkdown>
    </div>
  )
}
