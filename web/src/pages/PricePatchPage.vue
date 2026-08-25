<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
  state: { type: Object, required: true },
  runtime: { type: Object, required: true },
});
const emit = defineEmits(["apply", "restore", "reset-baseline", "auto", "client-root", "choose-client-root"]);

const patch = computed(() => props.runtime.price_patch || props.state.price_patch || {});
const applied = computed(() => Boolean(patch.value.applied));
const busy = computed(() => Boolean(patch.value.busy));
const clientRootLocked = computed(() => Boolean(patch.value.client_root_locked));
const clientRootDraft = ref("");
const clientRootDirty = ref(false);

watch(
  () => patch.value.client_root,
  (value) => {
    if (!clientRootDirty.value) clientRootDraft.value = String(value || "");
  },
  { immediate: true },
);

function completeClientRoot(result) {
  if (!result || result.ok === false || result.canceled) return;
  clientRootDirty.value = false;
  clientRootDraft.value = String(result.price_patch?.client_root || "");
}

function saveClientRoot() {
  if (clientRootLocked.value || !clientRootDirty.value) return;
  emit("client-root", clientRootDraft.value, completeClientRoot);
}

function chooseClientRoot() {
  if (clientRootLocked.value) return;
  emit("choose-client-root", clientRootDraft.value, completeClientRoot);
}

function resetBaseline() {
  if (
    !window.confirm(
      "重置基线备份：将以当前客户端的标价资源作为新的还原基准。\n\n旧基线不会被删除，但仍建议先确认无误再重置。确定继续？",
    )
  ) {
    return;
  }
  emit("reset-baseline");
}

function displayTime(value) {
  if (!value) return "尚未更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
</script>

<template>
  <div class="price-page">
    <section class="card panel">
      <div class="heading">
        <div>
          <div class="h">国服客户端标价补丁</div>
          <p class="tiny">在游戏物品名称后显示行情价格，价格仅供参考。</p>
        </div>
        <span class="badge" :class="{ on: applied }">{{ applied ? "已应用" : "未应用" }}</span>
      </div>

      <div class="price-help">
        <div>
          <span>数据来源</span>
          <p>优先使用易刷国服行情；缺价时依次使用国服备用源、poe.ninja 国际服行情。</p>
        </div>
        <div>
          <span>符号说明</span>
          <p><b>·</b> 表示国服价格（易刷或国服备用源）；<b>⁙</b> 表示非国服价格（poe.ninja 兜底）。</p>
        </div>
        <div>
          <span>显示规则</span>
          <p>超过 1 枚神圣石的 c 价会按同一来源汇率换算为 d；同名变体显示样本量最高的代表价。</p>
        </div>
      </div>

      <div class="status-block">
        <span>状态</span>
        <b>{{ patch.status || "尚未应用" }}</b>
      </div>
      <div class="status-block">
        <span>最后更新时间</span>
        <b>{{ displayTime(patch.last_updated_at) }}</b>
      </div>

      <div class="client-path-block">
        <label for="price-client-root">客户端目录</label>
        <div class="client-path-row">
          <input
            id="price-client-root"
            v-model="clientRootDraft"
            class="ctrl"
            type="text"
            spellcheck="false"
            :readonly="clientRootLocked"
            placeholder="留空则自动检测国服客户端"
            @input="clientRootDirty = true"
            @keydown.enter.prevent="saveClientRoot"
          />
          <button
            type="button"
            class="btn"
            :disabled="clientRootLocked"
            @click="chooseClientRoot"
          >
            选择目录
          </button>
          <button
            type="button"
            class="btn ok"
            :disabled="clientRootLocked || !clientRootDirty"
            @click="saveClientRoot"
          >
            保存
          </button>
        </div>
        <small v-if="clientRootLocked">已应用或有等待操作时路径锁定；请先恢复原版再修改。</small>
        <small v-else>可直接粘贴或选择目录；留空保存后会在应用时自动查找。</small>
      </div>

      <button
        v-if="!applied"
        type="button"
        class="btn ok primary"
        :disabled="busy"
        @click="$emit('apply')"
      >
        {{ busy ? "正在处理…" : "应用标价补丁" }}
      </button>
      <div v-else class="actions">
        <button
          type="button"
          class="btn ok primary"
          :disabled="busy"
          @click="$emit('apply')"
        >
          {{ busy ? "正在处理…" : "立即更新价格" }}
        </button>
        <button
          type="button"
          class="btn danger primary"
          :disabled="busy"
          @click="$emit('restore')"
        >
          {{ busy ? "正在处理…" : "取消补丁 / 恢复原版" }}
        </button>
      </div>

      <div class="reset-row">
        <button
          type="button"
          class="btn ghost"
          :disabled="busy"
          @click="resetBaseline"
        >
          重置基线备份
        </button>
        <small>以当前客户端状态作为新的还原基准（初始备份有问题时使用；旧备份保留）。</small>
      </div>

      <label class="auto-row">
        <span>
          <b>闲置时自动更新</b>
          <small>约每小时检查一次；游戏运行中会等退出后再更新。</small>
        </span>
        <input
          type="checkbox"
          :checked="patch.auto_update !== false"
          @change="$emit('auto', $event.target.checked)"
        />
      </label>
    </section>
  </div>
</template>

<style scoped>
.price-page {
  height: 100%;
  display: grid;
  place-items: start center;
  overflow: auto;
  padding-top: min(8vh, 64px);
}
.panel {
  width: min(700px, 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
}
.heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.heading p { margin: 5px 0 0; }
.price-help {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  color: var(--muted);
  background: var(--row);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.price-help > div {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 10px;
  align-items: baseline;
}
.price-help span { color: var(--text); font-weight: 600; }
.price-help p { margin: 0; line-height: 1.55; }
.price-help b { color: var(--accent); font-size: 16px; }
.badge {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  color: var(--muted);
  background: var(--raised);
}
.badge.on { color: #b7e4c7; border-color: #3d8b68; background: #203d31; }
.status-block {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 12px;
  align-items: baseline;
  padding: 10px 12px;
  background: var(--row);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.status-block span { color: var(--muted); }
.status-block b { font-weight: 600; }
.client-path-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  background: var(--row);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.client-path-block > label { color: var(--muted); }
.client-path-block > small { color: var(--muted); }
.client-path-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}
.client-path-row .btn { white-space: nowrap; }
.client-path-row .ctrl[readonly] { opacity: 0.6; cursor: default; }
.primary { width: 100%; height: 40px; font-size: 14px; font-weight: 700; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.reset-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.reset-row small { color: var(--muted); }
.auto-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 4px;
  user-select: none;
}
.auto-row span { display: flex; flex-direction: column; gap: 2px; }
.auto-row small { color: var(--muted); }
.auto-row input { width: 18px; height: 18px; accent-color: var(--accent); }
@media (max-width: 680px) {
  .client-path-row { grid-template-columns: 1fr 1fr; }
  .client-path-row .ctrl { grid-column: 1 / -1; }
}
</style>
