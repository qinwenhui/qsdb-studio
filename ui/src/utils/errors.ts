// 错误按 code 给建议动作（设计 §五.1.7 / §六.4）。**不解析文案**。

import type { StudioError } from '../ipc/types'
import { t } from '../i18n'

const HINTS: Record<string, string> = {
  QUERY_TIMEOUT: '查询超时：调大超时时间，或先在 SQL 里加 LIMIT 缩小结果。',
  QUERY_CANCELLED: '查询已被取消。',
  QUERY_MEMORY_LIMIT: '单查询执行内存超限：缩小中间结果，或让运维调大单查询内存上限。',
  RESULT_TOO_LARGE: '结果超过护栏：加 LIMIT，或显式豁免本请求（流式浏览同样需要 maxRows=0，不单独绕过）。',
  QUERY_PANIC: '算子 panic（内核 bug）：请携带 queryId 上报，不要重试。',
  TABLE_NOT_FOUND: '表不存在：检查库名/表名（多挂载用 db.table）。',
  COLUMN_NOT_FOUND: '列不存在：检查列名拼写。',
  PARSE_ERROR: 'SQL 语法错误：检查引号、括号与关键字。',
  TYPE_ERROR: '类型不匹配或溢出：检查值类型与显式类型参数。',
  UNSUPPORTED: '服务端当前版本不支持该能力：改写 SQL 或确认版本。',
  ALREADY_EXISTS: '对象已存在：加 IF NOT EXISTS 或改名。',
  WRITE_CONFLICT: '分区 generation 冲突：重读最新 generation 后再决定，盲目重试无用。',
  STALE_WRITER: '过期写者：不要重试；检查连接的是哪个库 / writer epoch。',
  CURSOR_TOO_OLD: '订阅游标已过期：需要全量对账后从新游标续订。',
  INVALID_ARGUMENT: '请求参数非法：检查输入（服务端拒绝不会静默兜底）。',
  NOT_FOUND: '资源不存在：检查名称。',
  UNAUTHORIZED:
    '凭证缺失或无效：检查连接档案；服务端启用用户体系时请使用用户名/密码或 Bearer Token（匿名会被 401）。',
  SESSION_REVOKED: '会话已失效：客户端已尝试自动重登；仍失败请重新登录。',
  FORBIDDEN: '权限不足（403 / 42501）：换角色或申请授权；grants 面板可确认该库的当前角色。',
  SEGMENT_REFERENCED:
    '该段仍被存活 manifest 引用（409 / 55006），删除会毁表：不要重试；删数据请走 DELETE WHERE <分区> 或 INSERT OVERWRITE。',
  TOO_MANY_QUERIES: '并发查询已满：稍后重试（可退避）。',
  TOO_MANY_SESSIONS: '登录会话数已达上限：稍后重试，或让管理员在会话面板踢出闲置会话。',
  MEMORY_PRESSURE: '全库内存预算紧张：稍后重试。',
  READ_ONLY: '目标库是只读挂载：换可写实例；本操作永不重试。',
  METADATA_ERROR: '元数据损坏：上报；可能需要 refresh-index 或人工介入。',
  IO_ERROR: '存储 I/O 失败：可退避重试；持续失败请上报。',
  INTERNAL: '服务端内部错误：请携带 queryId 上报。',
}

export function errorHint(e: StudioError | null | undefined): string {
  if (!e) return ''
  if (e.code && HINTS[e.code]) return t(HINTS[e.code])
  switch (e.kind) {
    case 'io':
      return t('网络/传输失败：检查服务是否可达（请求未被处理时可重试）。')
    case 'http':
      return t('HTTP 协议错误：检查地址与中间代理。')
    case 'decode':
      return t('响应解码失败：客户端与服务端契约可能不一致，请上报。')
    case 'secret':
      return t('系统凭据访问失败：检查 OS 凭据管理器是否可用。')
    case 'storage':
      return t('本地文件读写失败：检查数据目录权限与磁盘空间。')
    case 'usage':
      return t('操作参数有误：按提示修正后重试。')
    default:
      return t('未归类的错误：请上报。')
  }
}

export function isGuardrailError(e: StudioError | null | undefined): boolean {
  return e?.code === 'RESULT_TOO_LARGE'
}

/** 可重试的码（与 core/error.rs 的口径一致）。 */
export function retryable(e: StudioError | null | undefined): boolean {
  if (!e) return false
  if (e.retriable) return true
  return (
    e.code === 'TOO_MANY_QUERIES' ||
    e.code === 'TOO_MANY_SESSIONS' ||
    e.code === 'MEMORY_PRESSURE' ||
    e.code === 'IO_ERROR'
  )
}
