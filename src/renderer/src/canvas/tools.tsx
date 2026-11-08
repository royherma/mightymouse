import type { ReactElement } from 'react'
import { Eraser, Hand, MousePointer2, Pencil, Plus } from 'lucide-react'
import { Button } from '../components/Button'
import type { CanvasInk } from '@shared/canvas'

export type Tool = 'select' | 'hand' | 'pen' | 'eraser'
const INKS: CanvasInk[] = ['ink', 'accent', 'green', 'red']

const TOOLS: { id: Tool; label: string; Icon: typeof Hand }[] = [
  { id: 'select', label: 'Select - drag to pick several', Icon: MousePointer2 },
  { id: 'hand', label: 'Move around - or hold Space', Icon: Hand },
  { id: 'pen', label: 'Draw', Icon: Pencil },
  { id: 'eraser', label: 'Erase drawings', Icon: Eraser }
]

export function Toolbar({
  tool,
  ink,
  addOpen,
  onTool,
  onInk,
  onAdd
}: {
  tool: Tool
  ink: CanvasInk
  addOpen: boolean
  onTool: (t: Tool) => void
  onInk: (i: CanvasInk) => void
  onAdd: () => void
}): ReactElement {
  return (
    <div className="cv-tools" onPointerDown={(e) => e.stopPropagation()}>
      <Button
        variant="bare"
        className={`cv-tool cv-tool-add ${addOpen ? 'cv-tool-on' : ''}`}
        aria-label="Add something"
        aria-pressed={addOpen}
        title="Add a note, chat, file or project"
        onClick={onAdd}
      >
        <Plus size={18} strokeWidth={2.2} />
      </Button>
      <span className="cv-tools-sep" />
      {TOOLS.map(({ id, label, Icon }) => (
        <Button
          key={id}
          variant="bare"
          className={`cv-tool ${tool === id ? 'cv-tool-on' : ''}`}
          aria-label={label}
          aria-pressed={tool === id}
          title={label}
          onClick={() => onTool(id)}
        >
          <Icon size={17} strokeWidth={1.9} />
        </Button>
      ))}
      {tool === 'pen' ? (
        <div className="cv-inks">
          {INKS.map((i) => (
            <Button
              key={i}
              variant="bare"
              aria-label={`${i} ink`}
              aria-pressed={ink === i}
              className={`cv-ink cv-ink-${i} ${ink === i ? 'cv-ink-on' : ''}`}
              onClick={() => onInk(i)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
