<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";

const props = defineProps({
  state: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["settings", "persist", "save-settings", "open-data-dir", "background-probe"]);

const s = computed(() => props.state.settings || {});
const thr = computed(() => Number(form.template_threshold || 0).toFixed(2));
const hint = ref("");
const probeReady = ref(false);
const probeBusy = ref(false);
const probeStatus = ref("");
const probeSupported = ref(null);
const threadProbeReady = ref(false);

// 主进程用「F7（未生效）」这种带后缀的标签表示没注册上；表单只显示纯键名，状态单独提示。
const deadKeys = computed(() =>
  [
    ["hotkey_start", "开始"],
    ["hotkey_stop", "停止"],
  ]
    .filter(([key]) => String(props.state.meta?.[key] || "").includes("未生效"))
    .map(([, label]) => label),
);

// 本地表单：双向绑定 + 改动自动保存；以主进程回写值为准，避免「改完切走就还原」
const form = reactive({
  max_attempts: 200,
  action_delay_ms: 350,
  craft_wait_ms: 600,
  background_input: true,
  template_threshold: 0.8,
  hotkey_start: "f7",
  hotkey_stop: "f8",
});
let syncing = false;
let saveTimer = 0;
let revision = 0;
let savedRevision = 0;

function fromBackend() {
  form.max_attempts = s.value.max_attempts ?? 200;
  form.action_delay_ms = s.value.action_delay_ms ?? 350;
  form.craft_wait_ms = s.value.craft_wait_ms ?? 600;
  form.background_input = s.value.background_input !== false;
  form.template_threshold = s.value.template_threshold ?? 0.8;
  form.hotkey_start = s.value.hotkey_start ?? "f7";
  form.hotkey_stop = s.value.hotkey_stop ?? "f8";
}

// 后端回写后把表单同步成旧值（用 nextTick 让本次由表单触发的保存先被跳过，避免来回写）
async function syncFromSettings() {
  syncing = true;
  fromBackend();
  await nextTick();
  syncing = false;
}

// F1–F24 可单用；字母数字必须带修饰键
const HOTKEY_RE = /^(?:(?:ctrl|alt|shift|super)\+)*f(?:[1-9]|1\d|2[0-4])$|^(?:(?:ctrl|alt|shift|super)\+)+[a-z0-9]$/;

function hotkeyValue(field) {
  const raw = form[field] || "";
  return raw.replace(/[（(].*$/, "").trim().toLowerCase().replace(/\s+/g, "");
}

async function persist(targetRevision = revision) {
  const safe = (field, fallback) => {
    const key = hotkeyValue(field);
    return HOTKEY_RE.test(key) ? key : (s.value[field] ?? fallback);
  };
  const patch = {
    max_attempts: Number(form.max_attempts),
    action_delay_ms: Number(form.action_delay_ms),
    craft_wait_ms: Number(form.craft_wait_ms),
    background_input: Boolean(form.background_input),
    template_threshold: Number(form.template_threshold),
    hotkey_start: safe("hotkey_start", "f7"),
    hotkey_stop: safe("hotkey_stop", "f8"),
  };
  await new Promise((done) => emit("persist", patch, done));
  if (targetRevision !== revision) return;
  savedRevision = targetRevision;
  await syncFromSettings();
}

function schedulePersist(delay = 400) {
  clearTimeout(saveTimer);
  const targetRevision = revision;
  saveTimer = window.setTimeout(() => void persist(targetRevision), delay);
}

function onHotkeyChange(field) {
  const key = hotkeyValue(field);
  if (!HOTKEY_RE.test(key)) {
    hint.value = `热键「${form[field]}」不可用，已还原。可填 F1–F24，或 Ctrl+/Alt+/Shift+ 加字母数字。`;
    form[field] = s.value[field] ?? (field === "hotkey_start" ? "f7" : "f8");
    return;
  }
  hint.value = "";
  form[field] = key;
  // 热键改动需立即生效并落盘
  schedulePersist(50);
}

function backgroundProbe(action) {
  probeBusy.value = true;
  probeStatus.value =
    action === "prepare"
      ? "正在定位目标装备…"
      : action === "thread"
        ? "正在验证目标线程 Ctrl 状态并同步复制…"
        : "正在向被遮挡的游戏投递安全复制消息…";
  probeSupported.value = null;
  emit("background-probe", action, (result) => {
    probeBusy.value = false;
    if (!result || result.ok === false) {
      probeStatus.value = result?.error || "检测失败";
      probeSupported.value = false;
      return;
    }
    if (action === "prepare") {
      probeReady.value = Boolean(result.probe_ready);
      threadProbeReady.value = false;
    }
    if (action === "run") probeSupported.value = Boolean(result.supported);
    if (action === "run") threadProbeReady.value = Boolean(result.can_try_thread_state);
    if (action === "thread") probeSupported.value = Boolean(result.supported);
    probeStatus.value = result.message || "完成";
  });
}

// 改动即自动保存（防抖 400ms），不依赖失焦 change
watch(
  form,
  () => {
    if (syncing) return;
    revision += 1;
    schedulePersist();
  },
  { deep: true, flush: "sync" },
);

// 外部状态变化只在本地没有待保存改动时同步，避免切页回包覆盖防抖中的输入。
watch(
  () => props.state?.settings,
  () => {
    if (!syncing && revision === savedRevision) void syncFromSettings();
  },
  { deep: true },
);

onMounted(() => void syncFromSettings());
</script>

<template>
  <div class="settings">
    <section class="card col">
      <div class="h">通用设置</div>
      <p class="tiny">修改后自动保存到 settings.json。此页按开始热键不会启动工艺。</p>
      <div class="form">
        <label class="field">
          <span>最大次数</span>
          <input
            v-model.number="form.max_attempts"
            type="number"
            min="1"
            class="ctrl"
            :disabled="disabled"
          />
        </label>
        <label class="field">
          <span>动作延迟 ms</span>
          <input
            v-model.number="form.action_delay_ms"
            type="number"
            min="0"
            class="ctrl"
            :disabled="disabled"
          />
        </label>
        <label class="field">
          <span>工艺等待 ms</span>
          <input
            v-model.number="form.craft_wait_ms"
            type="number"
            min="0"
            class="ctrl"
            :disabled="disabled"
          />
        </label>
        <div class="field">
          <span>后台输入</span>
          <label class="check-row">
            <input
              type="checkbox"
              v-model="form.background_input"
              :disabled="disabled"
            />
            <span>遮挡运行，不抢鼠标键盘</span>
          </label>
        </div>
        <label class="field">
          <span>模板阈值</span>
          <div class="thr">
            <input
              v-model.number="form.template_threshold"
              type="range"
              min="0.5"
              max="0.99"
              step="0.01"
              :disabled="disabled"
            />
            <b>{{ thr }}</b>
          </div>
        </label>
        <label class="field">
          <span>开始热键</span>
          <input
            v-model="form.hotkey_start"
            class="ctrl"
            :disabled="disabled"
            @change="onHotkeyChange('hotkey_start')"
            @blur="onHotkeyChange('hotkey_start')"
          />
        </label>
        <label class="field">
          <span>停止热键</span>
          <input
            v-model="form.hotkey_stop"
            class="ctrl"
            :disabled="disabled"
            @change="onHotkeyChange('hotkey_stop')"
            @blur="onHotkeyChange('hotkey_stop')"
          />
        </label>
        <p v-if="hint" class="err">{{ hint }}</p>
        <p v-else-if="deadKeys.length" class="err">
          {{ deadKeys.join(" / ") }}热键未注册成功（可能被其他程序占用），换一个键试试。
        </p>
        <p class="tiny form-note">提示：动作延迟 / 工艺等待 / 剪贴板超时会作用于普通工艺与洗地图。</p>
      </div>
    </section>

    <section class="card col">
      <div class="h">后台输入兼容性检测</div>
      <p class="tiny">
        此检测不会点击鼠标。先让游戏窗口和目标装备完整可见并标定，再切回本工具或用其他窗口遮挡游戏；
        不要最小化游戏。第二步只投递无字母按键的安全复制消息。若被客户端忽略，第三步只会在目标线程中
        读回 Ctrl 已按下后投递 C，并保证补发 C-up、恢复线程状态；最后仍以合法装备文本作为通过标准。
      </p>
      <div class="probe-actions">
        <button type="button" class="btn" :disabled="disabled || probeBusy" @click="backgroundProbe('prepare')">
          1. 标定目标装备
        </button>
        <button
          type="button"
          class="btn"
          :disabled="disabled || probeBusy || !probeReady"
          @click="backgroundProbe('run')"
        >
          2. 安全复制测试
        </button>
        <button
          type="button"
          class="btn"
          :disabled="disabled || probeBusy || !probeReady || !threadProbeReady"
          @click="backgroundProbe('thread')"
        >
          3. 增强复制测试
        </button>
      </div>
      <p v-if="probeStatus" class="probe-status" :class="{ pass: probeSupported === true, fail: probeSupported === false }">
        {{ probeStatus }}
      </p>
    </section>

    <section class="card col">
      <div class="h">数据目录</div>
      <p class="tiny">
        安装版的配置与模板在 %APPDATA%\PoeCrafting；从源码运行时用项目内的 config/。
        找不到配方或模板时从这里打开。
      </p>
      <div>
        <button type="button" class="btn" @click="$emit('open-data-dir')">打开数据目录</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  min-height: 0;
  overflow: auto;
}
.settings > section + section { margin-top: 10px; }
.col {
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}
.form {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px 10px;
  align-items: center;
}
.form .field { display: contents; }
.form .field > span { color: var(--muted); }
.err { grid-column: 1 / -1; margin: 0; font-size: 12px; color: #e5383b; }
.thr { display: flex; align-items: center; gap: 8px; }
.thr input { flex: 1; }
.thr b { width: 40px; font-variant-numeric: tabular-nums; }
.form-note { grid-column: 1 / -1; margin: 0; }
.check-row { display: inline-flex; align-items: center; gap: 7px; color: var(--text); }
.probe-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.probe-status { margin: 0; font-size: 12px; color: var(--muted); white-space: pre-wrap; }
.probe-status.pass { color: #75c99a; }
.probe-status.fail { color: #ef7d7d; }
</style>
