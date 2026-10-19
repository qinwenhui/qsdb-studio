<script setup lang="ts">
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSwitch,
} from 'naive-ui'
import { computed, reactive, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type {
  AuthKind,
  ConnTestResult,
  ProfileInput,
  ProfileView,
  StudioError,
} from '../ipc/types'
import { saveProfile, toStudioError } from '../stores/app'
import { errorHint } from '../utils/errors'

import { language, t, tt } from '../i18n'

const props = defineProps<{
  show: boolean
  profile: ProfileView | null
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'saved', value: ProfileView): void
}>()

const saving = ref(false)
const error = ref('')
const testing = ref(false)
const testResult = ref<ConnTestResult | null>(null)
const testError = ref<StudioError | null>(null)
const testHint = computed(() => (testError.value ? errorHint(testError.value) : ''))

const form = reactive({
  name: '',
  url: 'qsdb://127.0.0.1:9430',
  authKind: 'none' as AuthKind['kind'],
  user: '',
  secret: '',
  defaultDatabase: '',
  readOnly: false,
})

const editing = computed(() => props.profile)
const isBasic = computed(() => form.authKind === 'basic')
const isBearer = computed(() => form.authKind === 'bearer')
const needsSecret = computed(() => form.authKind !== 'none')
const secretLabel = computed(() => (isBearer.value ? 'Token' : t('密码')))
const hasSavedSecret = computed(() => Boolean(props.profile?.hasSecret))
const secretPlaceholder = computed(() =>
  hasSavedSecret.value
    ? t('已保存于系统凭据管理器；留空保持不变')
    : language.locale === 'en'
      ? `Enter ${secretLabel.value}`
      : `请输入${secretLabel.value}`,
)

watch(
  () => props.show,
  (open) => {
    if (!open) return
    error.value = ''
    testResult.value = null
    testError.value = null
    form.secret = ''
    const p = props.profile
    form.name = p?.name ?? ''
    form.url = p?.url ?? 'qsdb://127.0.0.1:9430'
    form.authKind = p?.auth.kind ?? 'none'
    form.user = p?.auth.kind === 'basic' ? p.auth.user : ''
    form.defaultDatabase = p?.defaultDatabase ?? ''
    form.readOnly = p?.readOnly ?? false
  },
)

// 表单字段变化后旧的测试结论不再成立（避免“改完 URL 还显示上一次成功”）。
watch(
  () => [form.url, form.authKind, form.user, form.secret, form.defaultDatabase],
  () => {
    testResult.value = null
    testError.value = null
  },
)

function auth(): AuthKind {
  if (form.authKind === 'basic') return { kind: 'basic', user: form.user.trim() }
  if (form.authKind === 'bearer') return { kind: 'bearer' }
  return { kind: 'none' }
}

/** 校验并构造 IPC 输入；测试时允许连接名留空。 */
function buildInput(requireName: boolean): ProfileInput | null {
  error.value = ''
  if (requireName && !form.name.trim()) {
    error.value = t('连接名称不能为空')
    return null
  }
  if (!form.url.trim()) {
    error.value = t('服务地址不能为空')
    return null
  }
  if (isBasic.value && !form.user.trim()) {
    error.value = t('Basic 认证需要用户名')
    return null
  }
  if (needsSecret.value && !form.secret && !hasSavedSecret.value) {
    error.value = requireName
      ? tt`请填写${secretLabel.value}（只会保存到系统凭据管理器）`
      : tt`请填写${secretLabel.value}后测试（测试不会保存它）`
    return null
  }
  return {
    id: props.profile?.id ?? null,
    name: form.name.trim() || t('（未命名测试）'),
    url: form.url.trim(),
    auth: auth(),
    defaultDatabase: form.defaultDatabase.trim() || null,
    readOnly: form.readOnly,
    // 密码/Token **不 trim**（空格可能是秘密的一部分）；只在为空时表示不改。
    secret: form.secret.length > 0 ? form.secret : null,
  }
}

async function onTest() {
  testResult.value = null
  testError.value = null
  const input = buildInput(false)
  if (!input) return
  testing.value = true
  try {
    testResult.value = await ipc.connTest(input)
  } catch (e) {
    testError.value = toStudioError(e)
  } finally {
    testing.value = false
  }
}

