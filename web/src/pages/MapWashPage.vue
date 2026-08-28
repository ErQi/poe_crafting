<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { call } from "../api.js";

const props = defineProps({
  state: { type: Object, default: null },
  runtime: { type: Object, default: () => ({ mapwash: {} }) },
  disabled: { type: Boolean, default: false },
});

const DEFAULT_FILTER = [
  "// 必须要有的词缀，例如",
  "物品数量 > 100",
  "!格挡",
  "!再生",
  "",
  "## 满足上面条件下可选词缀",
  "塑界者",
  "",
  "### 可选词缀满足一条即视为成功",
  "贤主",
].join("\n");

const cfg = reactive({
  mode: "alch",
  startSlot: 1,
  endSlot: 60,
  exaltFill: false,
  doVaal: false,
  filter: DEFAULT_FILTER,
  grid: { startX: 0, startY: 0, endX: 0, endY: 0 },
});

const readText = ref("");
const readResult = ref("");
const readSlotIndex = ref(1);
const message = ref("");
let saved = true;
// 初始配置加载完成后才允许自动保存，避免把加载动作当成用户改动回写覆盖
const loaded = ref(false);
let saveTimer = 0;

const mw = computed(() => props.runtime?.mapwash || {});
const running = computed(() => Boolean(mw.value.running));
const calibrating = computed(() => mw.value.calibrating || "");
// 格位变化来自主进程校准，走 poe-push 实时回填，因此读 live（runtime.mapwash.config.grid），
// 不回退到本地 cfg.grid，保证校准后即时显示。
const liveGrid = computed(() => mw.value.config?.grid || cfg.grid);
const gridDone = computed(() => {
  const g = liveGrid.value;
  return Boolean((g.startX || g.startY) && (g.endX || g.endY));
});
const statusText = computed(() => {
  if (mw.value.running) return `运行中 · ${mw.value.phase || "wash"} · ${mw.value.message || "处理中"}`;
  if (mw.value.message) return `空闲 · ${mw.value.message}`;
  return "状态: 空闲";
});

function flash(msg) {
  message.value = msg;
  window.setTimeout(() => {
    if (message.value === msg) message.value = "";
  }, 5000);
}

async function callWrap(fn) {
  try {
    const res = await fn();
    if (res && res.ok === false) {
      flash(res.error || "操作失败");
      return null;
    }
    return res;
  } catch (e) {
    flash((e && e.message) || String(e));
    return null;
  }
}

async function loadConfig() {
  const res = await callWrap(() => call("mapwash_get_state"));
  if (res?.config) {
    const next = res.config;
    // 预设词条文本；只有已保存的非空词条才覆盖默认示例
    const savedFilter = typeof next.filter === "string" && next.filter.trim() ? next.filter : DEFAULT_FILTER;
    Object.assign(cfg, next, { filter: savedFilter });
    saved = true;
  }
  // 等初始 watch 的这一轮 flush 结束后再放开自动保存
  await nextTick();
  loaded.value = true;
}

async function saveConfig(silent = false) {
  const res = await callWrap(() => call("mapwash_update", {
    mode: cfg.mode,
    start_slot: Number(cfg.startSlot),
    end_slot: Number(cfg.endSlot),
    exalt_fill: cfg.exaltFill,
    do_vaal: cfg.doVaal,
    filter: cfg.filter,
    // 格位以主进程实时校准值(liveGrid)为准；页面缓存 cfg.grid 可能是旧的，
    // 直接用缓存会把它覆盖回 0 导致「未校准」。
    grid: { ...liveGrid.value },
  }));
  if (res?.config) Object.assign(cfg, res.config);
  saved = true;
  if (!silent) flash("配置已保存");
}

// 输入改动自动保存到本地配置（config/mapwasher.json），防抖 600ms
watch(
  () => [cfg.mode, cfg.startSlot, cfg.endSlot, cfg.exaltFill, cfg.doVaal, cfg.filter],
  () => {
    if (!loaded.value) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveConfig(true);
    }, 600);
  },
);

async function beginCalibrate(kind) {
  const res = await callWrap(() => call("mapwash_begin_calibrate", kind));
  if (res) flash(`已进入校准模式：把鼠标移到游戏中背包的${kind === "start" ? "第 1 排第 1 格（起始格）" : "第 5 排第 12 格（结束格）"}，按 F6 完成。`);
}

async function cancelCalibrate() {
  await callWrap(() => call("mapwash_cancel_calibrate"));
}

