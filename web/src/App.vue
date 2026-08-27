<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import {
  call,
  closeWindow,
  isTextField,
  isWindowMaximized,
  minimizeWindow,
  onBootStatus,
  onPush,
  onWindowMaximized,
  ready,
  splashReady,
  toggleMaximizeWindow,
} from "./api.js";
import Modal from "./components/Modal.vue";
import HelpPage from "./pages/HelpPage.vue";
import CraftPage from "./pages/CraftPage.vue";
import WorkflowPage from "./pages/WorkflowPage.vue";
import TemplatesPage from "./pages/TemplatesPage.vue";
import PricePatchPage from "./pages/PricePatchPage.vue";
import ClientEnhancementsPage from "./pages/ClientEnhancementsPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";

const tab = ref("help");
const state = ref(null);
const splash = ref(true);
const isMax = ref(false);
const bootError = ref("");
const runtime = ref({ running: false, logs: [], status_text: "状态: 空闲" });
const pendingPreview = ref("");
let pendingInfo = "";
// 队列而非单槽位：引擎告警随时可能到达，不能覆盖掉正在等待的确认框
const dlgQueue = reactive([]);
const dlg = computed(() => dlgQueue[0] || null);
let pollId = 0;
let lastAlertId = 0;

const running = computed(() => Boolean(runtime.value.running));
const startKey = computed(() => state.value?.meta?.hotkey_start || "F7");
const stopKey = computed(() => state.value?.meta?.hotkey_stop || "F8");

function apply(res) {
  if (!res || !state.value) return false;
  if (res.workflow) state.value.workflow = res.workflow;
  if (res.library) state.value.library = res.library;
  if (res.settings) state.value.settings = res.settings;
  if (res.ruleset) state.value.ruleset = res.ruleset;
  if (res.templates) state.value.templates = res.templates;
  if (res.price_patch) {
    state.value.price_patch = res.price_patch;
    runtime.value.price_patch = res.price_patch;
  }
  if (res.client_enhancements) {
    state.value.client_enhancements = res.client_enhancements;
    runtime.value.client_enhancements = res.client_enhancements;
  }
  if (res.meta) state.value.meta = res.meta;
  if (res.item_preview) {
    state.value.item_preview = res.item_preview;
    runtime.value.item_preview = res.item_preview;
  }
  if (res.pending_preview !== undefined) setPending(res.pending_preview, res.runtime?.pending_info);
  if (res.runtime) runtime.value = res.runtime;
  return true;
}

function setPending(url, info) {
  pendingInfo = info || "";
  pendingPreview.value = url || "";
}

// 预览图不再随 runtime 下发：粘贴的响应里直接带回，其余情况只在 pending_info 变化时补取一次
async function syncPending(info) {
  const next = info || "";
  if (next === pendingInfo) return;
  setPending("", next); // 先占位，避免连续 push 期间重复取图
  if (!next || next === "未粘贴") return;
  const res = await call("get_pending_preview").catch(() => null);
  setPending(res?.pending_preview, next);
}

function modal({ title, message, input = null, hideCancel = false }) {
  return new Promise((resolve) => {
    dlgQueue.push({ title, message, input, hideCancel, resolve });
  });
}

function closeDlg(ok) {
  const cur = dlgQueue.shift();
  if (!cur) return;
  cur.resolve(ok ? (cur.input !== null ? cur.input : true) : null);
}

function onPrompt(payload) {
  modal({ title: payload.title, message: payload.message, input: payload.value }).then(payload.resolve);
}

function alertBox(title, message) {
  return modal({ title, message, hideCancel: true });
}

function confirmBox(title, message) {
  return modal({ title, message }).then(Boolean);
}

function onAlert(rt) {
  const a = rt?.alert;
  if (!a || a.id === lastAlertId) return;
  lastAlertId = a.id;
  alertBox(a.title || "提示", a.message || "");
}

function pushRuntime(rt) {
  runtime.value = rt;
  if (rt.item_preview && state.value) state.value.item_preview = rt.item_preview;
  // 必须跟着清空：识别库最终加载成功后主进程会把 init_error 置空并推一次
  bootError.value = rt.init_error || "";
  void syncPending(rt.pending_info);
  onAlert(rt);
}

function finishSplash(error = "") {
  if (error) bootError.value = error;
  splash.value = false;
  if (!state.value) void loadState();
}

