<script setup>
import { computed } from "vue";

const props = defineProps({
  state: { type: Object, required: true },
  runtime: { type: Object, required: true },
});
const emit = defineEmits(["apply", "restore", "auto"]);

const patch = computed(() => props.runtime.price_patch || props.state.price_patch || {});
const applied = computed(() => Boolean(patch.value.applied));
const busy = computed(() => Boolean(patch.value.busy));

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
          <p class="tiny">行情来自 poecurrency.top，应用前会自动建立并校验原始备份。</p>
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
  width: min(560px, 100%);
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
</style>
