import { describe, expect, it } from 'vitest'
import { parseReportOutput } from '../reports'

describe('parseReportOutput', () => {
  it('drops breakdown rows with no name instead of showing "null"', () => {
    const out = parseReportOutput(
      JSON.stringify({ value: 10, rows: [[null, 9], ['', 8], ['Spring sale', 3], [undefined, 2], ['Retarget', 5], [0, 1]] })
    )
    expect(out).toMatchObject({ rows: [['Retarget', 5], ['Spring sale', 3], ['0', 1]] })
  })

  it('leaves rows out entirely when every row is nameless', () => {
    expect(parseReportOutput('{"value": 1, "rows": [[null, 4]]}')).toMatchObject({ value: 1, rows: undefined })
  })

  it('reads the last JSON line after other script output', () => {
    expect(parseReportOutput('fetching...\n{"value": 1}\nnot json {\n{"value": 7, "previous": 5, "note": "up"}\n')).toEqual({
      value: 7,
      previous: 5,
      target: undefined,
      note: 'up',
      series: undefined,
      rows: undefined
    })
  })

  it('explains a script that printed no usable number', () => {
    expect(parseReportOutput('{"value": "12"}')).toBe('The script printed JSON without a number in "value".')
    expect(parseReportOutput('done')).toBe('The script did not print a JSON line like {"value": 12}.')
    expect(parseReportOutput('  \n')).toBe('The script printed nothing.')
  })
})