async function loadState() {
  try {
    state.value = await call("get_state");
    if (state.value.runtime) pushRuntime(state.value.runtime);
    await setTab("help");
  } catch {
    /* 宿主尚未就绪 */
  }
}

let offPush = null;
let offBoot = null;
let offMax = null;
let splashTimer = 0;

function applyMax(on) {
  isMax.value = Boolean(on);
  document.documentElement.classList.toggle("is-max", isMax.value);
}

async function wrap(fn) {
  try {
    const res = await fn();
    if (res && res.ok === false) {
      if (res.need_overwrite) return "overwrite";
      await alertBox("提示", res.error || "操作失败");
      return false;
    }
    apply(res);
    if (res?.warning) await alertBox("流程已保存（暂不可执行）", res.warning);
    else if (res?.message) await alertBox("保存", res.message);
    if (res?.focus_warning) await alertBox("未能自动置前", res.focus_warning);
    return res;
  } catch (e) {
    await alertBox("错误", e.message || String(e));
    return false;
  }
}

async function applyCall(fn) {
  try {
    const res = await fn();
    if (res && res.ok === false) {
      await alertBox("提示", res.error || "操作失败");
      return false;
    }
    apply(res);
    return res;
  } catch (e) {
    await alertBox("错误", e.message || String(e));
    return false;
  }
}

async function setPricePatchClientRoot(value, done) {
  const result = await applyCall(() => call("price_patch_set_client_root", value));
  done?.(result);
}

async function choosePricePatchClientRoot(value, done) {
  const result = await applyCall(() => call("price_patch_choose_client_root", value));
  done?.(result);
}

// done 让设置页知道往返已结束，可以用后端真实值回写输入框
async function persistSettings(p, done) {
  if (await applyCall(() => call("update_settings", p))) await applyCall(() => call("save_settings"));
  done?.();
}

function craftKind() {
  if (tab.value === "garden") return "garden";
  if (tab.value === "normal") return "normal";
  return "";
}

// 主进程靠 uiPage 判断热键是否启动工艺，必须等它确认后再切页，否则两边会错位
async function setTab(next) {
  try {
    const res = await call("set_ui_page", next);
    apply(res);
    tab.value = res?.page || next;
  } catch (e) {
    await alertBox("切换页面失败", e.message || String(e));
  }
}

async function startFrom(kind) {
  const k = kind || craftKind() || "normal";
  try {
    const prep = await call("prepare_start", k);
    if (!prep.ok) {
      await alertBox("无法开始", prep.error);
      return;
    }
    if (!(await confirmBox("确认执行", prep.tips))) return;
  } catch (e) {
    await alertBox("无法开始", e.message || String(e));
    return;
  }
  await wrap(() => call("start", k));
}

async function poll() {
  try {
    pushRuntime(await call("get_runtime"));
  } catch {
    /* 宿主尚未就绪 */
  }
}

function onPaste(ev) {
  if (tab.value !== "templates") return;
  if (isTextField(ev.target)) return;
  ev.preventDefault();
  wrap(() => call("paste_template"));
}

onMounted(async () => {
  offBoot = onBootStatus((s) => finishSplash(s?.ok ? "" : s?.error || "初始化失败"));
  offMax = onWindowMaximized(applyMax);
  void isWindowMaximized().then(applyMax);
  splashTimer = window.setTimeout(() => {
    if (splash.value) finishSplash("初始化超时，识别功能可能不可用");
  }, 32000);
  await nextTick();
  setTimeout(() => splashReady(), 0);

  await ready();
  offPush = onPush(pushRuntime);
  await loadState();
  pollId = window.setInterval(poll, 2000);
  window.addEventListener("paste", onPaste);
});

onUnmounted(() => {
  offPush?.();
  offBoot?.();
  offMax?.();
  document.documentElement.classList.remove("is-max");
  window.clearInterval(pollId);
  window.clearTimeout(splashTimer);
  window.removeEventListener("paste", onPaste);
});

async function saveTemplate(key) {
  const first = await wrap(() => call("save_template", key, false));
  if (first === "overwrite") {
    const yes = await confirmBox("覆盖确认", "已存在同名模板，是否覆盖？");
    if (yes) await wrap(() => call("save_template", key, true));
  }
}

async function deleteWorkflow() {
  if (!(await confirmBox("删除流程", `确认删除「${state.value.workflow.name}」？`))) return;
  await wrap(() => call("delete"));
}

