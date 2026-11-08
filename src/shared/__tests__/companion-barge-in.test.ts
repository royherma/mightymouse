import { describe, it, expect } from 'vitest'
import { decideBargeIn, isStopUtterance, matchWakePhrase, splitCommands } from '../companion-barge-in'
import type { CompanionState } from '../companion-state'

describe('decideBargeIn', () => {
  it('cuts the audio AND the read timer when the mouse is talking', () => {
    // `talking` covers both a real TTS clip and the no-audio caption hold, so
    // an interrupt has to kill both or one of them settles to idle underneath
    // the user's new turn.
    expect(decideBargeIn('talking')).toEqual({
      stopAudio: true,
      clearSettleTimer: true,
      supersedeTurn: true,
      abortRun: false,
      interrupted: true
    })
  })

  it('supersedes the in-flight turn when interrupted mid-think', () => {
    // The regression that motivated extracting this: there is no audio to stop
    // yet, but the reply is still coming. Without supersedeTurn the mouse
    // answers a question the user already talked over.
    const decision = decideBargeIn('thinking')
    expect(decision.supersedeTurn).toBe(true)
    expect(decision.interrupted).toBe(true)
    expect(decision.stopAudio).toBe(false)
  })

  it('treats speech from idle as a normal turn, not an interruption', () => {
    expect(decideBargeIn('idle')).toEqual({
      stopAudio: false,
      clearSettleTimer: false,
      supersedeTurn: false,
      abortRun: false,
      interrupted: false
    })
  })

  it('does not re-interrupt while already listening', () => {
    // VAD can report speaking across several frames; only the transition out of
    // talking/thinking is an interruption, so this must stay a no-op or every
    // frame would emit a barge-in event.
    expect(decideBargeIn('listening').interrupted).toBe(false)
  })

  it('never stops audio without also clearing the settle timer', () => {
    // Invariant: stopReply() runs the settle path, so leaving a timer armed
    // would double-settle and race the new turn.
    const states: CompanionState[] = ['idle', 'listening', 'thinking', 'talking']
    for (const state of states) {
      const d = decideBargeIn(state)
      if (d.stopAudio) expect(d.clearSettleTimer).toBe(true)
    }
  })

  it('kills the run itself when interrupted mid-think, but not mid-talk', () => {
    // The distinction the whole flag exists for. Mid-think a run is live and
    // may be clicking through an app; mid-talk it has already finished and
    // produced the clip, so aborting would kill whatever run started next.
    expect(decideBargeIn('thinking').abortRun).toBe(true)
    expect(decideBargeIn('talking').abortRun).toBe(false)
  })

  it('never aborts a run without also superseding its reply', () => {
    // Killing the process makes the run fail, and a failed run still pushes a
    // result back. Without the supersede the mouse announces the failure of
    // the thing the user just cancelled.
    const states: CompanionState[] = ['idle', 'listening', 'thinking', 'talking']
    for (const state of states) {
      const d = decideBargeIn(state)
      if (d.abortRun) expect(d.supersedeTurn).toBe(true)
    }
  })

  it('only ever supersedes a turn when it reports an interruption', () => {
    const states: CompanionState[] = ['idle', 'listening', 'thinking', 'talking']
    for (const state of states) {
      const d = decideBargeIn(state)
      if (d.supersedeTurn) expect(d.interrupted).toBe(true)
    }
  })
})

describe('isStopUtterance', () => {
  it('treats a bare stop word as a command, whatever the casing or punctuation', () => {
    // Whisper punctuates and capitalizes, so the raw transcript of someone
    // shouting one word is "Stop!" — matching only the bare lowercase token
    // would let every real interruption through as a fresh instruction.
    for (const said of ['stop', 'Stop!', 'WAIT.', '  no  ', 'Never mind…', 'Cancel']) {
      expect(isStopUtterance(said)).toBe(true)
    }
  })

  it('lets a correction through as a real instruction', () => {
    // The case that must NOT be swallowed: the user is redirecting, not
    // panicking, and the words after "no" are the whole point.
    for (const said of ['no, the other tab', 'stop and open Mail instead', 'wait for the page to load']) {
      expect(isStopUtterance(said)).toBe(false)
    }
  })

  it('does not fire on silence', () => {
    // An empty transcript already means "the VAD misjudged noise as speech".
    // Reading that as a stop would kill a healthy run for no reason.
    expect(isStopUtterance('')).toBe(false)
    expect(isStopUtterance('   ')).toBe(false)
  })
})

describe('matchWakePhrase', () => {
  it.each([
    ['Hey mighty, open safari.', 'open safari.'],
    ['Hey Mighty Mouse, close this tab.', 'close this tab.'],
    ['Mighty, what time is it?', 'what time is it?'],
    ['Hey Marty, open slack.', 'open slack.'],
    ['Oh hey mighty, lock the screen', 'lock the screen'],
    ['Hey Mighty.', ''],
    ['Mighty', ''],
    ['A mighty open chat GPT.', 'open chat GPT.'],
    ['MIT open chat GPT.', 'open chat GPT.'],
    ['Mighty open safari', 'open safari'],
    ['Hey M, open safari.', 'open safari.'],
    ['M. Open Notes.', 'Open Notes.'],
    ['Okay M, play music.', 'play music.'],
    ["Hey I'm open chat GPT.", 'open chat GPT.'],
    ['Hey am open chat GPT', 'open chat GPT'],
    ['Hey Em, open mail', 'open mail']
  ])('hears %s', (text, request) => {
    expect(matchWakePhrase(text)).toEqual({ addressed: true, request })
  })

  it.each([
    'So I was telling him about the meeting.',
    'I was mighty tired today',
    'Mighty tired today honestly',
    'Marty, can you pass the salt',
    'That is a mighty fine plan, hey mighty',
    'We went to MIT open house',
    "Hey, I'm going home",
    'I am open to it',
    'Plan M is the backup'
  ])('ignores %s', (text) => {
    expect(matchWakePhrase(text).addressed).toBe(false)
  })
})

describe('splitCommands', () => {
  it.each([
    ['open Safari and go to deliver KP', ['open Safari', 'go to deliver KP']],
    ['open Spotify, then play my liked songs', ['open Spotify', 'play my liked songs']],
    ['open Notes and then type hello', ['open Notes', 'type hello']],
    ['search for salt and pepper', ['search for salt and pepper']],
    ['open Safari', ['open Safari']]
  ])('%s', (said, parts) => {
    expect(splitCommands(said)).toEqual(parts)
  })
})
