<template>
  <UInput
    v-bind="$attrs"
    :model-value="display"
    :type="format === 'phone' ? 'tel' : 'text'"
    :inputmode="format === 'phone' ? 'tel' : undefined"
    @input.capture="onInput"
    @update:model-value="update"
    @blur="onBlur"
    @change="onBlur"
  />
</template>

<script setup lang="ts">
import {
  capitalizeFirst,
  formatPhone,
  phoneEdit,
  phoneValue,
} from "~/utils/input-format";

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ format?: "phone" | "capitalize" }>(), {
  format: "capitalize",
});
const model = defineModel<string>({ required: true });
const display = computed(() =>
  props.format === "phone" ? formatPhone(model.value) : model.value,
);

function update(value: string | number | null | undefined) {
  const text = String(value ?? "");
  model.value = props.format === "phone" ? phoneValue(text) : text;
}

function onInput(event: Event) {
  if (props.format !== "phone" || !(event.target instanceof HTMLInputElement))
    return;
  const input = event.target;
  const edit = phoneEdit(
    input.value,
    input.selectionStart ?? input.value.length,
    display.value,
    (event as InputEvent).inputType,
  );
  // Capture runs before UInput emits its v-model update. Vue receives the formatted DOM value.
  input.value = edit.value;
  input.setSelectionRange(edit.caret, edit.caret);
}

function onBlur() {
  if (props.format === "capitalize") model.value = capitalizeFirst(model.value);
}
</script>