async function removeStep(id) {
  const step = state.value.workflow.steps.find((s) => s.id === id);
  if (!step) return;
  if (!(await confirmBox("删除步骤", `确认删除「${step.name}」？`))) return;
  await wrap(() => call("remove_step", id));
}
</script>

<template>
  <div class="shell">
    <header class="top">
      <div class="brand">POE Tools</div>
      <nav v-if="state && !splash">
        <button type="button" :class="{ on: tab === 'help' }" @click="setTab('help')">使用说明</button>
        <button type="button" :class="{ on: tab === 'garden' }" @click="setTab('garden')">花园工艺</button>
        <button type="button" :class="{ on: tab === 'normal' }" @click="setTab('normal')">普通工艺</button>
        <button type="button" class="sub" :class="{ on: tab === 'templates' }" @click="setTab('templates')">模板</button>
        <button type="button" class="sub" :class="{ on: tab === 'price_patch' }" @click="setTab('price_patch')">标价补丁</button>
        <button type="button" class="sub" :class="{ on: tab === 'client_enhancements' }" @click="setTab('client_enhancements')">游戏增强</button>
        <button type="button" class="sub" :class="{ on: tab === 'settings' }" @click="setTab('settings')">设置</button>
      </nav>
      <div class="drag-fill" />
      <div v-if="state && !splash" class="ops">
        <button
          v-if="tab === 'garden' || tab === 'normal'"
          type="button"
          class="btn ok go"
          :disabled="running"
          @click="startFrom(craftKind())"
        >
          {{ tab === "garden" ? "开始花园" : "开始流程" }} {{ startKey }}
        </button>
        <button type="button" class="btn danger go" :disabled="!running" @click="wrap(() => call('stop'))">
          停止 {{ stopKey }}
        </button>
        <button
          v-if="tab === 'normal'"
          type="button"
          class="btn go"
          :disabled="running"
          @click="wrap(() => call('save_workflow'))"
        >
          保存流程
        </button>
      </div>
      <div class="win-btns">
        <button type="button" class="win-btn" title="最小化" @click="minimizeWindow">
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect y="5.4" width="12" height="1.2" fill="currentColor" /></svg>
        </button>
        <button type="button" class="win-btn" :title="isMax ? '还原' : '最大化'" @click="toggleMaximizeWindow">
          <svg v-if="!isMax" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <svg v-else viewBox="0 0 12 12" aria-hidden="true">
            <rect x="3.2" y="1.6" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.15" />
            <rect x="1.6" y="3.4" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.15" />
          </svg>
        </button>
        <button type="button" class="win-btn close" title="关闭" @click="closeWindow">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.2 2.2l7.6 7.6M9.8 2.2l-7.6 7.6" />
          </svg>
        </button>
      </div>
    </header>
    <div v-if="splash" class="splash">
      <div>
        <b>初始化中…</b>
        <p>正在读取配置、加载识别库</p>
      </div>
    </div>
    <template v-else-if="state">
    <p v-if="bootError" class="init-err">{{ bootError }}</p>

    <main>
      <HelpPage v-show="tab === 'help'" :start-key="startKey" :stop-key="stopKey" />
      <CraftPage
        v-show="tab === 'garden'"
        :state="state"
        :runtime="runtime"
        :disabled="running"
        @rules="(rs) => wrap(() => call('update_rules', rs, null))"
        @save-rules="wrap(() => call('save_rules'))"
        @refresh-item="wrap(() => call('refresh_item'))"
        @parse-clip="wrap(() => call('parse_clipboard'))"
        @start="startFrom('garden')"
        @stop="wrap(() => call('stop'))"
        @prompt="onPrompt"
      />
      <WorkflowPage
        v-show="tab === 'normal'"
        :state="state"
        :runtime="runtime"
        :disabled="running"
        @select="(id) => wrap(() => call('select_workflow', id))"
        @new="(g) => wrap(() => call('new', g))"
        @dup="wrap(() => call('duplicate'))"
        @del="deleteWorkflow"
        @fields="(f) => wrap(() => call('update_workflow_fields', f))"
        @step="(id, f) => wrap(() => call('update_step', id, f))"
        @add-step="wrap(() => call('add_step'))"
        @remove-step="removeStep"
        @move-step="(id, d) => wrap(() => call('move_step', id, d))"
        @rules="(rs, id, timing) => wrap(() => call('update_rules', rs, id, timing))"
        @prompt="onPrompt"
      />
      <TemplatesPage
        v-show="tab === 'templates'"
        :state="state"
        :runtime="runtime"
        :preview="pendingPreview"
        :disabled="running"
        @paste="wrap(() => call('paste_template'))"
        @save="saveTemplate"
        @open="wrap(() => call('open_templates_dir'))"
        @test="wrap(() => call('test_templates'))"
        @refresh="wrap(() => call('refresh_templates'))"
      />
      <PricePatchPage
        v-show="tab === 'price_patch'"
        :state="state"
        :runtime="runtime"
        @apply="applyCall(() => call('price_patch_apply'))"
        @restore="applyCall(() => call('price_patch_restore'))"
        @auto="(enabled) => applyCall(() => call('price_patch_set_auto', enabled))"
        @mode="(value) => applyCall(() => call('price_patch_set_mode', value))"
        @client-root="setPricePatchClientRoot"
        @choose-client-root="choosePricePatchClientRoot"
      />
      <ClientEnhancementsPage
        v-show="tab === 'client_enhancements'"
        :state="state"
        :runtime="runtime"
        @update="(values) => applyCall(() => call('client_enhancements_update', values))"
        @apply="applyCall(() => call('client_enhancements_apply'))"
        @restore="applyCall(() => call('client_enhancements_restore'))"
        @retry="applyCall(() => call('client_enhancements_retry'))"
      />
      <SettingsPage
        v-show="tab === 'settings'"
        :state="state"
        :disabled="running"
        @settings="(p) => applyCall(() => call('update_settings', p))"
        @persist="persistSettings"
        @save-settings="() => applyCall(() => call('save_settings'))"
        @open-data-dir="wrap(() => call('open_data_dir'))"
      />
    </main>
    </template>
    <div v-else class="boot">正在连接工艺引擎…</div>
  </div>

  <Modal
    v-if="dlg"
    :title="dlg.title"
    :message="dlg.message"
    :input="dlg.input"
    :hide-cancel="dlg.hideCancel"
    @update:input="dlg.input = $event"
    @ok="closeDlg(true)"
    @cancel="closeDlg(false)"
  />
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(1200px 400px at 10% -10%, rgba(31, 106, 165, 0.12), transparent 50%),
    var(--page);
}
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 0 0 14px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
  -webkit-app-region: drag;
  user-select: none;
}
.brand {
  font-weight: 700;
  letter-spacing: 0.04em;
  font-size: 15px;
  flex: 0 0 auto;
}
.drag-fill { flex: 1; min-width: 12px; align-self: stretch; }
nav,
.ops,
.win-btns { -webkit-app-region: no-drag; }
nav { display: flex; gap: 4px; align-items: baseline; }
nav button {
  background: transparent;
  border: 0;
  color: var(--muted);
  padding: 8px 12px 10px;
  border-bottom: 2px solid transparent;
}
nav button.sub {
  padding: 8px 10px 10px;
  font-size: 12px;
}
nav button.on {
  color: var(--text);
  border-bottom-color: var(--accent-border);
}
.ops { display: flex; gap: 8px; }
.go { height: 32px; padding: 0 14px; font-weight: 700; }
.win-btns { display: flex; align-self: stretch; }
.win-btn {
  width: 42px;
  border: 0;
  background: transparent;
  color: var(--text);
  display: grid;
  place-items: center;
  padding: 0;
}
.win-btn svg { width: 12px; height: 12px; }
.win-btn.close svg { fill: none; stroke: currentColor; stroke-width: 1.2; }
.win-btn:hover { background: rgba(255, 255, 255, 0.08); }
.win-btn.close:hover { background: #e81123; color: #fff; }
main { flex: 1; min-height: 0; padding: 10px; overflow: hidden; }
main > * { height: 100%; min-height: 0; overflow: hidden; }
@media (max-height: 800px) {
  main { padding: 6px 10px; }
}
.boot,
.splash {
  flex: 1;
  display: grid;
  place-items: center;
}
.boot { color: var(--muted); }
.splash b {
  display: block;
  font-size: 18px;
  letter-spacing: 0.06em;
}
.splash p {
  margin: 10px 0 0;
  color: var(--muted);
}
.init-err {
  margin: 0;
  padding: 6px 14px;
  background: #3a1c1c;
  color: #e8b4b4;
  font-size: 12px;
}
</style>
