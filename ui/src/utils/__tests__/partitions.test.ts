import { describe, expect, it } from 'vitest'
import type { WireTable } from '../../ipc/types'
import {
  decodePartitionValue,
  overwriteTemplate,
  parsePartitionName,
  partitionLiteral,
  previewSql,
} from '../partitions'

const table: WireTable = {
  name: 'sales',
  columns: [
    { name: 'id', typeName: 'BIGINT', nullable: true, partition: false },
    { name: 'amount', typeName: 'DOUBLE', nullable: true, partition: false },
    { name: 'dt', typeName: 'DATE', nullable: true, partition: true },
    { name: 'region', typeName: 'STRING', nullable: true, partition: true },
  ],
}

describe('partition dir decoding', () => {
  it('decodes the kernel escapes', () => {
    expect(decodePartitionValue('a%2Fb%3Dc%25d')).toBe('a/b=c%d')
    expect(decodePartitionValue('%0A')).toBe('\n')
    expect(decodePartitionValue('中文')).toBe('中文')
  })

  it('parses multi-key dirs', () => {
    expect(parsePartitionName('dt=2026-01-01/region=cn')).toEqual([
      { column: 'dt', value: '2026-01-01' },
      { column: 'region', value: 'cn' },
    ])
    expect(parsePartitionName('not-a-partition')).toBeNull()
  })
})

describe('partition literals', () => {
  it('uses typed literals and rejects malformed values', () => {
    expect(
      partitionLiteral({ name: 'dt', typeName: 'DATE', nullable: true, partition: true }, '2026-01-01'),
    ).toBe("DATE '2026-01-01'")
    expect(
      partitionLiteral(
        { name: 'dt', typeName: 'TIMESTAMP', nullable: true, partition: true },
        '2026-01-01 00:00:00',
      ),
    ).toBe("TIMESTAMP '2026-01-01 00:00:00'")
    expect(
      partitionLiteral({ name: 'n', typeName: 'BIGINT', nullable: true, partition: true }, '42'),
    ).toBe('42')
    expect(() =>
      partitionLiteral({ name: 'n', typeName: 'BIGINT', nullable: true, partition: true }, 'x'),
    ).toThrow()
    expect(
      partitionLiteral({ name: 's', typeName: 'STRING', nullable: true, partition: true }, "a'b"),
    ).toBe("'a''b'")
  })
})

describe('preview and overwrite SQL', () => {
  it('previews with predicates on partition columns only', () => {
    const r = previewSql(table, 'dt=2026-01-01/region=cn')
    expect(r.error).toBeUndefined()
    expect(r.sql).toBe(
      `SELECT * FROM sales WHERE dt = DATE '2026-01-01' AND region = 'cn' LIMIT 500`,
    )
  })

  it('reports unknown partition columns instead of guessing', () => {
    const r = previewSql(table, 'nope=1')
    expect(r.error).toContain('不在表的 schema')
  })

  it('builds an INSERT OVERWRITE template with generation note', () => {
    const r = overwriteTemplate(table, 'dt=2026-01-01/region=cn', 7)
    expect(r.error).toBeUndefined()
    expect(r.sql).toContain('当前 generation 7')
    expect(r.sql).toContain('INSERT OVERWRITE sales')
    expect(r.sql).toContain('id,')
    expect(r.sql).toContain("DATE '2026-01-01' AS dt")
    expect(r.sql).toContain("'cn' AS region")
    expect(r.sql).toContain(`WHERE dt = DATE '2026-01-01' AND region = 'cn';`)
  })
})
