<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  name?: string
  disabled?: boolean
  modelValue?: number
  min?: number
  max?: number
  step?: number
  smooth?: boolean
  formatter?: (arg: number) => string
}>(), {
  name: 'Slider',
  modelValue: 0,
  min: 0,
  max: 100,
  step: 1,
})

const emits = defineEmits<{
  (e: 'update:modelValue', value: number): void
}>()

const inputSliderRef = ref<HTMLInputElement | null>(null)
const inputValue = ref(0)
if (props.smooth) {
  inputValue.value = props.modelValue * 100
}
else {
  inputValue.value = props.modelValue
}

const min = computed(() => {
  if (props.smooth) {
    return props.min * 100
  }

  return props.min
})
const max = computed(() => {
  if (props.smooth) {
    return props.max * 100
  }

  return props.max
})

onMounted(() => {
  if (!inputSliderRef.value)
    return

  inputSliderRef.value.style.setProperty('--sonic-slider-value', inputValue.value.toString())
  inputSliderRef.value.style.setProperty('--sonic-slider-min', min.value.toString())
  inputSliderRef.value.style.setProperty('--sonic-slider-max', max.value.toString())
  inputSliderRef.value.addEventListener('input', () => {
    if (!inputSliderRef.value)
      return

    inputSliderRef.value.style.setProperty('--sonic-slider-value', inputSliderRef.value.value.toString())
  })
})

watch(() => props.modelValue, (val) => {
  if (props.smooth) {
    inputValue.value = val * 100
  }
  else {
    inputValue.value = val
  }
})

watch(inputValue, (val) => {
  // As number
  val = Number.parseFloat(val.toString())

  if (val < min.value)
    val = min.value

  if (val > max.value)
    val = max.value

  if (props.smooth) {
    emits('update:modelValue', val / 100)
  }
  else {
    emits('update:modelValue', val)
  }
})

watch(min, (val) => {
  if (inputValue.value >= val)
    return

  inputValue.value = val
})

watch(max, (val) => {
  if (inputValue.value <= val)
    return

  inputValue.value = val
})
</script>

<template>
  <div
    flex="~ row"
    w-full appearance-none rounded-lg border-none space-x-2
    text="sm zinc-300"
    outline="transparent"
  >
    <label
      class="sonic-slider sonic-slider"
      relative w-full select-none rounded-lg
    >
      <input
        ref="inputSliderRef"
        v-model="inputValue"
        type="range"
        :name="props.name"
        :min="min"
        :max="max"
        :disabled="props.disabled"
        :class="{ disabled: props.disabled }"
        :step="props.step"
        class="sonic-slider-input sonic-slider-input-progress-indicator rounded-lg"
        w-full
      >
    </label>
  </div>
</template>

<style scoped less>
.sonic-slider {
  --sonic-slider-height: 24px;
  --sonic-slider-shadow-color: #8b8b8b4d;

  --sonic-slider-thumb-height: 24px;
  --sonic-slider-thumb-width: 24px;
  --sonic-slider-thumb-border-radius: 6px;
  --sonic-slider-thumb-color: #fcfcfc;

  --sonic-slider-track-height: calc(var(--sonic-slider-height) - var(--sonic-slider-track-progress-padding) * 2);
  --sonic-slider-track-border-radius: 6px;
  --sonic-slider-track-color: #e3e3e3;

  --sonic-slider-track-progress-color: #828282;
  --sonic-slider-track-progress-padding: 0px;
}

.dark .sonic-slider {
  --sonic-slider-shadow-color: #bebebe30;
  --sonic-slider-thumb-color: #d2d2d2;
  --sonic-slider-track-color: #343434;
  --sonic-slider-track-progress-color: #868686;
}

.sonic-slider {
  height: var(--sonic-slider-height);
  cursor: col-resize;
}

/*
  Generated with Input range slider CSS style generator (version 20211225)
  https://toughengineer.github.io/demo/slider-styler
*/
.sonic-slider-input {
  height: var(--sonic-slider-height);
  margin: 0 0;
  appearance: none;
  -webkit-appearance: none;
  transition: background-color 0.2s ease;
  cursor: col-resize;
}

/* Progress */
.sonic-slider-input.sonic-slider-input-progress-indicator {
  --sonic-slider-range: calc(var(--sonic-slider-max) - var(--sonic-slider-min));
  --sonic-slider-ratio: calc((var(--sonic-slider-value) - var(--sonic-slider-min)) / var(--sonic-slider-range));
  --sonic-slider-sx: calc(
    0.5 * var(--sonic-slider-thumb-width) + var(--sonic-slider-ratio) * (100% - var(--sonic-slider-thumb-width))
  );
}

