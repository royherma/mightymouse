import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachEdgeSwipe, swipeCommits, type EdgeSwipeOptions } from '../edge-swipe'

describe('swipeCommits', () => {
  it('commits past a third of the width or on a quick fling, in the swipe direction only', () => {
    expect(swipeCommits(131, 1000, 390, 'right')).toBe(true)
    expect(swipeCommits(129, 1000, 390, 'right')).toBe(false)
    expect(swipeCommits(60, 100, 390, 'right')).toBe(true)
    expect(swipeCommits(40, 100, 390, 'right')).toBe(false)
    expect(swipeCommits(-200, 100, 390, 'right')).toBe(false)
    expect(swipeCommits(-200, 1000, 390, 'left')).toBe(true)
    expect(swipeCommits(200, 100, 390, 'left')).toBe(false)
  })
})

type Handler = (e: unknown) => void
const handlers = new Map<string, Handler>()
vi.stubGlobal('document', {
  addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
  removeEventListener: (type: string) => handlers.delete(type)
})

function gesture(opts: Partial<EdgeSwipeOptions> = {}) {
  const drags: number[] = []
  const ends: boolean[] = []
  const detach = attachEdgeSwipe({
    direction: 'right',
    fromEdgeOnly: true,
    width: () => 390,
    onDrag: (dx) => drags.push(dx),
    onEnd: (commit) => ends.push(commit),
    ...opts
  })
  const prevented: boolean[] = []
  const at = (x: number, y: number, timeStamp: number) => ({
    touches: [{ clientX: x, clientY: y }],
    target: null,
    timeStamp,
    preventDefault: () => prevented.push(true)
  })
  return {
    drags,
    ends,
    prevented,
    detach,
    start: (x: number, y = 300, t = 0) => handlers.get('touchstart')?.(at(x, y, t)),
    move: (x: number, y = 300, t = 0) => handlers.get('touchmove')?.(at(x, y, t)),
    end: (t: number) => handlers.get('touchend')?.({ touches: [], timeStamp: t }),
    cancel: () => handlers.get('touchcancel')?.({})
  }
}

afterEach(() => handlers.clear())

describe('attachEdgeSwipe', () => {
  it('a slow drag from the left edge past a third of the screen commits', () => {
    const g = gesture()
    g.start(10)
    g.move(100, 305, 200)
    g.move(160, 305, 900)
    g.end(1000)
    expect(g.drags).toEqual([90, 150])
    expect(g.prevented.length).toBe(2)
    expect(g.ends).toEqual([true])
  })

  it('ignores a touch that starts away from the edge', () => {
    const g = gesture()
    g.start(200)
    g.move(390, 300, 100)
    g.end(150)
    expect(g.drags).toEqual([])
    expect(g.ends).toEqual([])
  })

  it('anywhere works when the edge is not required', () => {
    const g = gesture({ fromEdgeOnly: false })
    g.start(200)
    g.move(260, 300, 50)
    g.end(60)
    expect(g.ends).toEqual([true])
  })

  it('lets a vertical scroll or a swipe the wrong way through untouched', () => {
    const scroll = gesture()
    scroll.start(10)
    scroll.move(20, 360, 50)
    scroll.move(200, 360, 60)
    scroll.end(70)
    expect(scroll.drags).toEqual([])
    expect(scroll.prevented).toEqual([])
    expect(scroll.ends).toEqual([])

    handlers.clear()
    const back = gesture({ direction: 'left', fromEdgeOnly: false })
    back.start(200)
    back.move(260, 300, 50)
    back.end(60)
    expect(back.drags).toEqual([])
    expect(back.ends).toEqual([])
  })

  it('a tiny wobble under the slop does not start a drag', () => {
    const g = gesture()
    g.start(10)
    g.move(15, 303, 50)
    g.end(60)
    expect(g.drags).toEqual([])
    expect(g.ends).toEqual([])
  })

  it('a cancelled touch snaps back, and a skipped target never starts', () => {
    const g = gesture()
    g.start(10)
    g.move(300, 300, 50)
    g.cancel()
    expect(g.ends).toEqual([false])

    handlers.clear()
    const skipped = gesture({ ignore: () => true })
    skipped.start(10)
    skipped.move(300, 300, 50)
    expect(skipped.drags).toEqual([])
  })

  it('detaching removes every listener', () => {
    gesture().detach()
    expect([...handlers.keys()]).toEqual([])
  })
})