async function refreshGrid() {
  await loadConfig();
}

async function readSlot() {
  const res = await callWrap(() => call("mapwash_read_slot", Number(readSlotIndex.value)));
  if (!res) return;
  readText.value = res.text || "(空)";
  readResult.value = `格${res.slot}：稀有度=${res.rarity || "-"} ｜ ${res.match ? "命中 ✓" : "未命中 ✗"}（${res.why || ""}）`;
  flash("试读完成，见下方文本与结果");
}

async function testFilter() {
  if (!readText.value || readText.value === "(空)") {
    flash("请先「试读」或手动粘贴地图文本再测试");
    return;
  }
  const res = await callWrap(() => call("mapwash_test_filter", readText.value));
  if (res) readResult.value = `过滤判断：${res.match ? "命中 ✓" : "未命中 ✗"}（${res.why || ""}）`;
}

async function start() {
  await saveConfig(true);
  const res = await callWrap(() => call("mapwash_start"));
  if (res && res.ok !== false) flash("洗地图已启动");
}

async function stop() {
  await callWrap(() => call("mapwash_stop"));
}

onMounted(loadConfig);
</script>

<template>
  <div class="mw">
    <!-- 左上：洗图设置 + 词条过滤 -->
    <section class="card left">
      <div class="h">洗图设置</div>
      <div class="setting">
        <span class="lab">洗法</span>
        <div class="seg">
          <button type="button" class="chip" :class="{ on: cfg.mode === 'alch' }" :disabled="disabled" @click="cfg.mode = 'alch'">点金洗</button>
          <button type="button" class="chip" :class="{ on: cfg.mode === 'chaos' }" :disabled="disabled" @click="cfg.mode = 'chaos'">混沌洗</button>
        </div>
        <span class="lab">格位</span>
        <input v-model.number="cfg.startSlot" type="number" class="ctrl num" min="1" max="60" :disabled="disabled" />
        <span class="tide">～</span>
        <input v-model.number="cfg.endSlot" type="number" class="ctrl num" min="1" max="60" :disabled="disabled" />
        <label class="check"><input v-model="cfg.exaltFill" type="checkbox" :disabled="disabled" /> 崇高E满</label>
        <label class="check"><input v-model="cfg.doVaal" type="checkbox" :disabled="disabled" /> 上瓦尔</label>
      </div>

      <div class="h">词条过滤
        <span class="tiny">//注释 · 默认区全满足 · ##/###区任一满足 · !不想要</span>
      </div>
      <textarea
        v-model="cfg.filter"
        class="area filter-area"
        spellcheck="false"
        :disabled="disabled"
      />
    </section>

    <!-- 右上：状态 + 校准 -->
    <section class="card right">
      <div class="raised run">
        <div class="h status">{{ statusText }}</div>
        <div class="row">
          <button type="button" class="btn ok" :disabled="running" @click="start">开始洗图</button>
          <button type="button" class="btn danger" :disabled="!running" @click="stop">停止</button>
        </div>
        <div class="stats">
          <span class="st"><b class="good">{{ mw.stats?.success || 0 }}</b> 成功</span>
          <span class="st"><b>{{ mw.stats?.empty || 0 }}</b> 空</span>
          <span class="st"><b>{{ mw.stats?.fail || 0 }}</b> 失败</span>
          <span class="st"><b>{{ mw.stats?.stop || 0 }}</b> 停止</span>
          <span v-if="mw.currentSlot" class="st cur">当前格 <b>{{ mw.currentSlot }}</b></span>
        </div>
      </div>

      <div class="cal block">
        <div class="h">背包格位校准</div>
        <div class="calrow">
          <span class="cal">
            <em>起始格</em>
            <code>{{ liveGrid.startX ? liveGrid.startX.toFixed(3) : "--" }}, {{ liveGrid.startY ? liveGrid.startY.toFixed(3) : "--" }}</code>
          </span>
          <span class="cal">
            <em>结束格</em>
            <code>{{ liveGrid.endX ? liveGrid.endX.toFixed(3) : "--" }}, {{ liveGrid.endY ? liveGrid.endY.toFixed(3) : "--" }}</code>
          </span>
          <span class="badge" :class="gridDone ? 'ok' : 'warn'">{{ gridDone ? "已校准" : "未校准" }}</span>
        </div>
        <div class="row">
          <button type="button" class="btn" :disabled="disabled || calibrating === 'start'" @click="beginCalibrate('start')">校准起始格</button>
          <button type="button" class="btn" :disabled="disabled || calibrating === 'end'" @click="beginCalibrate('end')">校准结束格</button>
          <button v-if="calibrating" type="button" class="btn danger" @click="cancelCalibrate">取消</button>
          <button type="button" class="btn ghost" :disabled="disabled" @click="refreshGrid">刷新</button>
          <button type="button" class="btn ghost" :disabled="disabled" @click="saveConfig">保存</button>
        </div>
        <p v-if="calibrating" class="tiny warn">鼠标移到背包{{ calibrating === "start" ? "起始格" : "结束格" }}后按 F6 完成</p>
      </div>
    </section>

    <!-- 左下：过滤测试 -->
    <section class="card bottom-left">
      <div class="h">过滤测试</div>
      <div class="row">
        <span class="lab">格子号</span>
        <input v-model.number="readSlotIndex" type="number" class="ctrl num" min="1" max="60" :disabled="disabled || running" />
        <button type="button" class="btn" :disabled="disabled || running" @click="readSlot">试读当前格</button>
        <button type="button" class="btn" @click="testFilter">测试过滤</button>
      </div>
      <div v-if="readResult" class="read-result">{{ readResult }}</div>
      <textarea
        v-model="readText"
        class="area read-area"
        spellcheck="false"
        placeholder="试读到的地图文本，或粘贴游戏内 Ctrl+C 的文本后点「测试过滤」"
      />
    </section>

    <!-- 右下：运行日志 -->
    <section class="card bottom-right">
      <div class="h">运行日志</div>
      <pre class="box log scroll">
        <template v-if="(mw.logs || []).length">{{ (mw.logs || []).join("\n") }}</template>
        <template v-else>（尚无日志）</template>
      </pre>
    </section>

    <div v-if="message" class="toast">{{ message }}</div>
  </div>
