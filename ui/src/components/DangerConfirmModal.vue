<script setup lang="ts">
import { NButton, NInput, NModal } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { dangerState, settleDanger } from '../stores/safety'
import { shortText } from '../utils/format'

const typed = ref('')

watch(
  () => dangerState.request,
  () => {
    typed.value = ''
  },
)

const request = computed(() => dangerState.request)
const typingText = computed(() => request.value?.typingText ?? null)
const ready = computed(
  () =>
    !typingText.value ||
    typed.value.trim().toLowerCase() === typingText.value.toLowerCase(),
)

function confirm() {
  if (!ready.value) return
  settleDanger(true)
}

function close() {
  settleDanger(false)
}
</script>

<template>
  <NModal
    :show="dangerState.visible"
    preset="card"
    :title="$t('确认执行危险语句')"
    style="width: 620px"
    :mask-closable="false"
    @update:show="(v) => { if (!v) close() }"
  >
    <div v-if="request" class="danger-body">
      <div class="lead">
        {{ $t("以下语句可能不可逆地修改数据。请确认连接与目标表无误后继续。") }}
      </div>

      <div class="target">
        <i class="dot" :style="{ background: request.profileColor }" />
        <span class="mono">{{ request.profileName }}</span>
        <span class="count">{{ request.items.length }} {{ $t("条语句") }}</span>
      </div>

      <div class="items">
        <div v-for="(item, i) in request.items" :key="i" class="item">
          <div class="item-head">
            <span class="line">{{ $t("行") }} {{ item.line }}</span>
            <span class="verb">{{ item.analysis.verb }}</span>
            <span v-if="item.analysis.table" class="table mono">{{ item.analysis.table }}</span>
            <span v-if="item.analysis.hard" class="hard">{{ $t("高风险") }}</span>
          </div>
          <div class="reason">{{ item.analysis.reason }}</div>
          <pre class="sql">{{ shortText(item.sql, 240) }}</pre>
        </div>
      </div>

      <div v-if="typingText" class="typing">
        {{ $t("请输入") }}
        <code>{{ typingText }}</code>
        {{ $t("以确认（不区分大小写，但必须完整）：") }}
        <NInput
          v-model:value="typed"
          size="small"
          :placeholder="$t('输入确认文本')"
          class="typed-input"
          @keyup.enter="confirm"
        />
      </div>
      <div v-else class="note">
        {{ $t("确认后将立即执行。关闭此窗口不会发送任何请求。") }}
      </div>
    </div>

    <template #footer>
      <div class="footer">
        <span class="footer-spacer" />
        <NButton size="small" @click="close">{{ $t("取消") }}</NButton>
        <NButton size="small" type="error" :disabled="!ready" @click="confirm">
          {{ $t("仍要执行") }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.danger-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lead {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-soft);
}

.target {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
}

.count {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
}

.items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow: auto;
}

.item {
  border: 1px solid var(--danger-border);
  border-radius: 8px;
  background: var(--danger-soft);
  padding: 8px 10px;
}

.item-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.line {
  font-size: 10.5px;
  color: var(--muted);
}

.verb {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--danger);
}

.table {
  font-size: 11.5px;
  color: var(--text);
}

.hard {
  margin-left: auto;
  font-size: 9.5px;
  padding: 1px 6px;
  border-radius: 7px;
  color: var(--danger);
  background: var(--surface-raised);
  border: 1px solid var(--danger-border);
}

.reason {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--danger-text);
}

.sql {
  margin: 6px 0 0;
  padding: 6px 8px;
  border-radius: 5px;
  background: var(--surface-raised);
  color: var(--text-soft);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.typing {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-soft);
}

.typing code {
  font-family: var(--mono);
  color: var(--text);
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
}

.typed-input {
  margin-top: 6px;
}

.note {
  font-size: 11px;
  color: var(--muted);
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.footer-spacer {
  flex: 1;
}

.mono {
  font-family: var(--mono);
}
</style>
