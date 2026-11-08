import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONFIG } from '@shared/config'

// Read as text because `tsc` sees neither the .swift constant nor App.tsx's
// local literal -- which is how Swift sat at 500 while both TS copies said 300.
const repoRoot = resolve(__dirname, '../../../..')
const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8')

describe('MIN_RECORDING_MS agrees across all three enforcement points', () => {
  it('App.tsx mirrors CONFIG', () => {
    const src = read('src/main/phone-remote/react/hooks/use-dictation.ts')
    const match = src.match(/^const MIN_RECORDING_MS = (\d+)$/m)
    expect(match, 'App.tsx must declare `const MIN_RECORDING_MS = <number>`').toBeTruthy()
    expect(Number(match![1])).toBe(CONFIG.PHONE_REMOTE.MIN_RECORDING_MS)
  })

  it('RecordingModel.swift mirrors CONFIG', () => {
    const src = read('ios/MightyMouse/RecordingModel.swift')
    const match = src.match(/static let minRecordingMs = (\d+)/)
    expect(match, 'RecordingModel.swift must declare `static let minRecordingMs = <number>`').toBeTruthy()
    expect(Number(match![1])).toBe(CONFIG.PHONE_REMOTE.MIN_RECORDING_MS)
  })
})
