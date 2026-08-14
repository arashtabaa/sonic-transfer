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

async function importAudioFile(file?: File) {
  if (!file) return
  const arrayBuf = await file.arrayBuffer()
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
  const ctx = new AudioCtx()
  const audioBuffer = await ctx.decodeAudioData(arrayBuf)
  const pcm = audioBuffer.getChannelData(0)

  // Artifact PCM uses the same persistent streaming receiver as microphone data.
  store.prepareArtifactDecoding(audioBuffer.sampleRate)
  const chunkSize = 2048
  for (let i = 0; i < pcm.length; i += chunkSize) {
    const chunk = pcm.subarray(i, Math.min(pcm.length, i + chunkSize))
    store.processCentralAudioData(chunk)
  }
  ctx.close()
}

const simpleStatus = computed(() => {
  if (store.downloadUrl) return { title: 'File received successfully', detail: 'SHA-256 verified', action: 'Receive another file' }
  if (store.receiveHeader) return { title: 'Receiving file…', detail: store.receiveHeader.filename, action: 'Stop' }
  if (store.profileVerificationStatus === 'UNVERIFIED' && store.gainCalibrationComplete) return { title: 'Verifying data link…', detail: 'Checking the production data profile', action: 'Stop' }
  if (['LOCAL_GAIN_SWEEP', 'REMOTE_GAIN_SWEEP'].includes(store.adaptiveHandshakeState)) return { title: 'Calibrating audio…', detail: 'Finding a reliable audio level', action: 'Stop' }
  if (store.dataProfileReady && store.isListening && store.receiverReadyForData) return { title: 'Link ready', detail: 'Waiting for a nearby sender…', action: 'Stop' }
  if (store.dataProfileReady && store.isListening) return { title: 'Preparing receiver…', detail: 'Re-arming the microphone for the incoming file', action: 'Stop' }
  if (store.isListening) return { title: 'Listening for nearby sender…', detail: 'Keep this page open and place the other device nearby.', action: 'Stop' }
  return { title: 'Receive a file', detail: 'Keep this page open and place the other device nearby.', action: 'Start Receiving' }
})

