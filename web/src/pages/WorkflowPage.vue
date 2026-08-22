<script setup>
import { computed, ref, watch } from "vue";
import UiSelect from "../components/UiSelect.vue";
import RuleEditor from "../components/RuleEditor.vue";

const props = defineProps({
  state: { type: Object, required: true },
  runtime: { type: Object, default: () => ({}) },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits([
  "select",
  "new",
  "dup",
  "del",
  "fields",
  "step",
  "add-step",
  "remove-step",
  "move-step",
  "rules",
  "prompt",
]);

const wf = computed(() => props.state.workflow);
const lib = computed(() => props.state.library);
const meta = computed(() => props.state.meta);
const stepId = ref(wf.value.steps[0]?.id || "");
const groupName = ref("");
const conditionTiming = ref("before");

watch(
  () => wf.value.id,
  () => {
    stepId.value = wf.value.steps[0]?.id || "";
    groupName.value = (wf.value.group || "自定义").trim() || "自定义";
  },
  { immediate: true },
);

watch(
  () => (wf.value.steps || []).map((s) => s.id).join("|"),
  (cur, prev) => {
    const ids = cur ? cur.split("|") : [];
    const old = new Set(prev ? prev.split("|") : []);
    const added = ids.filter((id) => id && !old.has(id));
    if (added.length) stepId.value = added[added.length - 1];
    else if (stepId.value && !ids.includes(stepId.value)) stepId.value = ids[0] || "";
  },
);

const groups = computed(() => {
  const names = [];
  for (const item of lib.value.workflows || []) {
    const g = (item.group || "自定义").trim() || "自定义";
    if (!names.includes(g)) names.push(g);
  }
  return names.length ? names : ["自定义"];
});

const chips = computed(() =>
  (lib.value.workflows || []).filter(
    (item) => ((item.group || "自定义").trim() || "自定义") === groupName.value,
  ),
);

const step = computed(() => wf.value.steps.find((s) => s.id === stepId.value) || wf.value.steps[0] || null);

const startOpts = computed(() => {
  const opts = wf.value.steps
    .map((s, i) => (s.enabled ? { value: s.id, label: `${i + 1}. ${s.name}` } : null))
    .filter(Boolean);
  return opts.length ? opts : [{ value: "", label: "(无启用步骤)" }];
});

const transOpts = computed(() => {
  const base = [
    { value: "next", label: "下一启用步骤" },
    { value: "repeat", label: "重复本步骤" },
    { value: "finish", label: "流程完成" },
    { value: "stop", label: "停止流程" },
  ];
  return base.concat(
    wf.value.steps.map((s, i) => ({ value: `goto:${s.id}`, label: `跳转到 ${i + 1}. ${s.name}` })),
  );
});

function clip(name) {
  return name.length <= 18 ? name : `${name.slice(0, 17)}…`;
}

function patchStep(fields) {
  if (!step.value) return;
  emit("step", step.value.id, fields);
}
</script>

<template>
  <div class="wf">
    <section class="card switcher">
      <span class="h">快速切换</span>
      <UiSelect
        :model-value="groupName"
        :options="groups"
        :disabled="disabled"
        class="grp"
        @change="groupName = $event"
      />
      <div class="hscroll">
        <button
          v-for="item in chips"
          :key="item.id"
          type="button"
          class="chip"
          :class="{ on: item.id === lib.active_id }"
          :disabled="disabled"
          @click="$emit('select', item.id)"
        >
          {{ item.name }}
        </button>
      </div>
      <button type="button" class="btn" :disabled="disabled" @click="$emit('new', groupName)">新建</button>
      <button type="button" class="btn" :disabled="disabled" @click="$emit('dup')">复制</button>
      <button type="button" class="btn danger" :disabled="disabled" @click="$emit('del')">删除</button>
    </section>

    <section class="card meta">
      <label class="field">
        <span>流程名</span>
        <input
          class="ctrl"
          :value="wf.name"
          :disabled="disabled"
          @change="$emit('fields', { name: $event.target.value })"
        />
      </label>
      <label class="field">
        <span>起始步骤</span>
        <UiSelect
          :model-value="wf.start_step_id"
          :options="startOpts"
          :disabled="disabled"
          @change="$emit('fields', { start_step_id: $event })"
        />
      </label>
      <label class="field grow">
        <span>说明</span>
        <input
          class="ctrl"
          :value="wf.description"
          :disabled="disabled"
          @change="$emit('fields', { description: $event.target.value })"
        />
      </label>
    </section>

    <div class="exec">
      <section class="card steps">
        <div class="h">执行步骤</div>
        <div class="list scroll">
          <button
            v-for="(s, i) in wf.steps"
            :key="s.id"
            type="button"
            class="step"
            :class="{ on: s.id === step?.id }"
            @click="stepId = s.id"
          >
            <i />
            <b>{{ i + 1 }}</b>
            <span>{{ clip(s.name) }}{{ s.enabled ? "" : "  停用" }}</span>
          </button>
          <p v-if="!wf.steps.length" class="tiny empty">还没有步骤<br />点击下方 + 添加</p>
        </div>
        <div class="step-ops">
          <button type="button" class="btn ok sq" :disabled="disabled" @click="$emit('add-step')">+</button>
          <button type="button" class="btn danger sq" :disabled="disabled" @click="step && $emit('remove-step', step.id)">−</button>
          <button type="button" class="btn sq" :disabled="disabled" @click="step && $emit('move-step', step.id, -1)">↑</button>
          <button type="button" class="btn sq" :disabled="disabled" @click="step && $emit('move-step', step.id, 1)">↓</button>
        </div>
      </section>

      <section v-if="step" class="card detail">
        <div class="fields">
          <label class="field step-name">
            <span>步骤名称</span>
            <input
              class="ctrl"
              :value="step.name"
              :disabled="disabled"
              @change="patchStep({ name: $event.target.value })"
            />
          </label>
          <label class="check en">
            <input
              type="checkbox"
              :checked="step.enabled"
              :disabled="disabled"
              @change="patchStep({ enabled: $event.target.checked })"
            />
            启用本步骤
          </label>
          <label class="field currency">
            <span>使用通货</span>
            <UiSelect
              :model-value="step.currency_template"
              :options="meta.currencies.map((c) => ({ value: c.template, label: c.label }))"
              :disabled="disabled"
              @change="patchStep({ currency_template: $event })"
            />
          </label>
          <label class="field success-route">
            <span>后置命中后</span>
            <UiSelect
              :model-value="step.on_success"
              :options="transOpts"
              :disabled="disabled"
              @change="patchStep({ on_success: $event })"
            />
          </label>
          <label class="field failure-route">
            <span>后置未命中后</span>
            <UiSelect
              :model-value="step.on_failure"
              :options="transOpts"
              :disabled="disabled"
              @change="patchStep({ on_failure: $event })"
            />
          </label>
        </div>
        <div class="rules raised">
          <div class="condition-bar">
            <div class="condition-tabs" role="tablist" aria-label="判断阶段">
              <button
                type="button"
                class="chip"
                :class="{ on: conditionTiming === 'before' }"
                :disabled="disabled"
                @click="conditionTiming = 'before'"
              >
                前置判断
              </button>
              <button
                type="button"
                class="chip"
                :class="{ on: conditionTiming === 'after' }"
                :disabled="disabled"
                @click="conditionTiming = 'after'"
              >
                后置判断
              </button>
            </div>
            <span class="tiny">稀有度</span>
            <UiSelect
              v-if="conditionTiming === 'before'"
              :model-value="step.before_rarity || ''"
              :options="meta.rarities"
              :disabled="disabled"
              class="condition-select"
              @change="patchStep({ before_rarity: $event })"
            />
            <UiSelect
              v-else
              :model-value="step.expected_rarity || ''"
              :options="meta.rarities"
              :disabled="disabled"
              class="condition-select"
              @change="patchStep({ expected_rarity: $event })"
            />
            <span class="tiny">显式词缀数</span>
            <UiSelect
              v-if="conditionTiming === 'before'"
              :model-value="step.before_affix_count ?? ''"
              :options="meta.affix_counts"
              :disabled="disabled"
              class="condition-select count"
              @change="patchStep({ before_affix_count: $event })"
            />
            <UiSelect
              v-else
              :model-value="step.expected_affix_count ?? ''"
              :options="meta.affix_counts"
              :disabled="disabled"
              class="condition-select count"
              @change="patchStep({ expected_affix_count: $event })"
            />
            <span class="tiny condition-help">
              {{ conditionTiming === "before"
                ? "全部命中才消耗通货；不命中则直接检查后置判断"
                : "使用通货后检查，并按命中 / 未命中去向继续" }}
            </span>
          </div>
          <RuleEditor
            v-if="conditionTiming === 'before'"
            :key="`${step.id}:before`"
            :model-value="step.before_ruleset"
            title="前置词缀条件"
            :ops="meta.ops"
            :disabled="disabled"
            compact
            @update:model-value="$emit('rules', $event, step.id, 'before')"
            @prompt="$emit('prompt', $event)"
          />
          <RuleEditor
            v-else
            :key="`${step.id}:after`"
            :model-value="step.ruleset"
            title="后置词缀条件"
            :ops="meta.ops"
            :disabled="disabled"
            compact
            @update:model-value="$emit('rules', $event, step.id, 'after')"
            @prompt="$emit('prompt', $event)"
          />
        </div>
      </section>
    </div>

    <section class="card logs">
      <div class="h status">{{ runtime.status_text || "状态: 空闲" }}</div>
      <pre class="log box scroll">{{ (runtime.logs || []).join("\n") }}</pre>
    </section>
  </div>
</template>

<style scoped>
.wf {
  --ctrl-h: 28px;
  --chip-h: 26px;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  overflow: hidden;
}
.switcher, .meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  flex: 0 0 auto;
}
.switcher .hscroll { flex: 1; }
.grp { width: 108px; flex: 0 0 108px; }
.meta { display: grid; grid-template-columns: minmax(140px, 2fr) minmax(180px, 2fr) minmax(140px, 3fr); }
.grow { min-width: 0; }
.exec {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 6px;
}
.steps, .detail {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 7px;
  gap: 6px;
}
.steps .h, .step-ops { flex-shrink: 0; }
.list { flex: 1; min-height: 0; }
.step {
  display: flex;
  align-items: center;
  width: 100%;
  height: 44px;
  margin-bottom: 6px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--raised);
  text-align: left;
  color: var(--text);
}
.step.on {
  background: var(--row-sel);
  border-color: var(--accent-border);
}
.step i {
  width: 4px;
  height: 24px;
  margin: 0 8px;
  border-radius: 2px;
  background: var(--border);
}
.step.on i { background: var(--accent); }
.step b { width: 22px; color: var(--muted); font-weight: 400; }
.step span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 10px; }
.empty { text-align: center; padding: 28px 8px; }
.step-ops { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.fields {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) minmax(130px, 1fr) minmax(120px, 0.8fr) minmax(140px, 1fr);
  grid-template-areas:
    "step-name step-name currency enabled"
    "success-route success-route failure-route failure-route";
  gap: 5px 8px;
}
.fields .field { gap: 2px; }
.step-name { grid-area: step-name; }
.currency { grid-area: currency; }
.success-route { grid-area: success-route; }
.failure-route { grid-area: failure-route; }
.en {
  grid-area: enabled;
  align-self: end;
  min-height: var(--ctrl-h);
  padding: 0;
}
.rules {
  flex: 1;
  min-height: 0;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.condition-bar {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.condition-tabs {
  display: flex;
  gap: 4px;
  padding-right: 4px;
  border-right: 1px solid var(--border);
}
.condition-tabs .chip { padding: 0 11px; }
.condition-select { width: 118px; flex: 0 0 118px; }
.condition-select.count { width: 92px; flex-basis: 92px; }
.condition-help {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.logs {
  flex: 0 0 58px;
  min-height: 58px;
  display: grid;
  grid-template-columns: 150px 1fr;
  align-items: stretch;
  gap: 8px;
  padding: 6px 8px;
}
.logs .box {
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: 4px 6px;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.status {
  align-self: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
@media (max-height: 800px) {
  .logs { flex-basis: 54px; min-height: 54px; }
}
@media (max-width: 1000px) {
  .exec { grid-template-columns: 200px 1fr; }
  .fields {
    grid-template-columns: 1fr 1fr;
    grid-template-areas:
      "step-name enabled"
      "currency currency"
      "success-route failure-route";
  }
  .condition-bar { flex-wrap: wrap; }
  .condition-help { flex-basis: 100%; }
}
</style>
