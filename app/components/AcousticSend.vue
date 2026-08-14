<script setup lang="ts">
import { ModemProfileKey, SonicWaveformRenderer, detectOggOpusSupport, encodeWavBlob, encodeOggOpusBlob } from '~/acoustic'
import { generateTestPayload } from '~/constants/testPayload'
import { SessionStep, useAcousticSessionStore } from '~/stores/acousticSession'

const store = useAcousticSessionStore()
const oggStatus = ref<'IDLE' | 'SUPPORTED' | 'UNSUPPORTED' | 'FAILED'>('IDLE')
const oggStatusMessage = ref('')

const inputDevices = ref<MediaDeviceInfo[]>([])
const outputDevices = ref<MediaDeviceInfo[]>([])

onMounted(async () => {
  if (navigator.mediaDevices?.enumerateDevices) {
    const devices = await navigator.mediaDevices.enumerateDevices()
    inputDevices.value = devices.filter(d => d.kind === 'audioinput')
    outputDevices.value = devices.filter(d => d.kind === 'audiooutput')
  }
})

async function onFileSelected(file?: File) {
  if (!file) return
  const buffer = await file.arrayBuffer()
  await store.setFile(new Uint8Array(buffer), file.name, file.type || 'application/octet-stream')
}

async function startRealFileTransfer() {
  if (!store.storedData) return
  store.sessionStep = SessionStep.TRANSFERRING
  await store.startTransmission()
}

