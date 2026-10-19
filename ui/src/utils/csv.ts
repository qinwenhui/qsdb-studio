// 网格 → CSV（RFC 4180）。NULL = 空串；不做任何数值/日期改写。

import type { WireColumn, WireValue } from '../ipc/types'

function escape(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function cell(v: WireValue): string {
  if (v === null) return ''
  return typeof v === 'string' ? v : String(v)
}

export function toCsv(columns: WireColumn[], rows: WireValue[][]): string {
  const lines: string[] = []
  lines.push(columns.map((c) => escape(c.name)).join(','))
  for (const row of rows) {
    lines.push(row.map((v) => escape(cell(v))).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
