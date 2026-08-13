<script setup lang="ts">
import { useAcousticSessionStore } from '~/stores/acousticSession'

const store = useAcousticSessionStore()

async function toggleReceive() {
  if (store.isListening) {
    store.stopListening()
  } else {
    await store.startListening()
  }
}
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <!-- Main Receiver Action Card -->
    <div class="rounded-xl border border-neutral-800 bg-neutral-900/80 p-4 sm:p-5 flex flex-col gap-4">
      <div class="flex items-center justify-between gap-4 border-b border-neutral-800 pb-3 min-w-0">
        <div>
          <h2 class="text-base font-bold text-neutral-100">Acoustic Audio Receiver</h2>
          <p class="text-xs text-neutral-400">Microphone capture & real-time demodulation</p>
        </div>
        <button
          class="flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-bold text-white shadow-lg transition active:scale-95"
          :class="store.isListening ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'"
          @click="toggleReceive"
        >
          <span :class="store.isListening ? 'i-carbon-stop-filled' : 'i-carbon-microphone'" class="text-base" />
          {{ store.isListening ? 'Stop Listening' : 'Start Listening' }}
        </button>
      </div>

      <!-- Receiver Metrics Grid (Layout overlap fix: min-w-0 & truncate & tabular numbers) -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex flex-col gap-0.5 min-w-0">
          <span class="text-neutral-500 text-10px uppercase tracking-wider font-sans">Status</span>
          <span class="font-bold font-sans truncate" :class="store.isListening ? 'text-emerald-400 animate-pulse' : 'text-neutral-400'">
            {{ store.isListening ? 'Listening' : 'Idle' }}
          </span>
        </div>
        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex flex-col gap-0.5 min-w-0">
          <span class="text-neutral-500 text-10px uppercase tracking-wider font-sans">Valid Bitrate</span>
          <span class="font-bold text-blue-400 tabular-nums truncate">{{ (store.liveStats.validPayloadBitrateBps / 1024).toFixed(2) }} KB/s</span>
        </div>
        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex flex-col gap-0.5 min-w-0">
          <span class="text-neutral-500 text-10px uppercase tracking-wider font-sans">Blocks Received</span>
          <span class="font-bold text-neutral-200 tabular-nums truncate">{{ store.decodedCount }} / {{ store.fountainK || '?' }}</span>
        </div>
        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex flex-col gap-0.5 min-w-0">
          <span class="text-neutral-500 text-10px uppercase tracking-wider font-sans">Signal SNR</span>
          <span class="font-bold text-purple-400 tabular-nums truncate">{{ store.liveStats.snrDb.toFixed(1) }} dB</span>
        </div>
      </div>

      <!-- Session Header Info Banner if detected -->
      <div v-if="store.receiveHeader" class="rounded-lg border border-neutral-800 bg-neutral-950 p-3.5 flex flex-col gap-2 font-mono text-xs min-w-0">
        <div class="flex items-center justify-between border-b border-neutral-800 pb-2 min-w-0">
          <span class="text-neutral-400 font-sans font-semibold">Transmission Detected</span>
          <span class="text-emerald-400 text-10px uppercase font-sans font-bold">Active</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs min-w-0">
          <div class="flex justify-between min-w-0">
            <span class="text-neutral-500">File:</span>
            <span class="text-neutral-200 font-bold truncate max-w-48" :title="store.receiveHeader.filename">{{ store.receiveHeader.filename }}</span>
          </div>
          <div class="flex justify-between min-w-0">
            <span class="text-neutral-500">Size:</span>
            <span class="text-emerald-400 font-bold tabular-nums">{{ (store.receiveHeader.originalSize / 1024).toFixed(1) }} KB</span>
          </div>
        </div>
      </div>

      <!-- Fountain Progress Bar -->
      <div v-if="store.fountainK > 0" class="flex flex-col gap-1.5 font-mono text-xs">
        <div class="flex justify-between text-neutral-400">
          <span>Fountain Reconstruction</span>
          <span class="text-emerald-400 font-bold">{{ Math.min(100, Math.round((store.decodedCount / store.fountainK) * 100)) }}%</span>
        </div>
        <div class="h-3 w-full overflow-hidden rounded-full bg-neutral-950 border border-neutral-800">
          <div
            class="h-full bg-emerald-500 transition-all duration-300"
            :style="{ width: `${Math.min(100, (store.decodedCount / store.fountainK) * 100)}%` }"
          />
        </div>
      </div>

      <!-- Download Result Card -->
      <div v-if="store.downloadUrl" class="rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-4 flex flex-col gap-3">
        <div class="flex items-center gap-2 text-emerald-400 font-bold text-sm">
          <span class="i-carbon-checkmark-filled text-lg" />
          File Reconstructed & Integrity Verified!
        </div>
        <div class="flex items-center justify-between font-mono text-xs text-neutral-300 min-w-0">
          <span class="truncate max-w-64" :title="store.downloadedFilename!">{{ store.downloadedFilename }}</span>
          <span class="text-neutral-500">{{ store.downloadedContentType }}</span>
        </div>
        <a
          :href="store.downloadUrl"
          :download="store.downloadedFilename!"
          class="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-emerald-500 shadow-md"
        >
          <span class="i-carbon-download text-base" />
          Download File
        </a>
      </div>
    </div>

    <!-- Live Receiver Spectrum -->
    <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-3">Microphone Audio Spectrum</h3>
      <SpectrumVisualizer :samples="store.liveSamples" :active="store.isListening" />
    </div>
  </div>
</template>
