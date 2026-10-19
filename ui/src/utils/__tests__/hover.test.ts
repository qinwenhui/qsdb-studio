import { describe, expect, it } from 'vitest'
import type { WireTable } from '../../ipc/types'
import { hoverMarkdown } from '../hover'

const tables: WireTable[] = [
  {
    name: 'sales',
    columns: [
      { name: 'id', typeName: 'BIGINT', nullable: false, partition: false },
      { name: 'dt', typeName: 'DATE', nullable: true, partition: true },
    ],
  },
  {
    name: 'default.orders',
    columns: [{ name: 'id', typeName: 'BIGINT', nullable: true, partition: false }],
  },
]

describe('hoverMarkdown', () => {
  it('shows table schema by table name or short name', () => {
    expect(hoverMarkdown(tables, 'sales')).toContain('表 sales')
    expect(hoverMarkdown(tables, 'orders')).toContain('表 default.orders')
    expect(hoverMarkdown(tables, 'sales')).toContain('`dt` DATE · 分区列')
  })

  it('lists all tables for an ambiguous column instead of guessing', () => {
    const md = hoverMarkdown(tables, 'id')
    expect(md).toContain('来自表 `sales`')
    expect(md).toContain('来自表 `default.orders`')
    expect(md).toContain('NOT NULL')
  })

  it('returns null when nothing matches', () => {
    expect(hoverMarkdown(tables, 'nope')).toBeNull()
    expect(hoverMarkdown(tables, '')).toBeNull()
  })
})
