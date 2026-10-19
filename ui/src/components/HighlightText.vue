<script setup lang="ts">
// 安全的子串高亮：按文本切片渲染 <mark>，不使用 v-html（SQL 是用户输入）。

import { computed } from 'vue'

const props = defineProps<{
  text: string
  query: string
}>()

interface Part {
  text: string
  hit: boolean
}

const parts = computed<Part[]>(() => {
  const needle = props.query.trim()
  if (!needle) return [{ text: props.text, hit: false }]
  const hay = props.text.toLowerCase()
  const find = needle.toLowerCase()
  const out: Part[] = []
  let from = 0
  while (from < props.text.length) {
    const at = hay.indexOf(find, from)
    if (at < 0) break
    if (at > from) out.push({ text: props.text.slice(from, at), hit: false })
    out.push({ text: props.text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < props.text.length) out.push({ text: props.text.slice(from), hit: false })
  return out.length > 0 ? out : [{ text: props.text, hit: false }]
})
</script>

<template>
  <span class="highlight-text"><template
    v-for="(p, i) in parts"
    :key="i"
  ><mark v-if="p.hit">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></span>
</template>

<style scoped>
.highlight-text {
  white-space: inherit;
}

mark {
  background: var(--warn-soft);
  color: var(--text);
  border-radius: 2px;
  padding: 0 1px;
}
</style>
