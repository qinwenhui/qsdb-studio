import { describe, expect, it } from 'vitest'
import {
  buildGrantRow,
  grantLabel,
  isRowDirty,
  parseGrantsSummary,
  rowDiff,
  rowToGrants,
} from '../grants'

describe('parseGrantsSummary', () => {
  it('parses roles and explicit null', () => {
    expect(parseGrantsSummary('settle=reader,*=-')).toEqual({
      map: { settle: 'reader', '*': null },
    })
    expect(parseGrantsSummary('')).toEqual({ map: null })
    expect(parseGrantsSummary('bad').error).toContain('不合法')
  })
})

describe('grant matrix row', () => {
  it('applies wildcard and per-db overrides', () => {
    const { row } = buildGrantRow('alice', '', 'settle=reader,*=writer', [
      'settle',
      'sales',
    ])
    expect(row!.cells).toEqual({
      settle: 'reader',
      sales: 'writer',
      '*': 'writer',
    })
  })

  it('legacy global role fills the row', () => {
    const { row } = buildGrantRow('bob', 'admin', '', ['settle'])
    expect(row!.cells).toEqual({ settle: 'admin', '*': 'admin' })
  })

  it('preserves grants for unmounted databases on save', () => {
    const { row } = buildGrantRow('carol', '', 'old_db=reader,*=-', ['sales'])
    expect(row!.cells).toEqual({ sales: 'none', '*': 'none' })
    const map = rowToGrants(row!)
    expect(map).toEqual({ old_db: 'reader', sales: null, '*': null })
  })

  it('dirty tracking and all-deny shape', () => {
    const { row } = buildGrantRow('dave', '', 'sales=reader', ['sales'])
    expect(isRowDirty(row!)).toBe(false)
    row!.cells.sales = 'none'
    expect(isRowDirty(row!)).toBe(true)
    expect(rowToGrants(row!)).toEqual({ sales: null, '*': null })
  })

  it('diffs only changed cells', () => {
    const { row } = buildGrantRow('erin', '', 'sales=reader,*=writer', ['sales', 'ops'])
    row!.cells.sales = 'admin'
    row!.cells['*'] = 'none'
    expect(rowDiff(row!)).toEqual([
      { col: '*', from: 'writer', to: 'none' },
      { col: 'sales', from: 'reader', to: 'admin' },
    ])
    expect(grantLabel('none')).toBe('无权')
    expect(grantLabel('writer')).toBe('writer')
  })
})
