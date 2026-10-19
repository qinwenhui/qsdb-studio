import { intlLocale, t } from '../i18n'

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return new Intl.NumberFormat(intlLocale()).format(n)
}

/**
 * 统计行数的格式化：count 可能超过 JS 安全整数（i64 线上会转成十进制
 * 字符串），用 BigInt 分组，避免 Number 转换丢精度。
 */
export function formatBigCount(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  try {
    return new Intl.NumberFormat(intlLocale()).format(BigInt(value))
  } catch {
    return String(value)
  }
}

/** 字节量（用量）：0 就是 0 B。 */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${n} B`
}

/** 预算/上限：0 = 不限（服务端语义）。 */
export function formatLimitBytes(n: number | null | undefined): string {
  if (!n) return t('不限')
  return formatBytes(n)
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(intlLocale(), { hour12: false })
}

export function shortText(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
