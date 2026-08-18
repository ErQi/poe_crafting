<script setup>
defineProps({
  title: { type: String, default: "" },
  message: { type: String, default: "" },
  input: { type: [String, null], default: null },
  okText: { type: String, default: "确定" },
  cancelText: { type: String, default: "取消" },
  hideCancel: { type: Boolean, default: false },
});
const emit = defineEmits(["ok", "cancel", "update:input"]);
</script>

<template>
  <div class="mask" @mousedown.self="$emit('cancel')">
    <div class="box card">
      <div class="h">{{ title }}</div>
      <pre class="msg">{{ message }}</pre>
      <input
        v-if="input !== null"
        class="ctrl"
        :value="input"
        @input="$emit('update:input', $event.target.value)"
      />
      <div class="row">
        <button v-if="!hideCancel" type="button" class="btn ghost" @click="$emit('cancel')">
          {{ cancelText }}
        </button>
        <button type="button" class="btn ok" @click="$emit('ok')">{{ okText }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(6, 7, 10, 0.62);
  display: grid;
  place-items: center;
}
.box {
  width: min(520px, calc(100vw - 32px));
  padding: 16px 16px 14px;
}
.msg {
  white-space: pre-wrap;
  margin: 10px 0 12px;
  color: var(--text);
  font: inherit;
}
.row { display: flex; justify-content: flex-end; gap: 8px; }
</style>