const activeDataBand = computed(() => {
  const config = store.verifiedDataConfig as { startFreq?: number; endFreq?: number } | null
  return config && typeof config.startFreq === 'number' && typeof config.endFreq === 'number'
    ? { startFreq: config.startFreq, endFreq: config.endFreq }
    : null
})
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <div class="rounded-2xl border border-blue-500/30 bg-blue-950/20 p-5 sm:p-6 flex flex-col gap-4">
      <div>
        <h1 class="text-xl font-bold text-neutral-100">{{ simpleStatus.title }}</h1>
        <p class="mt-1 text-sm text-neutral-300 truncate">{{ simpleStatus.detail }}</p>
      </div>
      <button
        class="min-h-12 w-full rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-md transition hover:bg-emerald-500 active:scale-95 disabled:opacity-50 sm:w-auto sm:self-start"
        :class="store.isListening ? 'bg-red-600 hover:bg-red-500' : ''"
        @click="toggleReceive"
      >
        {{ simpleStatus.action }}
      </button>
    </div>

    <!-- Receiver Action Card -->
    <div class="rounded-xl border border-neutral-800 bg-neutral-900/80 p-4 sm:p-5 flex flex-col gap-4">
      <div class="flex items-center justify-between gap-4 border-b border-neutral-800 pb-3 min-w-0">
        <div>
          <h2 class="text-base font-bold text-neutral-100">Receive</h2>
          <p class="text-xs text-neutral-400">Automatic acoustic connection</p>
        </div>
      </div>

      <!-- Real DSP State Machine Pipeline Display -->
      <Collapsable label="Technical details">
      <div class="rounded-xl border border-neutral-800 bg-neutral-950 p-4 flex flex-col gap-2 font-mono text-xs">
        <div class="flex items-center justify-between border-b border-neutral-800 pb-2 font-sans">
          <span class="text-neutral-400 font-bold uppercase tracking-wider text-10px">DSP Receiver Pipeline State</span>
          <span
            class="text-xs font-bold px-2 py-0.5 rounded"
            :class="{
              'bg-neutral-800 text-neutral-400': !store.isListening,
              'bg-amber-950 text-amber-400 border border-amber-500/30': store.isListening && store.dspStage === 'SEARCHING_FOR_SIGNAL',
              'bg-blue-950 text-blue-400 border border-blue-500/30': store.dspStage === 'CARRIER_LOCKED' || store.dspStage === 'FRAME_RECEIVING',
              'bg-emerald-950 text-emerald-400 border border-emerald-500/30': store.dspStage === 'COMPLETE' || store.dspStage === 'FOUNTAIN_BLOCK_ACCEPTED',
            }"
          >
            {{ store.isListening ? store.dspStage.replace(/_/g, ' ') : 'STANDBY' }}
          </span>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs">
          <div class="flex flex-col">
            <span class="text-neutral-500 text-10px font-sans uppercase">Signal SNR</span>
            <span class="font-bold tabular-nums" :class="store.liveStats.snrDb !== null && store.isListening ? 'text-blue-400' : 'text-neutral-500'">
              {{ (store.liveStats.snrDb !== null && store.isListening) ? `${store.liveStats.snrDb.toFixed(1)} dB` : 'N/A' }}
            </span>
          </div>
          <div class="flex flex-col">
            <span class="text-neutral-500 text-10px font-sans uppercase">Valid Bitrate</span>
            <span class="font-bold text-emerald-400 tabular-nums">{{ (store.liveStats.validPayloadBitrateBps / 1024).toFixed(2) }} KB/s</span>
          </div>
          <div class="flex flex-col">
            <span class="text-neutral-500 text-10px font-sans uppercase">Fountain Blocks</span>
            <span class="font-bold text-neutral-200 tabular-nums">{{ store.decodedCount }} / {{ store.fountainK || '?' }}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-neutral-500 text-10px font-sans uppercase">CRC Valid Frames</span>
            <span class="font-bold text-purple-400 tabular-nums">{{ store.totalBlocksReceived }}</span>
          </div>
        </div>
      </div>
      </Collapsable>

      <!-- Transmission Header Information Banner if detected -->
      <div v-if="store.receiveHeader" class="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4 flex flex-col gap-2 font-mono text-xs min-w-0">
        <div class="flex items-center justify-between border-b border-neutral-800 pb-2 min-w-0 font-sans">
          <span class="text-blue-400 font-bold">Sonic Transmission Header Detected</span>
          <span class="text-emerald-400 text-10px uppercase font-bold">Active Stream</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs min-w-0">
          <div class="flex justify-between min-w-0">
            <span class="text-neutral-400">Filename:</span>
            <span class="text-neutral-100 font-bold truncate max-w-48" :title="store.receiveHeader.filename">{{ store.receiveHeader.filename }}</span>
          </div>
          <div class="flex justify-between min-w-0">
            <span class="text-neutral-400">Total Size:</span>
            <span class="text-emerald-400 font-bold tabular-nums">{{ (store.receiveHeader.originalSize / 1024).toFixed(1) }} KB</span>
          </div>
        </div>
      </div>

      <!-- Fountain Reconstruction Progress -->
      <div v-if="store.fountainK > 0" class="flex flex-col gap-1.5 font-mono text-xs">
        <div class="flex justify-between text-neutral-400">
          <span>Fountain Reconstruction Progress</span>
          <span class="text-emerald-400 font-bold">{{ Math.min(100, Math.round((store.decodedCount / store.fountainK) * 100)) }}%</span>
        </div>
        <div class="h-3.5 w-full overflow-hidden rounded-full bg-neutral-950 border border-neutral-800">
          <div
            class="h-full bg-emerald-500 transition-all duration-300"
            :style="{ width: `${Math.min(100, (store.decodedCount / store.fountainK) * 100)}%` }"
          />
        </div>
      </div>

      <!-- Download Result Card -->
      <div v-if="store.downloadUrl" class="rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-4 flex flex-col gap-3">
        <div class="flex items-center justify-between font-sans">
          <div class="flex items-center gap-2 text-emerald-400 font-bold text-sm">
            <span class="i-carbon-checkmark-filled text-lg" />
            File Reconstructed & SHA-256 Verified!
          </div>
          <span
            class="text-xs font-mono font-bold px-2 py-0.5 rounded"
            :class="store.isIntegrityVerified ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30' : 'bg-red-950 text-red-400 border border-red-500/30'"
          >
            {{ store.isIntegrityVerified ? 'SHA-256 MATCH' : 'MISMATCH' }}
          </span>
        </div>

        <div class="rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs flex flex-col gap-1">
          <div class="flex justify-between min-w-0">
            <span class="text-neutral-500 font-sans">Expected SHA-256:</span>
            <span class="text-neutral-300 truncate max-w-56">{{ store.expectedSha256 || 'N/A' }}</span>
          </div>
          <div class="flex justify-between min-w-0">
            <span class="text-neutral-500 font-sans">Received SHA-256:</span>
            <span class="text-emerald-400 truncate max-w-56">{{ store.receivedSha256 || 'N/A' }}</span>
          </div>
        </div>

        <div class="flex items-center justify-between font-mono text-xs text-neutral-300 min-w-0">
          <span class="truncate max-w-64" :title="store.downloadedFilename!">{{ store.downloadedFilename }}</span>
          <span class="text-neutral-500">{{ store.downloadedContentType }}</span>
        </div>
        <a
          :href="store.downloadUrl"
          :download="store.downloadedFilename!"
          class="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-xs font-bold text-white transition hover:bg-emerald-500 shadow-md"
        >
          <span class="i-carbon-download text-base" />
          Download File
        </a>
      </div>
    </div>

    <Collapsable label="Advanced / Signal spectrum">
      <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-3">Microphone Signal Spectrum</h3>
        <SpectrumVisualizer
          :samples="store.liveSamples"
          :active="store.isListening"
          :sample-rate="store.receiveSampleRate"
          :active-freq-start="activeDataBand?.startFreq"
          :active-freq-end="activeDataBand?.endFreq"
        />
      </div>
    </Collapsable>

    <!-- Secondary Mode: Audio Artifact File Import (Phase 7) -->
    <Collapsable label="Advanced / Decode Sonic Audio File (WAV / OGG / Opus)">
      <div class="flex flex-col gap-4 p-2 text-xs font-mono">
        <p class="text-neutral-400 font-sans">
          Secondary diagnostic mode: Upload a recorded Sonic audio file (.wav, .ogg, .opus) to pass its decoded PCM samples directly into the central receiver DSP pipeline.
        </p>
        <InputFile text="Upload Audio Artifact (.wav, .ogg, .opus)" @file="importAudioFile" />
      </div>
    </Collapsable>
  </div>
</template>
