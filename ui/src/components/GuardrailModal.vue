<script setup lang="ts">
import { NButton, NInputNumber, NModal } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { applyGuardrail, dismissGuardrail, queryState } from '../stores/query'
import { wrapWithLimit } from '../utils/sql'

const limit = ref(10000)
const busy = ref(false)

/** 从服务端文案里取护栏上限（文案不做兼容承诺，只用于**默认值**；取不到就 10000）。 */
const guardRows = computed(() => {
  const m = queryState.guardrail.error?.message.match(/max-result-rows\s+(\d+)/i)
  return m ? Number(m[1]) : null
})

watch(
  () => queryState.guardrail.error,
  () => {
    limit.value = guardRows.value ?? 10000
  },
  { immediate: true },
)

async function run(action: 'limit' | 'unlimited' | 'stream') {
  busy.value = true
  try {
    await applyGuardrail(action, limit.value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <NModal
    :show="queryState.guardrail.visible"
    preset="card"
    :title="$t('结果超过服务端护栏')"
    style="width: 640px"
    :mask-closable="false"
    @update:show="(v: boolean) => !v && dismissGuardrail()"
  >
    <div class="body">
      <div class="server-msg">
        <span class="code-badge">{{ queryState.guardrail.error?.code ?? 'RESULT_TOO_LARGE' }}</span>
        <pre>{{ queryState.guardrail.error?.message }}</pre>
      </div>
      <div class="explain">
        {{ $t("服务端在执行后、序列化前检查结果护栏，**绝不返回部分数据**。请选择一条路：") }}
      </div>

      <div class="option">
        <div class="opt-head">
          <span class="opt-title">{{ $t("① 加 LIMIT 重跑") }}</span>
          <span class="opt-sub">{{ $t("保持部署方护栏，缩小结果") }}</span>
        </div>
        <div class="opt-body">
          <NInputNumber v-model:value="limit" size="small" :min="1" :step="1000" style="width: 150px" />
          <span v-if="guardRows" class="opt-sub">{{ $t("服务端上限") }} {{ guardRows }} {{ $t("行") }}</span>
          <span class="preview mono">{{ wrapWithLimit(queryState.guardrail.sql, limit ?? 10000) }}</span>
        </div>
        <div class="opt-action">
          <NButton size="small" type="primary" :loading="busy" @click="run('limit')">
            {{ $t("加 LIMIT 重跑") }}
          </NButton>
        </div>
      </div>

      <div class="option">
        <div class="opt-head">
          <span class="opt-title">{{ $t("② 本请求不限") }}</span>
          <span class="opt-sub">maxRows = 0</span>
        </div>
        <div class="opt-body warn">
          {{ $t("该请求会") }}<b>{{ $t("豁免部署方的结果护栏") }}</b>{{ $t("（客户端显式担责）。结果页会带\n          “本请求已豁免护栏”的标注——不会假装是常规查询。") }}
        </div>
        <div class="opt-action">
          <NButton size="small" type="warning" secondary :loading="busy" @click="run('unlimited')">
            {{ $t("本次豁免并重跑") }}
          </NButton>
        </div>
      </div>

      <div class="option">
        <div class="opt-head">
          <span class="opt-title">{{ $t("③ 流式浏览（本请求豁免护栏）") }}</span>
          <span class="opt-sub">{{ $t("rows 通道 · maxRows = 0") }}</span>
        </div>
        <div class="opt-body warn">
          {{ $t("流式不会绕过部署方的行护栏（护栏是全格式一致的部署策略）。这一条 =\n          流式 + 显式") }} <span class="mono">maxRows=0</span> {{ $t("合并：Rust 边收边落盘、\n          网格按页取，同时**显式豁免**本请求的护栏；结果页会带“护栏已豁免”标注。") }}
        </div>
        <div class="opt-action">
          <NButton size="small" type="primary" ghost :loading="busy" @click="run('stream')">
            {{ $t("流式 + 豁免并重跑") }}
          </NButton>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="footer">
        <NButton size="small" @click="dismissGuardrail">{{ $t("取消") }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.server-msg {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 11px;
  border-radius: 7px;
  background: var(--danger-soft);
  border: 1px solid var(--danger-border);
}

.server-msg pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--danger-text);
  max-height: 120px;
  overflow: auto;
}

.explain {
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.6;
}

.option {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 11px;
  background: var(--surface-raised);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.opt-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.opt-title {
  font-weight: 650;
  font-size: 13px;
}

.opt-sub {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}

.opt-body {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-soft);
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.opt-body.warn {
  color: var(--warn);
}

.preview {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--muted);
  background: var(--panel-soft);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 6px;
  max-height: 52px;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-all;
}

.opt-action {
  display: flex;
  justify-content: flex-end;
}

.footer {
  display: flex;
  justify-content: flex-end;
}
</style>
