import { describe, it, expect } from 'vitest'
import { sessionColorMap, sessionRowTone, titleUnderlineTone, PANE_OPEN_COLOR } from '../pane-colors'
import type { ChatPaneRef, ChatWorkspaceTab } from '../../../../shared/types'

const pane = (id: string, sessionId: string | null = null): ChatPaneRef => ({ id, sessionId })

const tab = (panes: ChatPaneRef[]): ChatWorkspaceTab => ({
  id: 't1',
  name: 'Tab',
  panes,
  layout: {},
  createdAt: '2026-08-04T00:00:00Z'
})

describe('sessionColorMap', () => {
  it('assigns pane-slot colors to bound sessions', () => {
    const map = sessionColorMap(tab([pane('a', 's1'), pane('b', 's2'), pane('c', null)]))
    expect(map.get('s1')).toBe('blue')
    expect(map.get('s2')).toBe('green')
    expect(map.size).toBe(2)
  })
})

describe('titleUnderlineTone', () => {
  it('underlines the title in the pane slot color', () => {
    expect(titleUnderlineTone('violet')).toContain(PANE_OPEN_COLOR.violet.underline)
  })
})

describe('sessionRowTone', () => {
  it('uses the session color wash when focused', () => {
    expect(sessionRowTone('focused', 'violet')).toContain(PANE_OPEN_COLOR.violet.wash)
  })

  it('washes and bars a session open in another visible pane', () => {
    const tone = sessionRowTone('elsewhere', 'cyan')
    expect(tone).toContain(PANE_OPEN_COLOR.cyan.bar)
    expect(tone).toContain(PANE_OPEN_COLOR.cyan.wash)
  })

  it('leaves a closed session unhighlighted', () => {
    expect(sessionRowTone('closed', 'cyan')).not.toContain(PANE_OPEN_COLOR.cyan.wash)
  })
})