async function exportWavArtifact() {
  const payload = store.storedData || generateTestPayload()
  const renderResult = SonicWaveformRenderer.renderPayloadToPcm(
    payload,
    store.sendFilename || 'sonic-test-fixture.bin',
    store.sendContentType || 'application/octet-stream',
    store.selectedProfile,
  )
  const wavBlob = encodeWavBlob(renderResult.pcm, renderResult.sampleRate)
  const url = URL.createObjectURL(wavBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = `sonic-${store.sendFilename || 'test'}.wav`
  a.click()
}

async function exportOggArtifact() {
  const capability = detectOggOpusSupport()
  if (!capability.supported) {
    oggStatus.value = 'UNSUPPORTED'
    oggStatusMessage.value = capability.reason || 'WebCodecs Opus is unavailable in this browser.'
    return
  }
  const payload = store.storedData || generateTestPayload()
  const renderResult = SonicWaveformRenderer.renderPayloadToPcm(
    payload,
    store.sendFilename || 'sonic-test-fixture.bin',
    store.sendContentType || 'application/octet-stream',
    store.selectedProfile,
  )
  try {
    const oggBlob = await encodeOggOpusBlob(renderResult.pcm, renderResult.sampleRate)
    const url = URL.createObjectURL(oggBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sonic-${store.sendFilename || 'test'}.ogg`
    a.click()
    oggStatus.value = 'SUPPORTED'
    oggStatusMessage.value = 'Genuine Ogg/Opus artifact exported.'
  } catch (e: any) {
    oggStatus.value = 'FAILED'
    oggStatusMessage.value = e.message || 'OGG/Opus export failed.'
  }
}
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <!-- Header -->
    <div class="border-b border-neutral-800 pb-3">
      <h2 class="text-xl font-bold text-neutral-100">Sonic Transfer Sender</h2>
      <p class="text-xs text-neutral-400">Verify acoustic link and test transfer before selecting real files</p>
    </div>

    <!-- Step 1: Acoustic Link Verification Card -->
    <div class="rounded-xl border border-neutral-800 bg-neutral-900/80 p-4 sm:p-5 flex flex-col gap-4">
      <div class="flex items-center justify-between border-b border-neutral-800 pb-3">
        <h3 class="text-sm font-bold text-neutral-100 uppercase tracking-wider">Step 1: Acoustic Link Setup</h3>
        <span
          class="text-xs font-mono font-bold px-2.5 py-1 rounded-md"
          :class="{
            'bg-amber-950/60 text-amber-400 border border-amber-500/30': store.sessionStep === SessionStep.NOT_READY || store.sessionStep === SessionStep.HARDWARE_READY,
            'bg-blue-950/60 text-blue-400 border border-blue-500/30': store.sessionStep === SessionStep.VERIFYING_LINK,
            'bg-emerald-950/60 text-emerald-400 border border-emerald-500/30': store.sessionStep !== SessionStep.NOT_READY && store.sessionStep !== SessionStep.VERIFYING_LINK,
          }"
        >
          Status: {{ store.sessionStep === SessionStep.NOT_READY ? 'NOT VERIFIED' : store.sessionStep === SessionStep.VERIFYING_LINK ? 'VERIFYING...' : 'VERIFIED' }}
        </span>
      </div>

      <!-- Devices & Profile Controls -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
        <div>
          <label class="block text-neutral-400 mb-1 font-sans">Input Device</label>
          <select v-model="store.selectedMicId" class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-neutral-200">
            <option value="">System Microphone</option>
            <option v-for="d in inputDevices" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId.slice(0, 8) }}</option>
          </select>
        </div>
        <div>
          <label class="block text-neutral-400 mb-1 font-sans">Output Device</label>
          <select v-model="store.selectedSpeakerId" class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-neutral-200">
            <option value="">System Speaker</option>
            <option v-for="d in outputDevices" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId.slice(0, 8) }}</option>
          </select>
        </div>
        <div>
          <label class="block text-neutral-400 mb-1 font-sans">Transfer Profile</label>
          <select v-model="store.selectedProfile" class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-neutral-200 capitalize">
            <option v-for="pKey in Object.values(ModemProfileKey)" :key="pKey" :value="pKey">{{ pKey }}</option>
          </select>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 pt-2">
        <button
          class="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-bold text-white transition hover:bg-blue-500 shadow-md active:scale-95 disabled:opacity-50"
          :disabled="store.sessionStep === SessionStep.VERIFYING_LINK"
          @click="store.runAcousticLinkCheck"
        >
          <span class="i-carbon-connection-signal text-sm" />
          {{ store.sessionStep === SessionStep.VERIFYING_LINK ? 'Verifying Link...' : 'Verify Acoustic Link' }}
        </button>

        <button
          class="text-xs text-neutral-400 hover:text-neutral-200 underline"
          @click="store.skipVerification"
        >
          Skip Verification (Not recommended)
        </button>
      </div>

      <div v-if="store.linkCheckMessage" class="rounded-lg border border-blue-500/30 bg-blue-950/20 p-3 text-xs text-blue-300 font-mono">
        {{ store.linkCheckMessage }}
      </div>
    </div>

    <!-- Step 2: Built-in Test File Transfer (Locked until Link Verified) -->
    <div
      class="rounded-xl border p-4 sm:p-5 flex flex-col gap-3 transition"
      :class="store.sessionStep === SessionStep.NOT_READY || store.sessionStep === SessionStep.VERIFYING_LINK ? 'border-neutral-800 bg-neutral-950/40 opacity-50' : 'border-neutral-800 bg-neutral-900/80'"
    >
      <div class="flex items-center justify-between border-b border-neutral-800 pb-3">
        <h3 class="text-sm font-bold text-neutral-100 uppercase tracking-wider">Step 2: Built-in Test Transfer</h3>
        <span class="text-xs text-neutral-400 font-mono">8 KiB Deterministic Payload</span>
      </div>

      <p class="text-xs text-neutral-300">
        Verify the complete acoustic modulation and Fountain decoder pipeline using a deterministic 8 KiB test payload before selecting your own file.
      </p>

      <div class="flex items-center gap-3 pt-1">
        <button
          class="flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-bold text-white transition shadow-md active:scale-95 disabled:opacity-40 cursor-pointer"
          :class="store.sessionStep === SessionStep.TEST_TRANSFERRING ? 'bg-amber-600 hover:bg-amber-500' : 'bg-purple-600 hover:bg-purple-500'"
          :disabled="store.sessionStep === SessionStep.NOT_READY || store.sessionStep === SessionStep.VERIFYING_LINK || store.sessionStep === SessionStep.TEST_TRANSFERRING"
          @click="store.runTestFileTransfer"
        >
          <span class="i-carbon-play-filled-alt text-sm" />
          {{ store.sessionStep === SessionStep.TEST_TRANSFERRING ? 'Running Test Transfer...' : 'Run Test Transfer' }}
        </button>

        <span v-if="store.sessionStep === SessionStep.TEST_TRANSFER_VERIFIED" class="text-xs text-emerald-400 font-bold font-mono flex items-center gap-1">
          <span class="i-carbon-checkmark-filled" />
          Test File Passed!
        </span>
      </div>
    </div>

    <!-- Step 3: Real File Selection (Locked until Test Transfer Passes) -->
    <div
      class="rounded-xl border p-4 sm:p-5 flex flex-col gap-4 transition"
      :class="(store.sessionStep !== SessionStep.TEST_TRANSFER_VERIFIED && store.sessionStep !== SessionStep.READY_FOR_FILE && store.sessionStep !== SessionStep.FILE_SELECTED && store.sessionStep !== SessionStep.TRANSFERRING) ? 'border-neutral-800 bg-neutral-950/40 opacity-50' : 'border-emerald-500/40 bg-neutral-900/80'"
    >
      <div class="flex items-center justify-between border-b border-neutral-800 pb-3">
        <h3 class="text-sm font-bold text-neutral-100 uppercase tracking-wider">Step 3: Transfer Your File</h3>
        <span class="text-xs font-mono text-emerald-400 font-bold">
          {{ store.storedData ? 'File Ready' : 'Unlocked' }}
        </span>
      </div>

      <div v-if="!store.storedData" class="flex flex-col gap-3">
        <InputFile
          text="neutral-400"
          aspect-1 sm:aspect-auto sm:h-40 h-full w-full rounded-xl border="2 dashed neutral-700 hover:emerald-500/50" transition-colors
          :disabled="store.sessionStep !== SessionStep.TEST_TRANSFER_VERIFIED && store.sessionStep !== SessionStep.READY_FOR_FILE"
          @file="onFileSelected"
        />
      </div>

      <div v-else class="flex flex-col gap-4">
        <div class="flex items-center justify-between border-b border-neutral-800 pb-3 min-w-0 font-mono text-xs">
          <div class="flex items-center gap-3 min-w-0">
            <span class="i-carbon-document-blank text-xl text-emerald-400 shrink-0" />
            <div class="flex flex-col min-w-0">
              <span class="font-bold text-neutral-100 truncate" :title="store.sendFilename!">{{ store.sendFilename }}</span>
              <span class="text-neutral-500 truncate">{{ store.sendContentType }}</span>
            </div>
          </div>
          <span class="font-bold text-emerald-400 tabular-nums shrink-0">{{ (store.sendTotalBytes / 1024).toFixed(1) }} KB</span>
        </div>

        <div class="flex items-center gap-3">
          <button
            class="flex items-center gap-2 rounded-xl px-6 py-3 text-xs font-bold text-white shadow-lg transition active:scale-95"
            :class="store.isTransmitting ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'"
            @click="store.isTransmitting ? store.stopTransmission() : startRealFileTransfer()"
          >
            <span :class="store.isTransmitting ? 'i-carbon-stop-filled' : 'i-carbon-send-alt-filled'" class="text-base" />
            {{ store.isTransmitting ? 'Stop File Transmission' : 'Start Real File Transfer' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Secondary Mode: Audio Artifact Lab (WAV / OGG Export) (Phase 4, 5, 11) -->
    <Collapsable label="Advanced / Audio Artifact Lab (WAV & OGG Export)">
      <div class="flex flex-col gap-4 p-2 text-xs font-mono">
        <p class="text-neutral-400 font-sans">
          Secondary diagnostic mode: Render the current payload into an offline WAV or OGG/Opus audio file using the exact same protocol frames and acoustic modem.
        </p>

        <div class="flex flex-wrap gap-3">
          <button
            class="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2 text-xs font-bold text-neutral-200 hover:bg-neutral-700 transition cursor-pointer"
            @click="exportWavArtifact"
          >
            <span class="i-carbon-download text-sm text-blue-400" />
            Export Sonic WAV (Lossless PCM)
          </button>

          <button
            class="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2 text-xs font-bold text-neutral-200 hover:bg-neutral-700 transition cursor-pointer"
            @click="exportOggArtifact"
          >
            <span class="i-carbon-download text-sm text-purple-400" />
            Export Sonic OGG / Opus
          </button>
        </div>
        <p v-if="oggStatus !== 'IDLE'" class="font-sans" :class="oggStatus === 'SUPPORTED' ? 'text-emerald-400' : oggStatus === 'UNSUPPORTED' ? 'text-amber-400' : 'text-red-400'">
          OGG/Opus: {{ oggStatus }} — {{ oggStatusMessage }}
        </p>
      </div>
    </Collapsable>
  </div>
</template>
