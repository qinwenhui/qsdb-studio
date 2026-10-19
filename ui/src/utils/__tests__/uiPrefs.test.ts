import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UI_PREFS,
  editorLineMin,
  gridRowMin,
  normalizeUiPrefs,
  parseUiPrefs,
} from '../uiPrefs'

describe('normalizeUiPrefs', () => {
  it('falls back per-field for missing or invalid values', () => {
    expect(normalizeUiPrefs(null)).toEqual(DEFAULT_UI_PREFS)
    expect(
      normalizeUiPrefs({
        editorFontSize: 'big',
        editorLineHeight: Number.NaN,
        gridFontSize: -5,
        gridRowHeight: Infinity,
      }),
    ).toEqual({
      editorFontSize: DEFAULT_UI_PREFS.editorFontSize,
      editorLineHeight: DEFAULT_UI_PREFS.editorLineHeight,
      gridFontSize: 9,
      gridRowHeight: DEFAULT_UI_PREFS.gridRowHeight,
    })
  })

  it('clamps line height so text never overlaps', () => {
    const p = normalizeUiPrefs({
      editorFontSize: 20,
      editorLineHeight: 10,
      gridFontSize: 18,
      gridRowHeight: 12,
    })
    expect(p.editorLineHeight).toBe(editorLineMin(20))
    expect(p.gridRowHeight).toBe(gridRowMin(18))
    expect(p.editorLineHeight).toBeGreaterThanOrEqual(20 + 4)
    expect(p.gridRowHeight).toBeGreaterThanOrEqual(18 + 10)
  })

  it('rounds font sizes to half-pixel steps and bounds them', () => {
    expect(
      normalizeUiPrefs({ editorFontSize: 13.26, gridFontSize: 99 }),
    ).toMatchObject({ editorFontSize: 13.5, gridFontSize: 20 })
    expect(
      normalizeUiPrefs({ editorFontSize: 99, gridFontSize: 1 }),
    ).toMatchObject({ editorFontSize: 22, gridFontSize: 9 })
  })
})

describe('parseUiPrefs', () => {
  it('returns defaults for corrupt storage', () => {
    expect(parseUiPrefs(null)).toEqual(DEFAULT_UI_PREFS)
    expect(parseUiPrefs('{oops')).toEqual(DEFAULT_UI_PREFS)
  })

  it('restores a valid payload', () => {
    expect(
      parseUiPrefs(
        JSON.stringify({
          editorFontSize: 15,
          editorLineHeight: 24,
          gridFontSize: 14,
          gridRowHeight: 34,
        }),
      ),
    ).toEqual({
      editorFontSize: 15,
      editorLineHeight: 24,
      gridFontSize: 14,
      gridRowHeight: 34,
    })
  })
})
