<script setup lang="ts">
import { appendFileHeaderMetaToBuffer, createEncoder, type EncodedBlock, type LtEncoder } from 'luby-transform'
import {
  AcousticPacketizer,
  AudioTransmitter,
  BFSKAcousticModem,
  getProfileConfig,
  ModemProfileKey,
  type SessionHeaderPayload,
} from '~/acoustic'

const props = withDefaults(defineProps<{
  data: Uint8Array
  filename?: string
  contentType?: string
  sliceSize?: number
  profileKey?: ModemProfileKey
}>(), {
  sliceSize: 200,
  profileKey: ModemProfileKey.BALANCED,
})

const isTransmitting = ref(false)
const framesSent = ref(0)
const bytesSent = ref(0)
const liveSamples = ref<Float32Array | null>(null)

let encoder: LtEncoder
let transmitter: AudioTransmitter | null = null
let packetizer: AcousticPacketizer
let transmitInterval: any = null

const profileConfig = computed(() => {
  const sampleRate = transmitter?.getSampleRate() || 48000
  return getProfileConfig(props.profileKey, sampleRate)
})

watch(() => [props.data, props.sliceSize], () => {
  encoder = createEncoder(props.data, props.sliceSize, true)
}, { immediate: true })

onMounted(() => {
  packetizer = new AcousticPacketizer()
})

onUnmounted(() => {
  stopTransmission()
})

async function startTransmission() {
  if (isTransmitting.value) return

  const sampleRate = 48000
  transmitter = new AudioTransmitter({ sampleRate, gain: profileConfig.value.gain })
  await transmitter.start()

  const modem = new BFSKAcousticModem(profileConfig.value)
  isTransmitting.value = true
  framesSent.value = 0
  bytesSent.value = 0

  const fountainGen = encoder.fountain()

  // 1. Periodically send Session Header
  const sessionHeader: SessionHeaderPayload = {
    protocolVersion: 1,
    sessionId: packetizer.getSessionId(),
    filename: props.filename || 'file.bin',
    contentType: props.contentType || 'application/octet-stream',
    originalSize: props.data.length,
    encodedSize: props.data.length,
    fileChecksum: encoder.checksum,
    totalFountainK: encoder.k,
    modemProfile: props.profileKey,
  }

  // Send header first frame
  const headerFrame = packetizer.createSessionHeaderFrame(sessionHeader)
  const headerAudio = modem.encode(headerFrame)
  transmitter.enqueueFrame(headerAudio)
  liveSamples.value = headerAudio.samples

  // Continuous transmission loop
  transmitInterval = setInterval(() => {
    if (!isTransmitting.value) return

    let frameBytes: Uint8Array
    if (framesSent.value % 10 === 0) {
      // Send header every 10 frames for late receivers
      frameBytes = packetizer.createSessionHeaderFrame(sessionHeader)
    } else {
      const block: EncodedBlock = fountainGen.next().value
      frameBytes = packetizer.createDataFrame(block)
    }

    const audio = modem.encode(frameBytes)
    transmitter?.enqueueFrame(audio)
    liveSamples.value = audio.samples

    framesSent.value++
    bytesSent.value += frameBytes.length
  }, profileConfig.value.symbolDurationMs * 8)
}

function stopTransmission() {
  isTransmitting.value = false
  if (transmitInterval) {
    clearInterval(transmitInterval)
    transmitInterval = null
  }
  if (transmitter) {
    transmitter.stop()
    transmitter = null
  }
  liveSamples.value = null
}
</script>

<template>
  <div class="w-full flex flex-col gap-5">
    <!-- Transmission Stats Header -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 font-mono text-sm">
      <div>
        <span class="block text-xs text-neutral-400">Filename</span>
        <span class="truncate font-semibold text-neutral-200">{{ props.filename || 'File' }}</span>
      </div>
      <div>
        <span class="block text-xs text-neutral-400">Total K Blocks</span>
        <span class="font-semibold text-blue-400">{{ encoder?.k }}</span>
      </div>
      <div>
        <span class="block text-xs text-neutral-400">Profile</span>
        <span class="font-semibold text-emerald-400 capitalize">{{ props.profileKey }}</span>
      </div>
      <div>
        <span class="block text-xs text-neutral-400">Frames Sent</span>
        <span class="font-semibold text-purple-400">{{ framesSent }}</span>
      </div>
    </div>

    <!-- Real-time Audio Spectrum & Waveform -->
    <SpectrumVisualizer
      :samples="liveSamples"
      :active-freq-start="profileConfig.startFreq"
      :active-freq-end="profileConfig.endFreq"
    />

    <!-- Start / Stop Action Controls -->
    <div class="flex items-center justify-between gap-4 pt-2">
      <div class="flex items-center gap-2 text-sm text-neutral-400">
        <span class="inline-block h-2.5 w-2.5 rounded-full" :class="isTransmitting ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-600'" />
        <span>{{ isTransmitting ? 'Broadcasting audio stream...' : 'Ready to transmit' }}</span>
      </div>

      <button
        v-if="!isTransmitting"
        class="flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2.5 font-semibold text-white transition hover:bg-emerald-500 shadow"
        @click="startTransmission"
      >
        <span class="i-carbon-play-filled text-lg" />
        Start Transmission
      </button>
      <button
        v-else
        class="flex items-center gap-2 rounded-lg bg-red-600 px-6 py-2.5 font-semibold text-white transition hover:bg-red-500 shadow"
        @click="stopTransmission"
      >
        <span class="i-carbon-stop-filled text-lg" />
        Stop Transmission
      </button>
    </div>
  </div>
</template>
