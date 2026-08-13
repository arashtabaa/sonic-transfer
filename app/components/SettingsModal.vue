<script setup lang="ts">
import { ModemProfileKey } from '~/acoustic'

const profile = useLocalStorage<ModemProfileKey>('sonic-profile', ModemProfileKey.AUTO)
const gain = useLocalStorage<number>('sonic-gain', 0.7)
const sliceSize = useLocalStorage<number>('sonic-slice-size', 200)

const customStartFreq = useLocalStorage<number>('sonic-custom-start-freq', 2000)
const customEndFreq = useLocalStorage<number>('sonic-custom-end-freq', 6000)
const carrierCount = useLocalStorage<number>('sonic-carrier-count', 16)

const showAdvanced = ref(false)
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <div class="border-b border-neutral-800 pb-4">
      <h2 class="text-xl font-bold text-neutral-100">Sonic Transfer Settings</h2>
      <p class="text-xs text-neutral-400">Configure acoustic modem frequency bands, output gain, and transmission profiles</p>
    </div>

    <!-- Acoustic Profile Presets -->
    <div class="flex flex-col gap-3">
      <label class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Frequency Profile Preset</label>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <button
          v-for="pKey in Object.values(ModemProfileKey)"
          :key="pKey"
          class="flex flex-col gap-1 rounded-lg border p-3 text-left transition"
          :class="profile === pKey ? 'border-blue-500 bg-blue-950/30 text-white' : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:bg-neutral-800'"
          @click="profile = pKey"
        >
          <span class="font-semibold text-xs capitalize text-neutral-200">{{ pKey.replace('_', ' ') }}</span>
          <span class="text-10px text-neutral-400">
            {{ pKey === ModemProfileKey.AUTO ? 'Auto calibration' : pKey === ModemProfileKey.ROBUST ? 'Max compatibility' : pKey === ModemProfileKey.TURBO ? 'High throughput' : pKey === ModemProfileKey.NEAR_ULTRASONIC ? 'Reduced sound' : 'Standard band' }}
          </span>
        </button>
      </div>
    </div>

    <!-- Sound Output Volume / Gain -->
    <div class="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
      <div class="flex justify-between text-xs font-mono">
        <span class="text-neutral-400">Transmission Speaker Gain (Volume)</span>
        <span class="font-semibold text-emerald-400">{{ Math.round(gain * 100) }}%</span>
      </div>
      <input
        v-model.number="gain"
        type="range"
        min="0.1"
        max="1.0"
        step="0.05"
        class="w-full accent-blue-500 cursor-pointer"
      >
      <p class="text-10px text-neutral-500">Keep gain moderate to avoid speaker clipping and distortion.</p>
    </div>

    <!-- Advanced Modem Controls Toggle -->
    <div class="flex items-center justify-between border-t border-neutral-800 pt-4">
      <span class="text-xs font-semibold text-neutral-400">Advanced Modem Tuning</span>
      <button
        class="text-xs text-blue-400 hover:underline"
        @click="showAdvanced = !showAdvanced"
      >
        {{ showAdvanced ? 'Hide Advanced' : 'Show Advanced' }}
      </button>
    </div>

    <!-- Advanced Settings Controls -->
    <div v-if="showAdvanced" class="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-xs font-mono">
      <div>
        <label class="block text-neutral-400 mb-1">Start Frequency (Hz)</label>
        <input
          v-model.number="customStartFreq"
          type="number"
          min="500"
          max="20000"
          class="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-neutral-200"
        >
      </div>
      <div>
        <label class="block text-neutral-400 mb-1">End Frequency (Hz)</label>
        <input
          v-model.number="customEndFreq"
          type="number"
          min="1000"
          max="23000"
          class="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-neutral-200"
        >
      </div>
      <div>
        <label class="block text-neutral-400 mb-1">Carrier Count (Tones)</label>
        <input
          v-model.number="carrierCount"
          type="number"
          min="2"
          max="64"
          class="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-neutral-200"
        >
      </div>
      <div>
        <label class="block text-neutral-400 mb-1">Fountain Slice Size (Bytes)</label>
        <input
          v-model.number="sliceSize"
          type="number"
          min="50"
          max="1000"
          class="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-neutral-200"
        >
      </div>
    </div>
  </div>
</template>
