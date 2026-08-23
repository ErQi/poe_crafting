<script setup>
import { computed } from "vue";

const props = defineProps({
  state: { type: Object, required: true },
  runtime: { type: Object, required: true },
});
const emit = defineEmits(["update", "apply", "restore", "retry"]);

const enhancement = computed(() => props.runtime.client_enhancements || props.state.client_enhancements || {});
const busy = computed(() => Boolean(enhancement.value.busy));
const pending = computed(() => Boolean(enhancement.value.pending));
const hasChanges = computed(() => Boolean(enhancement.value.has_changes));
const enabled = computed(() => Boolean(
  enhancement.value.view_distance_enabled
  || enhancement.value.minimap_enabled
  || enhancement.value.environment_defog_enabled,
));
const applyButtonText = computed(() => {
  if (pending.value) return "等待游戏退出";
  if (hasChanges.value) return "应用更改";
  return enhancement.value.applied ? "重新应用" : "应用";
});

const multipliers = [1.5, 2, 2.5, 3, 3.5, 4, 5];
const colors = [
  { value: "default", label: "默认", css: "default" },
  { value: "purple", label: "紫色", css: "purple" },
  { value: "orange", label: "橙色", css: "orange" },
  { value: "blue", label: "蓝色", css: "blue" },
];

function update(values) {
  if (!busy.value) emit("update", values);
}