async function onSave() {
  const input = buildInput(true)
  if (!input) return
  saving.value = true
  try {
    const saved = await saveProfile(input)
    emit('saved', saved)
    emit('update:show', false)
  } catch (e) {
    const info = (e as { info?: { message: string } }).info
    error.value = info?.message ?? (e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="editing ? $t('编辑连接') : $t('新建连接')"
    style="width: 560px"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <NForm label-placement="top" size="small">
      <NFormItem :label="$t('连接名称')" required>
        <NInput v-model:value="form.name" :placeholder="$t('例如：本地开发实例')" />
      </NFormItem>

      <NFormItem :label="$t('服务地址')" required>
        <NInput
          v-model:value="form.url"
          placeholder="qsdb://127.0.0.1:9430"
          class="mono-input"
        />
        <div class="hint">
          {{ $t("推荐") }} <span class="mono">qsdb://host:port</span>{{ $t("（兼容") }}
          <span class="mono">http://host:port</span>{{ $t("）。") }}<b>{{ $t("qsdb:// 只是客户端\n            连接串别名，不是加密协议") }}</b>{{ $t("——底层仍是明文 HTTP/1.1；需要加密请在前置\n          代理终止。端口必填，不猜默认端口。") }}
        </div>
      </NFormItem>

      <NFormItem :label="$t('认证方式')">
        <NRadioGroup v-model:value="form.authKind" size="small">
          <NRadioButton value="none">{{ $t("匿名") }}</NRadioButton>
          <NRadioButton value="basic">{{ $t("用户名 / 密码") }}</NRadioButton>
          <NRadioButton value="bearer">{{ $t("静态 Token") }}</NRadioButton>
        </NRadioGroup>
        <div class="hint">
          {{ $t("服务端启用用户体系（如 bootstrap_admin / 用户文件）时，匿名请求会\n          401；请改用用户名/密码或静态 Token 登录。") }}
        </div>
      </NFormItem>

      <NFormItem v-if="isBasic" :label="$t('用户名')" required>
        <NInput v-model:value="form.user" placeholder="admin" />
      </NFormItem>

      <NFormItem v-if="needsSecret" :label="secretLabel">
        <NInput
          v-model:value="form.secret"
          type="password"
          show-password-on="click"
          :autocomplete="'new-password'"
          :placeholder="secretPlaceholder"
        />
        <div class="hint">
          {{ secretLabel }}{{ $t("只写入 OS 凭据管理器，档案 JSON 与日志都不包含它。") }}
        </div>
      </NFormItem>

      <NFormItem :label="$t('默认库（可选）')">
        <NInput v-model:value="form.defaultDatabase" :placeholder="$t('登录后自动 USE 这个库')" />
        <div class="hint">{{ $t("默认库需要 Basic 登录会话；匿名/静态 Token 请用 db.table 限定名。") }}</div>
      </NFormItem>

      <NFormItem :label="$t('只读连接')">
        <div class="readonly-row">
          <NSwitch v-model:value="form.readOnly" size="small" />
          <span class="readonly-label">
            {{ $t("拦截 INSERT / UPDATE / DELETE / DDL / CSV 导入等写语句；SELECT、SHOW、\n            EXPLAIN 仍可执行。") }}
          </span>
        </div>
        <div class="hint">
          {{ $t("这是客户端护栏（执行前拦截），不是服务端授权：真正的读写边界仍由 QSDB 的\n          grants 决定，适合给生产库加一层防误操作。") }}
        </div>
      </NFormItem>

      <div v-if="error" class="form-error">{{ error }}</div>

      <div v-if="testError" class="test-card fail">
        <div class="test-head">
          <span class="test-badge fail">{{ $t("连接失败") }}</span>
          <span class="code-badge">{{ testError.code ?? testError.kind }}</span>
        </div>
        <div class="test-msg">{{ testError.message }}</div>
        <div v-if="testHint" class="test-hint">{{ testHint }}</div>
      </div>

      <div v-else-if="testResult" class="test-card ok">
        <div class="test-head">
          <span class="test-badge ok">{{ $t("连接成功") }}</span>
          <span class="chip">v{{ testResult.version }}</span>
          <span class="chip">{{ Math.round(testResult.elapsedMs) }} ms</span>
        </div>
        <div class="test-line">
          <span v-if="testResult.user">
            {{ $t("身份") }} <b>{{ testResult.user }}</b>
            <template v-if="testResult.role"> · {{ testResult.role }}</template>
          </span>
          <span v-else>{{ $t("匿名 / 静态 Token（无会话身份）") }}</span>
          <span v-if="testResult.defaultDb"> {{ $t("· 默认库") }} <b>{{ testResult.defaultDb }}</b></span>
        </div>
        <div v-for="w in testResult.warnings" :key="w" class="test-warn">{{ w }}</div>
        <div class="test-note">{{ $t("测试不会保存档案或密码；确认无误后再点“保存”。") }}</div>
      </div>
    </NForm>

    <template #footer>
      <div class="footer">
        <NButton size="small" :loading="testing" :disabled="saving" @click="onTest">
          {{ $t("测试连接") }}
        </NButton>
        <span class="footer-spacer" />
        <NButton size="small" @click="emit('update:show', false)">{{ $t("取消") }}</NButton>
        <NButton
          size="small"
          type="primary"
          :loading="saving"
          :disabled="testing"
          @click="onSave"
        >
          {{ $t("保存") }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.hint {
  margin-top: 5px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
}

.mono-input :deep(input) {
  font-family: var(--mono);
}

.readonly-row {
  display: flex;
  align-items: center;
  gap: 9px;
}

.readonly-label {
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.5;
}

.form-error {
  margin-top: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--danger-soft);
  border: 1px solid var(--danger-border);
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.footer-spacer {
  flex: 1;
}

.test-card {
  margin-top: 4px;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.55;
}

.test-card.ok {
  background: var(--ok-soft);
  border-color: var(--ok-border);
  color: var(--text-soft);
}

.test-card.fail {
  background: var(--danger-soft);
  border-color: var(--danger-border);
  color: var(--danger-text);
}

.test-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 5px;
}

.test-badge {
  font-weight: 700;
  font-size: 11.5px;
}

.test-badge.ok {
  color: var(--ok);
}

.test-badge.fail {
  color: var(--danger);
}

.test-line b {
  font-family: var(--mono);
  color: var(--text);
  font-weight: 650;
}

.test-msg {
  word-break: break-word;
}

.test-hint,
.test-note {
  margin-top: 5px;
  font-size: 11px;
  color: var(--muted);
}

.test-warn {
  margin-top: 4px;
  font-size: 11px;
  color: var(--warn);
}
</style>