</template>

<style scoped>
.mw {
  height: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
}
.left,
.right,
.bottom-left,
.bottom-right {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  min-height: 0;
}
.h {
  font-weight: 700;
  font-size: 14px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.h .tiny { font-weight: 400; color: var(--muted); font-size: 12px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.lab { color: var(--muted); font-size: 12px; }
.tide { color: var(--muted); }

/* 洗图设置 */
.setting { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.seg .chip { border: 0; border-radius: 0; height: var(--ctrl-h); }
.ctrl { height: var(--ctrl-h); background: var(--input); border: 1px solid var(--border); border-radius: 4px; color: var(--text); padding: 0 8px; }
.ctrl:focus { outline: none; border-color: var(--border-lit); }
.ctrl.num { width: 56px; }
.check { display: inline-flex; align-items: center; gap: 6px; color: var(--text); user-select: none; }
.check input { accent-color: var(--accent); }

/* 校准 */
.cal { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.cal p { margin: 0; }
.calrow { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.cal em { color: var(--muted); font-size: 12px; font-style: normal; }
.cal code { font-family: Consolas, "Microsoft YaHei", monospace; font-size: 12px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); }
.badge.warn { color: #f4a261; border-color: rgba(244,162,97,0.4); }
.badge.ok { color: #6a994e; border-color: rgba(106,153,78,0.45); }
.warn { color: #f4a261; }

/* 输入区不可调大小 */
.area {
  display: block;
  width: 100%;
  resize: none;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  padding: 8px;
  font-family: Consolas, "Microsoft YaHei", monospace;
  font-size: 12px;
  line-height: 1.5;
}
.area:focus { outline: none; border-color: var(--border-lit); }
.filter-area { flex: 1 1 auto; min-height: 0; }
.read-area { flex: 1 1 auto; min-height: 0; }

/* 运行状态 */
.run { flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.status { font-size: 14px; }
.stats { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
.st b { color: var(--text); }
.st .good { color: #6a994e; }
.st.cur b { color: var(--accent-border); }
.read-result { color: var(--accent-border); font-size: 12px; }

/* 日志 */
.box {
  margin: 0;
  padding: 8px;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-height: 0;
}
.log { flex: 1 1 auto; }
.scroll { overflow: auto; }

.toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  background: var(--raised);
  border: 1px solid var(--border-lit);
  padding: 8px 16px;
  border-radius: 8px;
  z-index: 60;
  max-width: 80%;
  box-shadow: 0 6px 24px rgba(0,0,0,0.4);
}
</style>