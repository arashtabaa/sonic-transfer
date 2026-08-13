<script setup lang="ts">
import { ModemProfileKey } from '~/acoustic'
import { AcousticLinkTester } from '~/acoustic/transport/link-test'
import { useAcousticSessionStore } from '~/stores/acousticSession'

const props = withDefaults(defineProps<{
  data: Uint8Array
  filename?: string
  contentType?: string
}>(), {})

const store = useAcousticSessionStore()

const linkTestRunning = ref(false)
const linkTestStatus = ref<string | null>(null)

async function toggleSend() {
  if (store.isTransmitting) {
    store.stopTransmission()
  } else {
    await store.startTransmission(props.data, props.filename, props.contentType)
  }
}

async function runLinkCheck() {
  if (linkTestRunning.value) return
  linkTestRunning.value = true
  linkTestStatus.value = 'Sending preflight link test probe...'

  const nonce = Math.floor(Math.random() * 1000000)
  const probePayload = AcousticLinkTester.createProbePayload(12345, nonce)

  // Trigger short probe transmission via store
  await store.startTransmission(probePayload, 'preflight-link-probe.bin', 'application/octet-stream')

  setTimeout(() => {
    store.stopTransmission()
    linkTestRunning.value = false
    linkTestStatus.value = 'Preflight probe broadcast complete. Verify receiver signal.'
  }, 2500)
}
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <!-- File Details Header Card (Layout metrics overlap fix applied: min-w-0 & truncate & tabular numbers) -->
    <div class="rounded-xl border border-neutral-800 bg-neutral-900/80 p-4 sm:p-5 flex flex-col gap-4">
      <div class="flex items-center justify-between gap-4 border-b border-neutral-800 pb-3 min-w-0">
        <div class="flex items-center gap-3 min-w-0">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30">
            <span class="i-carbon-document-blank text-xl" />
          </div>
          <div class="flex flex-col min-w-0">
            <span class="text-sm font-bold text-neutral-100 truncate" :title="props.filename">{{ props.filename || 'Untitled File' }}</span>
            <span class="text-xs text-neutral-400 truncate">{{ props.contentType || 'application/octet-stream' }}</span>
          </div>
        </div>
        <div class="shrink-0 text-right font-mono text-xs font-semibold text-emerald-400">
          {{ (props.data.length / 1024).toFixed(1) }} KB
        </div>
      </div>

      <!-- Transmitter Metrics Grid -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex flex-col gap-0.5">
          <span class="text-neutral-500 text-10px uppercase tracking-wider font-sans">Status</span>
          <span class="font-bold font-sans" :class="store.isTransmitting ? 'text-emerald-400 animate-pulse' : 'text-neutral-400'">
            {{ store.isTransmitting ? 'Transmitting' : 'Idle' }}
          </span>
        </div>
        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex flex-col gap-0.5 min-w-0">
          <span class="text-neutral-500 text-10px uppercase tracking-wider font-sans">Frames Sent</span>
          <span class="font-bold text-neutral-200 tabular-nums truncate">{{ store.framesSent }}</span>
        </div>
        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex flex-col gap-0.5 min-w-0">
          <span class="text-neutral-500 text-10px uppercase tracking-wider font-sans">Bytes Sent</span>
          <span class="font-bold text-blue-400 tabular-nums truncate">{{ (store.bytesSent / 1024).toFixed(1) }} KB</span>
        </div>
        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex flex-col gap-0.5 min-w-0">
          <span class="text-neutral-500 text-10px uppercase tracking-wider font-sans">Profile</span>
          <span class="font-bold text-purple-400 capitalize truncate font-sans">{{ store.selectedProfile }}</span>
        </div>
      </div>

      <!-- Action Controls -->
      <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
        <button
          class="flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-bold text-white shadow-lg transition active:scale-95"
          :class="store.isTransmitting ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'"
          @click="toggleSend"
        >
          <span :class="store.isTransmitting ? 'i-carbon-stop-filled' : 'i-carbon-play-filled-alt'" class="text-base" />
          {{ store.isTransmitting ? 'Stop Transmission' : 'Start Transmission' }}
        </button>

        <button
          class="flex items-center gap-1.5 rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700"
          :disabled="linkTestRunning"
          @click="runLinkCheck"
        >
          <span class="i-carbon-connection-signal text-sm" />
          {{ linkTestRunning ? 'Testing...' : 'Run Link Preflight Test' }}
        </button>
      </div>

      <!-- Link Preflight Feedback Banner -->
      <div v-if="linkTestStatus" class="rounded-lg border border-blue-500/30 bg-blue-950/20 p-3 text-xs text-blue-300 font-mono">
        {{ linkTestStatus }}
      </div>
    </div>

    <!-- Live Spectrum Visualizer -->
    <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-3">Transmitter Audio Spectrum</h3>
      <SpectrumVisualizer :samples="store.liveSamples" :active="store.isTransmitting" />
    </div>
  </div>
</template>
