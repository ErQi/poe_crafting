<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";

const props = defineProps({
  state: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["settings", "persist", "save-settings", "open-data-dir"]);

const s = computed(() => props.state.settings || {});
const thr = computed(() => Number(form.template_threshold || 0).toFixed(2));
const hint = ref("");

// 本地表单：双向绑定 + 改动自动保存；以主进程回写值为准，避免「改完切走就还原」
const form = reactive({
  max_attempts: 200,
  action_delay_ms: 350,
  craft_wait_ms: 600,
  template_threshold: 0.8,
  hotkey_start: "f7",
  hotkey_stop: "f8",
});
let syncing = false;
let saveTimer = 0;

function fromBackend() {
  form.max_attempts = s.value.max_attempts ?? 200;
  form.action_delay_ms = s.value.action_delay_ms ?? 350;
  form.craft_wait_ms = s.value.craft_wait_ms ?? 600;
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

async function persist() {
  const safe = (field, fallback) => {
    const key = hotkeyValue(field);
    return HOTKEY_RE.test(key) ? key : (s.value[field] ?? fallback);
  };
  const patch = {
    max_attempts: Number(form.max_attempts),
    action_delay_ms: Number(form.action_delay_ms),
    craft_wait_ms: Number(form.craft_wait_ms),
    template_threshold: Number(form.template_threshold),
    hotkey_start: safe("hotkey_start", "f7"),
    hotkey_stop: safe("hotkey_stop", "f8"),
  };
  await new Promise((done) => emit("persist", patch, done));
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
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void persist(), 50);
}

// 改动即自动保存（防抖 400ms），不依赖失焦 change
watch(
  form,
  () => {
    if (syncing) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void persist();
    }, 400);
  },
  { deep: true },
);

// 后端设置变化（含本页保存回写）时同步表单显示
watch(
  () => props.state?.settings,
  () => {
    if (!syncing) void syncFromSettings();
  },
  { deep: true },
);

onMounted(() => fromBackend());
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
        <p class="tiny">提示：动作延迟 / 工艺等待 / 剪贴板超时会作用于普通工艺与洗地图。</p>
      </div>
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
</style>