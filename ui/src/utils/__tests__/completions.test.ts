import { describe, expect, it } from 'vitest'
import type { WireTable } from '../../ipc/types'
import { buildCompletions, qualifierBefore } from '../completions'

const tables: WireTable[] = [
  {
    name: 'sales',
    columns: [
      { name: 'id', typeName: 'BIGINT', nullable: true, partition: false },
      { name: 'amount', typeName: 'DOUBLE', nullable: true, partition: false },
      { name: 'dt', typeName: 'DATE', nullable: true, partition: true },
    ],
  },
  {
    name: 'default.types',
    columns: [
      { name: 'id', typeName: 'BIGINT', nullable: true, partition: false },
      { name: 'dec', typeName: 'DECIMAL(10,2)', nullable: true, partition: false },
    ],
  },
]

describe('qualifierBefore', () => {
  it('detects table. and db.table. contexts', () => {
    expect(qualifierBefore('SELECT * FROM sales.')).toBe('sales')
    expect(qualifierBefore('SELECT default.types.')).toBe('default.types')
    expect(qualifierBefore('SELECT * FROM sales WHERE ')).toBeNull()
  })
})

describe('buildCompletions', () => {
  it('offers table names by prefix', () => {
    const out = buildCompletions(tables, 'sal', 'SELECT * FROM sal')
    expect(out.some((e) => e.kind === 'table' && e.label === 'sales')).toBe(true)
  })

  it('qualified context returns only that table columns', () => {
    const out = buildCompletions(tables, '', 'SELECT sales.')
    expect(out.map((e) => e.label).sort()).toEqual(['amount', 'dt', 'id'])
    expect(out.every((e) => e.kind === 'column' || e.kind === 'partition')).toBe(true)
    expect(out.find((e) => e.label === 'dt')?.kind).toBe('partition')
  })

  it('qualified short name resolves db.table', () => {
    const out = buildCompletions(tables, 'd', 'SELECT types.')
    expect(out.map((e) => e.label)).toEqual(['dec'])
  })

  it('dedupes column names across tables', () => {
    const out = buildCompletions(tables, 'id', 'SELECT id')
    expect(out.filter((e) => e.label === 'id').length).toBe(1)
  })

  it('includes keywords when prefix matches', () => {
    const out = buildCompletions(tables, 'sel', 'sel')
    expect(out.some((e) => e.kind === 'keyword' && e.label === 'SELECT')).toBe(true)
  })

  it('offers QSDB statement snippets by prefix', () => {
    const out = buildCompletions(tables, 'sel', 'sel')
    const snippet = out.find((e) => e.kind === 'snippet' && e.label === 'sel')
    expect(snippet?.snippet).toBe(true)
    expect(snippet?.insertText).toContain('${1:columns}')
    expect(
      buildCompletions(tables, 'insov', 'insov').some(
        (e) => e.kind === 'snippet' && e.label === 'insov',
      ),
    ).toBe(true)
    // 空前缀不弹片段，避免补全列表被模板淹没。
    expect(buildCompletions(tables, '', '').some((e) => e.kind === 'snippet')).toBe(false)
  })

  it('empty prefix yields tables before columns before keywords', () => {
    const out = buildCompletions(tables, '', '')
    const firstTable = out.findIndex((e) => e.kind === 'table')
    const firstColumn = out.findIndex((e) => e.kind === 'column' || e.kind === 'partition')
    const firstKeyword = out.findIndex((e) => e.kind === 'keyword')
    expect(firstTable).toBeGreaterThanOrEqual(0)
    expect(firstColumn).toBeGreaterThan(firstTable)
    expect(firstKeyword).toBeGreaterThan(firstColumn)
  })

  it('resolves aliases declared in FROM', () => {
    const out = buildCompletions(tables, '', 'SELECT * FROM sales s WHERE s.')
    expect(out.map((e) => e.label).sort()).toEqual(['amount', 'dt', 'id'])
    expect(out.every((e) => e.kind === 'column' || e.kind === 'partition')).toBe(true)
  })

  it('offers scoped columns for all FROM/JOIN tables plus aliases', () => {
    const out = buildCompletions(
      tables,
      '',
      'SELECT * FROM sales s JOIN default.types t ON s.id = t.id WHERE ',
    )
    expect(out.some((e) => e.kind === 'alias' && e.label === 's')).toBe(true)
    expect(out.some((e) => e.kind === 'alias' && e.label === 't')).toBe(true)
    expect(out.some((e) => e.label === 'amount')).toBe(true)
    const id = out.find((e) => e.label === 'id' && e.kind === 'column')
    expect(id?.detail).toContain('s')
    expect(id?.detail).toContain('t')
    expect(id?.detail).toContain('需限定名')
  })

  it('after FROM / JOIN only offers tables', () => {
    for (const before of ['SELECT * FROM ', 'SELECT * FROM sales s JOIN ']) {
      const out = buildCompletions(tables, '', before)
      expect(out.length).toBeGreaterThan(0)
      expect(out.every((e) => e.kind === 'table')).toBe(true)
    }
  })

  it('INSERT column lists only offer the target table columns', () => {
    const out = buildCompletions(tables, 'am', 'INSERT INTO sales (am')
    expect(out.map((e) => e.label)).toEqual(['amount'])
  })

  it('INSERT OVERWRITE PARTITION lists only offer partition columns', () => {
    const out = buildCompletions(tables, '', 'INSERT OVERWRITE sales PARTITION (')
    expect(out.map((e) => e.label)).toEqual(['dt'])
  })

  it('does not suggest inside strings or comments', () => {
    expect(buildCompletions(tables, 'sel', "SELECT 'sel")).toEqual([])
    expect(buildCompletions(tables, 'sel', 'SELECT 1 -- sel')).toEqual([])
    expect(buildCompletions(tables, 'sel', '/* sel')).toEqual([])
  })

  it('keyword insert text follows the input case', () => {
    const lower = buildCompletions(tables, 'sel', 'sel').find(
      (e) => e.kind === 'keyword' && e.label === 'SELECT',
    )
    expect(lower?.insertText).toBe('select')
    const upper = buildCompletions(tables, 'Sel', 'Sel').find(
      (e) => e.kind === 'keyword' && e.label === 'SELECT',
    )
    expect(upper?.insertText).toBe('SELECT')
  })
})