.sonic-slider-input:focus {
  outline: none;
}

/* Webkit */
.sonic-slider-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: var(--sonic-slider-thumb-width);
  height: var(--sonic-slider-thumb-height);
  border-radius: var(--sonic-slider-thumb-border-radius);
  background: var(--sonic-slider-thumb-color);
  border: none;
  box-shadow: 0 2px 4px 0px var(--sonic-slider-shadow-color);
  margin-top: calc(var(--sonic-slider-track-height) * 0.5 - var(--sonic-slider-thumb-height) * 0.5);
  margin-left: calc(0 - var(--sonic-slider-track-progress-padding));
  cursor: col-resize;
}

.sonic-slider-input::-webkit-slider-runnable-track {
  height: var(--sonic-slider-track-height);
  border: none;
  border-radius: var(--sonic-slider-track-border-radius);
  background: var(--sonic-slider-track-color);
  box-shadow: none;
  cursor: col-resize;
}

.sonic-slider-input.sonic-slider-input-progress-indicator::-webkit-slider-runnable-track {
  background:
    linear-gradient(var(--sonic-slider-track-progress-color), var(--sonic-slider-track-progress-color)) 0 /
      var(--sonic-slider-sx) 100% no-repeat,
    var(--sonic-slider-track-color);
  margin-left: var(--sonic-slider-track-progress-padding);
  margin-right: calc(0 - var(--sonic-slider-track-progress-padding));
  cursor: col-resize;
}

/* Firefox */
.sonic-slider-input::-moz-range-thumb {
  width: var(--sonic-slider-thumb-width);
  height: var(--sonic-slider-thumb-height);
  margin-left: calc(0 - var(--sonic-slider-track-progress-padding));
  border-radius: var(--sonic-slider-thumb-border-radius);
  background: var(--sonic-slider-thumb-color);
  border: none;
  box-shadow: 0 2px 4px 0px var(--sonic-slider-shadow-color);
  cursor: col-resize;
}

.sonic-slider-input::-moz-range-track {
  height: var(--sonic-slider-track-height);
  border: none;
  border-radius: var(--sonic-slider-track-border-radius);
  background: #f1f1f100;
  box-shadow: none;
  cursor: col-resize;
}

.sonic-slider-input.sonic-slider-input-progress-indicator::-moz-range-track {
  background:
    linear-gradient(var(--sonic-slider-track-progress-color), var(--sonic-slider-track-progress-color)) 0 /
      var(--sonic-slider-sx) 100% no-repeat,
    var(--sonic-slider-track-color);
  display: block;
  /* Trim left and right 4px paddings of track */
  width: calc(100% - var(--sonic-slider-track-progress-padding) - var(--sonic-slider-track-progress-padding));
  cursor: col-resize;
}

/* Microsoft */
.sonic-slider-input::-ms-fill-upper {
  background: transparent;
  border-color: transparent;
}

.sonic-slider-input::-ms-fill-lower {
  background: transparent;
  border-color: transparent;
}

.sonic-slider-input::-ms-thumb {
  width: var(--sonic-slider-thumb-width);
  height: var(--sonic-slider-thumb-height);
  border-radius: var(--sonic-slider-thumb-border-radius);
  background: (--sonic-slider-thumb-color);
  border: none;
  box-shadow: 0 2px 4px 0px var(--sonic-slider-shadow-color);
  box-sizing: border-box;
  /** Center thumb */
  margin-top: 0;
  /** Shift left thumb */
  margin-left: calc(0 - var(--sonic-slider-track-progress-padding));
  cursor: col-resize;
}

.sonic-slider-input::-ms-track {
  height: var(--sonic-slider-track-height);
  border-radius: var(--sonic-slider-thumb-border-radius);
  background: var(--sonic-slider-track-color);
  border: none;
  box-shadow: none;
  box-sizing: border-box;
  cursor: col-resize;
}

.sonic-slider-input.sonic-slider-input-progress-indicator::-ms-fill-lower {
  height: var(--sonic-slider-track-height);
  border-radius: var(--sonic-slider-track-border-radius) 0 0 var(--sonic-slider-track-border-radius);
  background: var(--sonic-slider-track-progress-color);
  border: none;
  border-right-width: 0;
  margin-top: 0;
  margin-bottom: 0;
  /** Shift left thumb */
  margin-left: calc(var(--sonic-slider-track-progress-padding));
  /** Shift right thumb */
  margin-right: calc(0 - var(--sonic-slider-track-progress-padding));
  cursor: col-resize;
}
</style>
