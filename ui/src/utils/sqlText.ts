// SQL 文本扫描小工具（纯函数）：注释/字符串掩码与“光标是否在字面量里”。
//
// 目的不是做 SQL 解析器，而是给补全/危险语句识别提供**不误判字面量**的文本
// 视图：掩码后长度不变（换行原样保留），正则匹配不会命中字符串或注释内容。

export interface SqlScanState {
  inString: boolean
  inDoubleQuote: boolean
  inBacktick: boolean
  inLineComment: boolean
  inBlockComment: boolean
}

const EMPTY_STATE: SqlScanState = {
  inString: false,
  inDoubleQuote: false,
  inBacktick: false,
  inLineComment: false,
  inBlockComment: false,
}

function isLiteralState(s: SqlScanState): boolean {
  return s.inString || s.inDoubleQuote || s.inBacktick || s.inLineComment || s.inBlockComment
}

/** 扫到文本末尾时的词法状态（用于判断光标是否落在字符串/注释里）。 */
export function scanSqlState(sql: string): SqlScanState {
  let state = EMPTY_STATE
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (state.inLineComment) {
      if (ch === '\n') state = { ...state, inLineComment: false }
    } else if (state.inBlockComment) {
      if (ch === '*' && next === '/') {
        state = { ...state, inBlockComment: false }
        i += 1
      }
    } else if (state.inString) {
      if (ch === "'") {
        if (next === "'") i += 1
        else state = { ...state, inString: false }
      }
    } else if (state.inDoubleQuote) {
      if (ch === '"') {
        if (next === '"') i += 1
        else state = { ...state, inDoubleQuote: false }
      }
    } else if (state.inBacktick) {
      if (ch === '`') {
        if (next === '`') i += 1
        else state = { ...state, inBacktick: false }
      }
    } else if (ch === '-' && next === '-') {
      state = { ...state, inLineComment: true }
      i += 1
    } else if (ch === '/' && next === '*') {
      state = { ...state, inBlockComment: true }
      i += 1
    } else if (ch === "'") {
      state = { ...state, inString: true }
    } else if (ch === '"') {
      state = { ...state, inDoubleQuote: true }
    } else if (ch === '`') {
      state = { ...state, inBacktick: true }
    }
    i += 1
  }
  return state
}

/** 光标（文本末尾）是否在字符串/注释内部。 */
export function inLiteralOrComment(sql: string): boolean {
  return isLiteralState(scanSqlState(sql))
}

/**
 * 把字符串/注释内容替换为空格（长度与换行不变）。引号本身也替换，
 * 这样掩码文本上的正则不会看到被引用的关键字。
 */
export function maskSql(sql: string): string {
  const out = sql.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
    }
  }
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const start = i
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? sql.length : nl
      blank(start, i)
    } else if (ch === '/' && next === '*') {
      const start = i
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
      blank(start, i)
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      const start = i
      i += 1
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      blank(start, i)
    } else {
      i += 1
    }
  }
  return out.join('')
}

/** 光标前文本里最后一条语句（分号只在字符串/注释外生效）。 */
export function currentStatement(textBefore: string): string {
  const masked = maskSql(textBefore)
  const i = masked.lastIndexOf(';')
  return i >= 0 ? textBefore.slice(i + 1) : textBefore
}