function displayTime(value) {
  if (!value) return "尚未应用";
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
  <div class="enhancement-page">
    <div class="content">
      <section class="summary card">
        <div>
          <div class="h">国服客户端增强</div>
          <p class="tiny">调整开关和选项只保存设置；点击“应用”后才修改客户端，游戏运行中则等待退出。</p>
        </div>
        <span
          class="badge"
          :class="{ on: enabled && enhancement.applied && !hasChanges && !pending, wait: pending || hasChanges }"
        >
          {{ pending ? "等待应用" : hasChanges ? "待应用" : enabled && enhancement.applied ? "已应用" : "未启用" }}
        </span>
      </section>

      <section class="feature card" :class="{ active: enhancement.view_distance_enabled }">
        <div class="feature-head">
          <label class="switch-row">
            <input
              type="checkbox"
              :checked="Boolean(enhancement.view_distance_enabled)"
              :disabled="busy"
              @change="update({ view_distance_enabled: $event.target.checked })"
            />
            <span class="switch"><i /></span>
            <span class="icon">🔧</span>
            <b>视距调整</b>
          </label>
        </div>
        <div class="choices" :class="{ disabled: !enhancement.view_distance_enabled || busy }">
          <label v-for="value in multipliers" :key="value" class="choice">
            <input
              type="radio"
              name="view-distance"
              :value="value"
              :checked="Number(enhancement.view_distance_multiplier || 2) === value"
              :disabled="busy"
              @change="update({ view_distance_multiplier: value })"
            />
            <span>{{ value }}x</span>
          </label>
        </div>
      </section>

      <section class="feature card" :class="{ active: enhancement.minimap_enabled }">
        <div class="feature-head">
          <label class="switch-row">
            <input
              type="checkbox"
              :checked="Boolean(enhancement.minimap_enabled)"
              :disabled="busy"
              @change="update({ minimap_enabled: $event.target.checked })"
            />
            <span class="switch"><i /></span>
            <span class="icon">🔧</span>
            <b>小地图全开</b>
          </label>
        </div>
        <div class="choices colors" :class="{ disabled: !enhancement.minimap_enabled || busy }">
          <label v-for="color in colors" :key="color.value" class="choice">
            <input
              type="radio"
              name="minimap-color"
              :value="color.value"
              :checked="(enhancement.minimap_color || 'default') === color.value"
              :disabled="busy"
              @change="update({ minimap_color: color.value })"
            />
            <i class="swatch" :class="color.css" />
            <span>{{ color.label }}</span>
          </label>
        </div>
      </section>

      <section class="feature card" :class="{ active: enhancement.environment_defog_enabled }">
        <div class="feature-head">
          <label class="switch-row">
            <input
              type="checkbox"
              :checked="Boolean(enhancement.environment_defog_enabled)"
              :disabled="busy"
              @change="update({ environment_defog_enabled: $event.target.checked })"
            />
            <span class="switch"><i /></span>
            <span class="icon">🔧</span>
            <b>环境去雾</b>
          </label>
        </div>
        <div class="feature-note" :class="{ disabled: !enhancement.environment_defog_enabled || busy }">
          移除场景中的距离雾与高度雾，不影响小地图的探索迷雾。
        </div>
      </section>

      <section class="status card">
        <div class="status-grid">
          <span>状态</span>
          <b>{{ enhancement.status || "尚未应用客户端增强" }}</b>
          <span>客户端</span>
          <b class="path">{{ enhancement.client_root || "跟随标价补丁路径或自动检测" }}</b>
          <span>最后处理</span>
          <b>{{ displayTime(enhancement.last_applied_at) }}</b>
        </div>
        <div class="actions">
          <button
            type="button"
            class="btn ok"
            :disabled="busy || pending"
            @click="$emit('apply')"
          >
            {{ applyButtonText }}
          </button>
          <button
            v-if="enhancement.phase === 'error'"
            type="button"
            class="btn ok"
            :disabled="busy"
            @click="$emit('retry')"
          >
            重试
          </button>
          <button
            type="button"
            class="btn danger"
            :disabled="busy || !enhancement.has_backup"
            @click="$emit('restore')"
          >
            恢复首次修改前资源
          </button>
        </div>
        <p class="warning">客户端资源修改可能违反游戏规则，存在账号风险，请自行判断使用。</p>
        <p class="tiny">首次应用会备份当时的四个目标资源；若易刷已应用同类补丁，建议先在易刷还原，再由 POE Tools 接管。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.enhancement-page {
  height: 100%;
  overflow: auto;
}
.content {
  width: min(820px, 100%);
  margin: 0 auto;
  padding: 8px 0 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.summary {
  min-height: 60px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.summary p { margin: 3px 0 0; }
.badge {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  color: var(--muted);
  background: var(--raised);
}
.badge.on { color: #b7e4c7; border-color: #3d8b68; background: #203d31; }
.badge.wait { color: #f2d79b; border-color: #8a7135; background: #3a321f; }
.feature {
  min-height: 62px;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  overflow: hidden;
  border-left-width: 4px;
}
.feature.active {
  border-color: #3d8b68;
  border-left-color: #3fd98b;
}
.feature-head {
  min-height: 60px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.025);
}
.switch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  user-select: none;
  cursor: pointer;
}
.switch-row > input { position: absolute; opacity: 0; pointer-events: none; }
.switch {
  width: 44px;
  height: 26px;
  padding: 3px;
  border-radius: 15px;
  background: #555d68;
  transition: 0.16s ease;
}
.switch i {
  display: block;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #f5f7fa;
  transition: 0.16s ease;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
.switch-row > input:checked + .switch { background: #3fd98b; }
.switch-row > input:checked + .switch i { transform: translateX(18px); }
.switch-row > input:disabled + .switch { opacity: 0.55; }
.switch-row b { font-size: 16px; }
.icon { font-size: 14px; filter: grayscale(1); opacity: 0.7; }
.choices {
  min-height: 60px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  border-left: 1px solid rgba(255, 255, 255, 0.055);
  background: rgba(0, 0, 0, 0.13);
  transition: opacity 0.15s ease;
}
.choices.disabled { opacity: 0.48; }
.feature-note {
  min-height: 60px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  border-left: 1px solid rgba(255, 255, 255, 0.055);
  color: var(--muted);
  background: rgba(0, 0, 0, 0.13);
  transition: opacity 0.15s ease;
}
.feature-note.disabled { opacity: 0.48; }
.choice {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  font-size: 14px;
}
.choice input { width: 16px; height: 16px; margin: 0; accent-color: #3fd98b; }
.swatch {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.4);
}
.swatch.default { background: linear-gradient(135deg, #e5c25f 0 50%, #3a9be8 50%); }
.swatch.purple { background: #9c4dcc; }
.swatch.orange { background: #f47c20; }
.swatch.blue { background: #258de5; }
.status {
  padding: 11px 14px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px 14px;
}
.status-grid {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 5px 10px;
  align-items: baseline;
}
.status-grid span { color: var(--muted); }
.status-grid b { font-weight: 600; }
.path { overflow-wrap: anywhere; }
.actions {
  display: flex;
  justify-content: flex-end;
  align-self: end;
  gap: 8px;
}
.warning {
  grid-column: 1 / -1;
  margin: 0;
  padding: 7px 9px;
  color: #f0c6a7;
  border: 1px solid #704b34;
  border-radius: 6px;
  background: #33241c;
}
.status > .tiny { grid-column: 1 / -1; margin: -2px 0 0; }
@media (max-width: 700px) {
  .content { padding-top: 4px; }
  .feature { grid-template-columns: 1fr; }
  .choices,
  .feature-note {
    min-height: 48px;
    padding: 9px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.035);
    border-left: 0;
  }
  .status { grid-template-columns: 1fr; }
  .actions { justify-content: flex-start; }
}
</style>
