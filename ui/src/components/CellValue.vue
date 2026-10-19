<script setup lang="ts">
import { computed } from 'vue'
import type { WireColumn, WireValue } from '../ipc/types'
import { tt } from '../i18n'

const props = defineProps<{
  column: WireColumn
  /** `undefined` = 该格尚未取到（流式分页）；`null` = SQL NULL。 */
  value: WireValue | undefined
}>()

const loading = computed(() => props.value === undefined)
const isNull = computed(() => props.value === null)
const isBool = computed(() => props.column.tag === 'bool')
const isDecimal = computed(() => props.column.tag === 'decimal128')
const isSpecialFloat = computed(() => {
  if (props.column.tag !== 'f32' && props.column.tag !== 'f64') return false
  return props.value === 'NaN' || props.value === 'Infinity' || props.value === '-Infinity'
})

const isMono = computed(
  () =>
    ['i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'decimal128', 'binary', 'date32', 'time64ns', 'timestampns'].includes(
      props.column.tag,
    ),
)

const text = computed(() => {
  const v = props.value
  if (v === undefined || v === null) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
})
</script>

<template>
  <span v-if="loading" class="cell-loading" :title="$t('正在从流式结果读取…')">…</span>
  <span v-else-if="isNull" class="cell-null">NULL</span>
  <span v-else-if="isBool" class="bool-badge" :class="value ? 'yes' : 'no'">{{ text }}</span>
  <span v-else-if="isSpecialFloat" class="float-badge" :title="tt`非有限浮点：${text}`">
    {{ text }}
  </span>
  <span v-else class="cell-text" :class="{ mono: isMono }" :title="text">
    {{ text }}
    <span v-if="isDecimal" class="decimal-tag" :title="$t('精确小数（字符串原样）')">decimal</span>
  </span>
</template>

<style scoped>
.cell-loading {
  color: var(--muted);
  letter-spacing: 1px;
}

.cell-null {
  font-style: italic;
  color: var(--muted);
  font-size: calc(var(--grid-font-size, 12.5px) - 1px);
  letter-spacing: 0.02em;
}

.cell-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-text.mono {
  font-family: var(--mono);
  font-size: var(--grid-mono-font-size, 12px);
}

.bool-badge {
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
}

.bool-badge.yes {
  background: var(--ok-soft);
  color: var(--ok);
}

.bool-badge.no {
  background: var(--surface-soft);
  color: var(--text-soft);
}

.float-badge {
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--warn-soft);
  border: 1px solid var(--warn-border);
  color: var(--warn);
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
}

.decimal-tag {
  margin-left: 5px;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 1px 3px;
  vertical-align: 1px;
}
</style>
