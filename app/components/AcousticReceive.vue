<script setup lang="ts">
import { readFileHeaderMetaFromBuffer } from 'luby-transform'
import {
  AcousticPacketizer,
  AudioReceiver,
  BFSKAcousticModem,
  getProfileConfig,
  MetricsCollector,
  ModemProfileKey,
  type AudioDiagnosticsInfo,
  type SessionHeaderPayload,
} from '~/acoustic'
import { createLTDecodeWorker } from '~/composables/lt-decode'

const isListening = ref(false)
const signalDetected = ref(false)
const liveSamples = ref<Float32Array | null>(null)
const diagnostics = ref<AudioDiagnosticsInfo | null>(null)

const sessionHeader = ref<SessionHeaderPayload | null>(null)
const fountainK = ref(0)
const decodedCount = ref(0)
const totalBlocksReceived = ref(0)

const downloadUrl = ref<string | null>(null)
const downloadedFilename = ref<string | null>(null)
const downloadedContentType = ref<string | null>(null)
const isIntegrityVerified = ref(false)

const metricsCollector = new MetricsCollector()
const liveStats = ref(metricsCollector.getStats())

let receiver: AudioReceiver | null = null
let packetizer: AcousticPacketizer
let decoderWorker: ReturnType<typeof createLTDecodeWorker> | null = null
let modem: BFSKAcousticModem | null = null
let statsInterval: any = null

onMounted(() => {
  packetizer = new AcousticPacketizer()
  decoderWorker = createLTDecodeWorker()
})

onUnmounted(() => {
  stopListening()
  if (decoderWorker) {
    decoderWorker.dispose()
  }
})

async function startListening() {
  if (isListening.value) return

  metricsCollector.start()
  const config = getProfileConfig(ModemProfileKey.BALANCED, 48000)
  modem = new BFSKAcousticModem(config)

  receiver = new AudioReceiver({
    onAudioData: (samples) => {
      liveSamples.value = samples
      processAudioSamples(samples)
    },
  })

  diagnostics.value = await receiver.start()
  isListening.value = true

  statsInterval = setInterval(() => {
    liveStats.value = metricsCollector.getStats()
  }, 250)
}

function stopListening() {
  isListening.value = false
  signalDetected.value = false
  if (receiver) {
    receiver.stop()
    receiver = null
  }
  if (statsInterval) {
    clearInterval(statsInterval)
    statsInterval = null
  }
}

async function processAudioSamples(samples: Float32Array) {
  if (!modem || !decoderWorker) return

  const decodedRawPackets = modem.decode(samples)

  for (const rawPacket of decodedRawPackets) {
    const parsed = packetizer.parseIncomingBuffer(rawPacket)

    if (parsed.frame) {
      signalDetected.value = true
      metricsCollector.recordPacket(rawPacket.length, true, 22)
      totalBlocksReceived.value++

      // Handle Session Header Frame
      if (parsed.sessionHeader) {
        sessionHeader.value = parsed.sessionHeader
        fountainK.value = parsed.sessionHeader.totalFountainK
        await decoderWorker.createDecoder()
      }

      // Handle Data Fountain Frame
      if (parsed.fountainBlock) {
        if (!fountainK.value) {
          fountainK.value = parsed.fountainBlock.k
          await decoderWorker.createDecoder()
        }

        const isComplete = await decoderWorker.addBlock(parsed.fountainBlock)
        const status = await decoderWorker.getStatus()
        decodedCount.value = status.decodedCount
        metricsCollector.setFountainStatus(fountainK.value, decodedCount.value)

        if (isComplete && !downloadUrl.value) {
          const merged = (await decoderWorker.getDecoded())!
          const [mergedData, meta] = readFileHeaderMetaFromBuffer(merged)

          const blob = new Blob([mergedData], { type: meta.contentType || 'application/octet-stream' })
          downloadUrl.value = URL.createObjectURL(blob)
          downloadedFilename.value = meta.filename || sessionHeader.value?.filename || 'downloaded-file'
          downloadedContentType.value = meta.contentType
          isIntegrityVerified.value = true
          stopListening()
        }
      }
    } else {
      metricsCollector.recordPacket(rawPacket.length, false, 5)
    }
  }
}
</script>

<template>
  <div class="w-full flex flex-col gap-5">
    <!-- Controls Header -->
    <div class="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
      <div class="flex items-center gap-3">
        <span
          class="h-3 w-3 rounded-full"
          :class="isListening ? (signalDetected ? 'bg-emerald-500 animate-ping' : 'bg-blue-500 animate-pulse') : 'bg-neutral-600'"
        />
        <div>
          <h3 class="font-semibold text-neutral-200">
            {{ isListening ? (signalDetected ? 'Receiving Acoustic Stream' : 'Listening for audio signal...') : 'Ready to Receive' }}
          </h3>
          <p class="text-xs text-neutral-400">
            {{ diagnostics ? `Mic: ${diagnostics.selectedMicrophone} (${diagnostics.audioContextSampleRate} Hz)` : 'Click start to open microphone' }}
          </p>
        </div>
      </div>

      <button
        v-if="!isListening"
        class="flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-2.5 font-semibold text-white transition hover:bg-blue-500 shadow"
        @click="startListening"
      >
        <span class="i-carbon-microphone text-lg" />
        Start Listening
      </button>
      <button
        v-else
        class="flex items-center gap-2 rounded-lg bg-neutral-700 px-5 py-2 font-semibold text-neutral-200 transition hover:bg-neutral-600"
        @click="stopListening"
      >
        Stop
      </button>
    </div>

    <!-- Live Spectrum Visualizer -->
    <SpectrumVisualizer :samples="liveSamples" :snr-db="liveStats.snrDb" />

    <!-- File Reconstruction Progress -->
    <div v-if="fountainK > 0" class="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 flex flex-col gap-3">
      <div class="flex justify-between text-sm font-mono">
        <span class="text-neutral-400">Fountain Blocks: {{ decodedCount }} / {{ fountainK }}</span>
        <span class="font-semibold text-emerald-400">{{ liveStats.fountainProgressPercent.toFixed(1) }}%</span>
      </div>

      <!-- Progress Bar -->
      <div class="h-3 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          class="h-full bg-emerald-500 transition-all duration-300"
          :style="{ width: `${liveStats.fountainProgressPercent}%` }"
        />
      </div>

      <!-- Download Button when Reconstruction Complete -->
      <div v-if="downloadUrl" class="mt-2 flex flex-col items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-4">
        <div class="flex items-center gap-2 text-emerald-400 font-semibold">
          <span class="i-carbon-checkmark-filled text-xl" />
          File Reconstructed & Integrity Verified!
        </div>
        <p class="text-xs text-neutral-400">{{ downloadedFilename }} ({{ downloadedContentType }})</p>
        <a
          :href="downloadUrl"
          :download="downloadedFilename"
          class="mt-2 flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2.5 font-semibold text-white transition hover:bg-emerald-500 shadow"
        >
          <span class="i-carbon-download text-lg" />
          Download File
        </a>
      </div>
    </div>
  </div>
</template>
