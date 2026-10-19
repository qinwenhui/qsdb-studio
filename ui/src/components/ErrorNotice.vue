<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { StudioError } from '../ipc/types'
import { t, tt } from '../i18n'
import { errorHint, retryable } from '../utils/errors'

const props = withDefaults(
  defineProps<{
    error: StudioError
    showRetry?: boolean
    dense?: boolean
  }>(),
  { showRetry: true, dense: false },
)

const emit = defineEmits<{
  (e: 'retry'): void
  (e: 'relogin'): void
  (e: 'guardrail'): void
}>()

const countdown = ref(0)
let timer: number | undefined

const canRetry = computed(() => retryable(props.error))
const needsLogin = computed(
  () => props.error.code === 'SESSION_REVOKED' || props.error.code === 'UNAUTHORIZED',
)
const isGuardrail = computed(() => props.error.code === 'RESULT_TOO_LARGE')

function startCountdown() {
  window.clearInterval(timer)
  if (!canRetry.value) {
    countdown.value = 0
    return
  }
  countdown.value = 3
  timer = window.setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) {
      countdown.value = 0
      window.clearInterval(timer)
    }
  }, 1000)
}

watch(
  () => props.error,
  () => startCountdown(),
  { immediate: true },
)

onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="notice" :class="{ dense }">
    <div class="head">
      <span v-if="error.code" class="code-badge">{{ error.code }}</span>
      <span v-else class="chip danger">{{ error.kind }}</span>
      <span v-if="error.status" class="status">HTTP {{ error.status }}</span>
      <span v-if="canRetry" class="chip warn">{{ $t("可重试") }}</span>
      <span class="spacer" />
      <NButton v-if="isGuardrail" size="tiny" type="warning" secondary @click="emit('guardrail')">
        {{ $t("护栏选项") }}
      </NButton>
      <NButton v-if="needsLogin" size="tiny" type="primary" secondary @click="emit('relogin')">
        {{ $t("重新登录") }}
      </NButton>
      <NButton
        v-if="showRetry && canRetry"
        size="tiny"
        type="primary"
        :disabled="countdown > 0"
        @click="emit('retry')"
      >
        {{ countdown > 0 ? tt`${countdown}s 后重试` : t('重试') }}
      </NButton>
      <NButton v-if="showRetry && !canRetry" size="tiny" secondary @click="emit('retry')">
        {{ $t("重跑") }}
      </NButton>
    </div>
    <div class="message">{{ error.message }}</div>
    <div class="hint">{{ errorHint(error) }}</div>
  </div>
</template>

<style scoped>
.notice {
  margin: 10px 12px;
  padding: 11px 12px;
  border-radius: 8px;
  background: var(--danger-soft);
  border: 1px solid var(--danger-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.notice.dense {
  margin: 0;
  padding: 8px 10px;
}

.head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.status {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--danger);
}

.spacer {
  flex: 1;
}

.message {
  color: var(--danger-text);
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
}

.hint {
  color: var(--danger);
  font-size: 11.5px;
  line-height: 1.5;
}
</style>
