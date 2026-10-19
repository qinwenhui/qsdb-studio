// 参数化查询的占位符扫描与草稿转换。
// 值**只在内存**里停留（不落 localStorage）：参数可能是敏感数据。

import type { ParamInput } from '../ipc/types'

export interface PlaceholderInfo {
  /** `$n` 的最大编号（0 = 没有）。 */
  dollarCount: number
  /** `?` 的出现次数。 */
  questionCount: number
  /** 需要填写的参数个数。 */
  count: number
  /** 同一句混用 `$n` 与 `?`（服务端会拒绝，UI 提前提示）。 */
  mixed: boolean
}

/** 把字符串字面量与注释替换成空白，避免把值里的 `?`/`$1` 当占位符。 */
export function stripSqlLiterals(sql: string): string {
  let out = ''
  let i = 0
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'line' | 'block' = 'normal'
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    switch (state) {
      case 'normal':
        if (c === "'") {
          state = 'single'
          out += ' '
        } else if (c === '"') {
          state = 'double'
          out += ' '
        } else if (c === '`') {
          state = 'backtick'
          out += ' '
        } else if (c === '-' && next === '-') {
          state = 'line'
          out += '  '
          i++
        } else if (c === '/' && next === '*') {
          state = 'block'
          out += '  '
          i++
        } else {
          out += c
        }
        break
      case 'single':
        if (c === "'") {
          if (next === "'") {
            out += '  '
            i++
          } else {
            state = 'normal'
            out += ' '
          }
        } else {
          out += c === '\n' ? '\n' : ' '
        }
        break
      case 'double':
        if (c === '"') {
          if (next === '"') {
            out += '  '
            i++
          } else {
            state = 'normal'
            out += ' '
          }
        } else {
          out += c === '\n' ? '\n' : ' '
        }
        break
      case 'backtick':
        if (c === '`') {
          state = 'normal'
          out += ' '
        } else {
          out += c === '\n' ? '\n' : ' '
        }
        break
      case 'line':
        if (c === '\n') {
          state = 'normal'
          out += '\n'
        } else {
          out += ' '
        }
        break
      case 'block':
        if (c === '*' && next === '/') {
          state = 'normal'
          out += '  '
          i++
        } else {
          out += c === '\n' ? '\n' : ' '
        }
        break
    }
    i++
  }
  return out
}

/** 扫描占位符。 */
export function scanPlaceholders(sql: string): PlaceholderInfo {
  const clean = stripSqlLiterals(sql)
  let dollarCount = 0
  for (const m of clean.matchAll(/\$(\d+)/g)) {
    dollarCount = Math.max(dollarCount, Number(m[1]))
  }
  const questionCount = (clean.match(/\?/g) ?? []).length
  return {
    dollarCount,
    questionCount,
    count: Math.max(dollarCount, questionCount),
    mixed: dollarCount > 0 && questionCount > 0,
  }
}

export interface ParamDraft {
  ty: string
  value: string
}

/** 草稿 → IPC 参数。值按 JSON 解析，解析不了就当字符串（不静默改类型）。 */
export function draftToParam(d: ParamDraft): ParamInput {
  let value: unknown
  const raw = d.value
  try {
    value = JSON.parse(raw)
  } catch {
    value = raw
  }
  const ty = d.ty.trim()
  return ty ? { value, ty } : { value }
}

export function paramsFromDrafts(drafts: ParamDraft[]): ParamInput[] {
  return drafts.map(draftToParam)
}

/** 给 SQL 做稳定键（参数草稿的内存缓存）。 */
export function sqlKey(sql: string): string {
  let h = 5381
  for (let i = 0; i < sql.length; i++) h = ((h << 5) + h + sql.charCodeAt(i)) | 0
  return `q${h}`
}
