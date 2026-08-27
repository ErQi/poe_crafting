<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  state: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["settings", "persist", "save-settings", "open-data-dir", "background-probe"]);

const s = computed(() => props.state.settings);
const thr = computed(() => Number(s.value.template_threshold || 0).toFixed(2));
const hint = ref("");
const probeReady = ref(false);
const probeBusy = ref(false);
const probeStatus = ref("");
const probeSupported = ref(null);
const threadProbeReady = ref(false);

function persistBoolean(field, checked) {
  emit("persist", { [field]: Boolean(checked) });
}

// 主进程用「F7（未生效）」这种带后缀的标签表示没注册上；可编辑处只放纯键名，状态单独提示
const deadKeys = computed(() =>
  [
    ["hotkey_start", "开始"],
    ["hotkey_stop", "停止"],
  ]
    .filter(([k]) => String(props.state.meta?.[k] || "").includes("未生效"))
    .map(([, label]) => label),
);

// 后端会静默丢弃非法值，往返结束后必须用后端真实值回写，否则框里会留着并未生效的输入
async function persist(field, el) {
  await new Promise((done) => emit("persist", { [field]: el.value }, done));
  el.value = s.value[field] ?? "";
}

// F1–F24 可单用；字母数字必须带修饰键，否则会在游戏里全局劫持普通按键
const HOTKEY_RE = /^(?:(?:ctrl|alt|shift|super)\+)*f(?:[1-9]|1\d|2[0-4])$|^(?:(?:ctrl|alt|shift|super)\+)+[a-z0-9]$/;

// 热键改坏会丢掉运行时唯一的中断手段，后端不校验，这里先拦一道；顺手剥掉可能带上的状态后缀
async function persistHotkey(field, el) {
  const key = el.value.replace(/[（(].*$/, "").trim().toLowerCase().replace(/\s+/g, "");
  if (!HOTKEY_RE.test(key)) {
    hint.value = `热键「${el.value}」不可用，已还原。可填 F1–F24，或 Ctrl+/Alt+/Shift+ 加字母数字。`;
    el.value = s.value[field] ?? "";
    return;
  }
  hint.value = "";
  el.value = key;
  await persist(field, el);
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
</script>

<template>
  <div class="settings">
    <section class="card col">
      <div class="h">通用设置</div>
      <p class="tiny">修改后立即写入 settings.json。此页按开始热键不会启动工艺。</p>
      <div class="form">
        <label class="field">
          <span>最大次数</span>
          <input
            class="ctrl"
            :value="s.max_attempts"
            :disabled="disabled"
            @change="persist('max_attempts', $event.target)"
          />
        </label>
        <label class="field">
          <span>动作延迟 ms</span>
          <input
            class="ctrl"
            :value="s.action_delay_ms"
            :disabled="disabled"
            @change="persist('action_delay_ms', $event.target)"
          />
        </label>
        <label class="field">
          <span>工艺等待 ms</span>
          <input
            class="ctrl"
            :value="s.craft_wait_ms"
            :disabled="disabled"
            @change="persist('craft_wait_ms', $event.target)"
          />
        </label>
        <div class="field">
          <span>后台输入</span>
          <label class="check-row">
            <input
              type="checkbox"
              :checked="s.background_input !== false"
              :disabled="disabled"
              @change="persistBoolean('background_input', $event.target.checked)"
            />
            <span>遮挡运行，不抢鼠标键盘</span>
          </label>
        </div>
        <label class="field">
          <span>模板阈值</span>
          <div class="thr">
            <input
              type="range"
              min="0.5"
              max="0.99"
              step="0.01"
              :value="s.template_threshold"
              :disabled="disabled"
              @input="$emit('settings', { template_threshold: Number($event.target.value) })"
              @change="$emit('save-settings')"
            />
            <b>{{ thr }}</b>
          </div>
        </label>
        <label class="field">
          <span>开始热键</span>
          <input
            class="ctrl"
            :value="s.hotkey_start"
            :disabled="disabled"
            @change="persistHotkey('hotkey_start', $event.target)"
          />
        </label>
        <label class="field">
          <span>停止热键</span>
          <input
            class="ctrl"
            :value="s.hotkey_stop"
            :disabled="disabled"
            @change="persistHotkey('hotkey_stop', $event.target)"
          />
        </label>
        <p v-if="hint" class="err">{{ hint }}</p>
        <p v-else-if="deadKeys.length" class="err">
          {{ deadKeys.join(" / ") }}热键未注册成功（可能被其他程序占用），换一个键试试。
        </p>
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
.check-row { display: inline-flex; align-items: center; gap: 7px; color: var(--text); }
.probe-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.probe-status { margin: 0; font-size: 12px; color: var(--muted); white-space: pre-wrap; }
.probe-status.pass { color: #75c99a; }
.probe-status.fail { color: #ef7d7d; }
</style>
