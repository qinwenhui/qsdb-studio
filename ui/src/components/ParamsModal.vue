<script setup lang="ts">
import { NButton, NInput, NModal } from 'naive-ui'
import { computed } from 'vue'
import { cancelParams, confirmParams, paramsState } from '../stores/params'

const show = computed({
  get: () => paramsState.visible,
  set: (v: boolean) => {
    if (!v) cancelParams()
  },
})
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="$t('查询参数')"
    style="width: 560px"
    :mask-closable="false"
  >
    <div class="hint">
      {{ $t("服务端在绑定器里把参数变成 AST 字面量（值不进入 SQL 文本）。值按 JSON\n      解析（") }}<span class="mono">10</span> {{ $t("→ 数字，") }}<span class="mono">true</span> {{ $t("→\n      布尔，") }}<span class="mono">"abc"</span> {{ $t("→ 字符串）；解析不了就按字符串。\n      日期等请填显式类型（如") }} <span class="mono">DATE</span>）。
    </div>

    <div class="params">
      <div v-for="(draft, i) in paramsState.drafts" :key="i" class="param-row">
        <div class="param-label">{{ $t("参数") }} {{ i + 1 }}</div>
        <NInput
          v-model:value="draft.ty"
          size="small"
          :placeholder="$t('类型（可选，如 DATE / BIGINT / DECIMAL(10,2)）')"
          class="type-input"
        />
        <NInput
          v-model:value="draft.value"
          size="small"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 4 }"
          :placeholder="$t('值（JSON 或普通文本）')"
        />
      </div>
    </div>

    <template #footer>
      <div class="footer">
        <span class="foot-hint">
          {{ paramsState.drafts.length }} {{ $t("个参数 · 草稿仅保存在本次会话内存") }}
        </span>
        <span class="spacer" />
        <NButton size="small" @click="cancelParams">{{ $t("取消") }}</NButton>
        <NButton size="small" type="primary" @click="confirmParams">{{ $t("执行") }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.hint {
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--muted);
  margin-bottom: 12px;
}

.params {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 48vh;
  overflow: auto;
  padding-right: 2px;
}

.param-row {
  display: grid;
  grid-template-columns: 64px 190px 1fr;
  gap: 8px;
  align-items: start;
}

.param-label {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-soft);
  padding-top: 6px;
}

.type-input :deep(input) {
  font-family: var(--mono);
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.foot-hint {
  font-size: 11px;
  color: var(--muted);
}

.spacer {
  flex: 1;
}
</style>
