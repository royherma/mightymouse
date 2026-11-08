import './index.css'
import { createRoot } from 'react-dom/client'
import { Button } from './components/Button'
import { MediaBrowser, useMediaViewer } from './components/media-viewer'
import { injectTheme } from './theme'

const view = new URLSearchParams(location.search).get('view') ?? 'panel'
const COLORS = ['#3a6ea5', '#a55a3a', '#3aa56e', '#8a3aa5']

function fakeShot(i: number): string {
  const c = document.createElement('canvas')
  c.width = 1280
  c.height = 800
  const g = c.getContext('2d') as CanvasRenderingContext2D
  g.fillStyle = COLORS[i % COLORS.length]
  g.fillRect(0, 0, 1280, 800)
  g.fillStyle = '#fff'
  g.fillRect(80, 80, 1120, 90)
  g.font = 'bold 64px system-ui'
  g.fillText(`Screenshot ${i + 1}`, 120, 400)
  return c.toDataURL('image/png')
}

const list = COLORS.map((_, i) => `/Users/roy/shots/shot-${i + 1}.png`)
const drawings = ['/Users/roy/MightyMouse/markups/shot-2-markup-1.png']
const urls = new Map([...list, ...drawings].map((p, i) => [p, fakeShot(i)]))

Object.assign(window, {
  api: {
    mediaUrl: (p: string) => urls.get(p) ?? '',
    markupList: async () => drawings,
    markupSave: async (png: string) => {
      Object.assign(window, { lastPng: png })
      return drawings[0]
    },
    openMedia: async () => {},
    openPath: async () => {}
  }
})

function Modal(): React.ReactElement {
  const { open, viewer } = useMediaViewer(list)
  return (
    <div>
      <Button variant="ghost" onClick={() => open(list[1])}>
        open
      </Button>
      {viewer}
    </div>
  )
}

injectTheme()
createRoot(document.getElementById('root') as HTMLElement).render(
  view === 'modal' ? (
    <Modal />
  ) : (
    <div style={{ display: 'flex', width: '100%' }}>
      <MediaBrowser list={list} start={list[1]} onPath={() => {}} />
    </div>
  )
)
