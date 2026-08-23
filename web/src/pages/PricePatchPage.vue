<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
  state: { type: Object, required: true },
  runtime: { type: Object, required: true },
});
const emit = defineEmits(["apply", "restore", "auto", "client-root", "choose-client-root"]);

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
          <p class="tiny">国服行情优先，缺价时使用 poe.ninja 全部 POE1 类别；等级或词缀变体显示挂单量最高的代表价。</p>
        </div>
        <span class="badge" :class="{ on: applied }">{{ applied ? "已应用" : "未应用" }}</span>
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
