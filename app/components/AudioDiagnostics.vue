<script setup lang="ts">
import { AcousticCalibrator, type AudioDiagnosticsInfo, type CalibrationResult } from '~/acoustic'
import { useAcousticSessionStore } from '~/stores/acousticSession'

const store = useAcousticSessionStore()

const diagnosticsInfo = ref<AudioDiagnosticsInfo | null>(null)
const calibrationResult = ref<CalibrationResult | null>(null)
const isCalibrating = ref(false)
const isTestingMic = ref(false)
const isTestingSpeaker = ref(false)

const inputDevices = ref<MediaDeviceInfo[]>([])
const outputDevices = ref<MediaDeviceInfo[]>([])
const supportsOutputSelection = ref(false)

const micLevel = ref(0)
const micPeak = ref(0)
const micRms = ref(0)

let audioCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let animFrame: number | null = null

onMounted(async () => {
  await refreshDevices()
  await fetchDiagnostics()
  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
  }
})

onUnmounted(() => {
  stopMicTest()
  if (navigator.mediaDevices) {
    navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
  }
  if (audioCtx) {
    audioCtx.close()
    audioCtx = null
  }
})

async function refreshDevices() {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    inputDevices.value = devices.filter(d => d.kind === 'audioinput')
    outputDevices.value = devices.filter(d => d.kind === 'audiooutput')

    // Check setSinkId capability
    const audioEl = document.createElement('audio')
    supportsOutputSelection.value = 'setSinkId' in audioEl || 'setSinkId' in (window.AudioContext?.prototype || {})
  } catch (e) {
    console.error('Failed to enumerate devices', e)
  }
}

async function fetchDiagnostics() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    const track = stream.getAudioTracks()[0]!
    const settings = track.getSettings()

    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()

    diagnosticsInfo.value = {
      inputSampleRate: settings.sampleRate || audioCtx.sampleRate,
      audioContextSampleRate: audioCtx.sampleRate,
      channelCount: settings.channelCount || 1,
      echoCancellation: settings.echoCancellation ?? false,
      noiseSuppression: settings.noiseSuppression ?? false,
      autoGainControl: settings.autoGainControl ?? false,
      selectedMicrophone: track.label || 'Default Microphone',
      audioWorkletActive: !!audioCtx.audioWorklet,
    }

    stream.getTracks().forEach(t => t.stop())
  } catch (e) {
    console.error('Failed to fetch audio diagnostics', e)
  }
}

async function startMicTest() {
  if (isTestingMic.value) {
    stopMicTest()
    return
  }

  try {
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: store.selectedMicId ? { exact: store.selectedMicId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    }

    micStream = await navigator.mediaDevices.getUserMedia(constraints)
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') await audioCtx.resume()

    const source = audioCtx.createMediaStreamSource(micStream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)

    const dataArray = new Float32Array(analyser.fftSize)
    isTestingMic.value = true

    const updateLevel = () => {
      if (!isTestingMic.value) return
      analyser.getFloatTimeDomainData(dataArray)

      let sum = 0
      let max = 0
      for (let i = 0; i < dataArray.length; i++) {
        const val = dataArray[i]!
        const abs = Math.abs(val)
        sum += val * val
        if (abs > max) max = abs
      }

      const rms = Math.sqrt(sum / dataArray.length)
      micRms.value = rms
      micPeak.value = max
      micLevel.value = Math.min(100, Math.round(rms * 200))

      animFrame = requestAnimationFrame(updateLevel)
    }

    updateLevel()
  } catch (e) {
    console.error('Mic test failed', e)
  }
}

function stopMicTest() {
  isTestingMic.value = false
  micLevel.value = 0
  micPeak.value = 0
  micRms.value = 0
  if (animFrame !== null) {
    cancelAnimationFrame(animFrame)
    animFrame = null
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop())
    micStream = null
  }
}

async function testSpeaker() {
  if (isTestingSpeaker.value) return
  isTestingSpeaker.value = true

  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
  if (ctx.state === 'suspended') await ctx.resume()

  // Attempt setSinkId if supported
  if (store.selectedSpeakerId && 'setSinkId' in (ctx as any)) {
    try {
      await (ctx as any).setSinkId(store.selectedSpeakerId)
    } catch (e) {
      console.warn('AudioContext setSinkId fallback', e)
    }
  }

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(1000, ctx.currentTime) // 1 kHz test tone
  gain.gain.setValueAtTime(Math.min(0.5, store.outputGain), ctx.currentTime)

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.start()
  osc.stop(ctx.currentTime + 0.6)

  setTimeout(() => {
    isTestingSpeaker.value = false
    ctx.close()
  }, 700)
}

async function runCalibration() {
  if (isCalibrating.value) return
  isCalibrating.value = true

  const sampleRate = diagnosticsInfo.value?.audioContextSampleRate || 48000
  const calibrator = new AcousticCalibrator(sampleRate)

  const noiseBuffer = new Float32Array(4096)
  for (let i = 0; i < noiseBuffer.length; i++) {
    noiseBuffer[i] = (Math.random() - 0.5) * 0.01
  }

  const probeChirp = calibrator.generateProbeChirp(1000, 18000, 1000)
  calibrationResult.value = calibrator.analyzeSignal(noiseBuffer, probeChirp)
  isCalibrating.value = false
}
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <div class="flex items-center justify-between border-b border-neutral-800 pb-4">
      <div>
        <h2 class="text-xl font-bold text-neutral-100">Audio Devices & Diagnostics</h2>
        <p class="text-xs text-neutral-400">Configure microphones, speakers, and inspect audio context capabilities</p>
      </div>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700"
        @click="refreshDevices"
      >
        <span class="i-carbon-renew text-sm" />
        Refresh Devices
      </button>
    </div>

    <!-- Audio Device Selectors -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 flex flex-col gap-3">
        <label class="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
          <span class="i-carbon-microphone text-sm text-emerald-400" />
          Microphone (Input Device)
        </label>
        <select
          v-model="store.selectedMicId"
          class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-blue-500"
        >
          <option value="">System Default Microphone</option>
          <option v-for="mic in inputDevices" :key="mic.deviceId" :value="mic.deviceId">
            {{ mic.label || `Microphone ${mic.deviceId.slice(0, 5)}...` }}
          </option>
        </select>
      </div>

      <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 flex flex-col gap-3">
        <label class="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
          <span class="i-carbon-volume-up text-sm text-blue-400" />
          Speaker / Output Device
        </label>
        <select
          v-if="supportsOutputSelection && outputDevices.length > 0"
          v-model="store.selectedSpeakerId"
          class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-blue-500"
        >
          <option value="">System Default Speaker</option>
          <option v-for="spk in outputDevices" :key="spk.deviceId" :value="spk.deviceId">
            {{ spk.label || `Speaker ${spk.deviceId.slice(0, 5)}...` }}
          </option>
        </select>
        <div v-else class="text-xs text-neutral-400 bg-neutral-950 p-2.5 rounded-lg border border-neutral-800 font-mono">
          Output device selection is not supported by this browser. Using system default output.
        </div>
      </div>
    </div>

    <!-- Hardware Quick Tests -->
    <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 flex flex-col gap-3">
      <h3 class="text-sm font-semibold text-neutral-200">Hardware Verification Tools</h3>
      <div class="flex flex-wrap gap-3">
        <button
          class="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700"
          @click="startMicTest"
        >
          <span class="i-carbon-microphone text-sm text-emerald-400" />
          {{ isTestingMic ? 'Stop Mic Test' : 'Test Microphone' }}
        </button>
        <button
          class="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700"
          @click="testSpeaker"
        >
          <span class="i-carbon-volume-up text-sm text-blue-400" />
          {{ isTestingSpeaker ? 'Playing Tone...' : 'Test Speaker (1 kHz Tone)' }}
        </button>
        <button
          class="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 shadow"
          @click="runCalibration"
        >
          <span class="i-carbon-meter text-sm" />
          {{ isCalibrating ? 'Calibrating...' : 'Run Acoustic Sweep Calibration' }}
        </button>
      </div>

      <!-- Live Mic Level & RMS Bar -->
      <div v-if="isTestingMic" class="mt-2 flex flex-col gap-2 font-mono text-xs">
        <div class="flex justify-between text-neutral-400">
          <span>Input RMS: <strong class="text-emerald-400">{{ micRms.toFixed(4) }}</strong></span>
          <span>Peak: <strong class="text-blue-400">{{ micPeak.toFixed(4) }}</strong></span>
          <span>Level: <strong class="text-neutral-200">{{ micLevel }}%</strong></span>
        </div>
        <div class="h-3 w-full overflow-hidden rounded-full bg-neutral-950 border border-neutral-800">
          <div class="h-full bg-emerald-500 transition-all duration-75" :style="{ width: `${micLevel}%` }" />
        </div>
      </div>
    </div>

    <!-- Diagnostic Specs Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 font-mono text-xs space-y-2">
        <h3 class="mb-3 text-xs uppercase tracking-wider text-neutral-400 font-bold font-sans">Microphone Hardware Info</h3>
        <div class="flex justify-between">
          <span class="text-neutral-400">Selected Device:</span>
          <span class="text-neutral-200 truncate max-w-44">{{ diagnosticsInfo?.selectedMicrophone }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-400">Input Sample Rate:</span>
          <span class="text-emerald-400">{{ diagnosticsInfo?.inputSampleRate }} Hz</span>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-400">AudioContext Rate:</span>
          <span class="text-emerald-400">{{ diagnosticsInfo?.audioContextSampleRate }} Hz</span>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-400">Channel Count:</span>
          <span class="text-neutral-200">{{ diagnosticsInfo?.channelCount }}</span>
        </div>
      </div>

      <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 font-mono text-xs space-y-2">
        <h3 class="mb-3 text-xs uppercase tracking-wider text-neutral-400 font-bold font-sans">Browser Audio DSP Constraints</h3>
        <div class="flex justify-between">
          <span class="text-neutral-400">Echo Cancellation:</span>
          <span :class="diagnosticsInfo?.echoCancellation ? 'text-amber-400' : 'text-emerald-400'">
            {{ diagnosticsInfo?.echoCancellation ? 'Enabled' : 'Disabled (Ideal)' }}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-400">Noise Suppression:</span>
          <span :class="diagnosticsInfo?.noiseSuppression ? 'text-amber-400' : 'text-emerald-400'">
            {{ diagnosticsInfo?.noiseSuppression ? 'Enabled' : 'Disabled (Ideal)' }}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-400">Auto Gain Control:</span>
          <span :class="diagnosticsInfo?.autoGainControl ? 'text-amber-400' : 'text-emerald-400'">
            {{ diagnosticsInfo?.autoGainControl ? 'Enabled' : 'Disabled (Ideal)' }}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-400">AudioWorklet Status:</span>
          <span class="text-blue-400">{{ diagnosticsInfo?.audioWorkletActive ? 'Active' : 'Fallback' }}</span>
        </div>
      </div>
    </div>

    <!-- Calibration Results -->
    <div v-if="calibrationResult" class="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4 flex flex-col gap-3 font-mono text-xs">
      <div class="flex items-center justify-between font-sans">
        <span class="font-bold text-blue-400">Calibration Complete</span>
        <button class="text-neutral-400 hover:text-neutral-200" @click="calibrationResult = null">Clear</button>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="rounded border border-neutral-800 bg-neutral-900 p-3">
          <span class="text-neutral-400 text-10px uppercase">Usable Band</span>
          <span class="block text-sm font-bold text-emerald-400 mt-1">
            {{ (calibrationResult.usableBandStart / 1000).toFixed(1) }} - {{ (calibrationResult.usableBandEnd / 1000).toFixed(1) }} kHz
          </span>
        </div>
        <div class="rounded border border-neutral-800 bg-neutral-900 p-3">
          <span class="text-neutral-400 text-10px uppercase">Estimated SNR</span>
          <span class="block text-sm font-bold text-blue-400 mt-1">{{ calibrationResult.estimatedSnrDb.toFixed(1) }} dB</span>
        </div>
        <div class="rounded border border-neutral-800 bg-neutral-900 p-3">
          <span class="text-neutral-400 text-10px uppercase">Recommended Profile</span>
          <span class="block text-sm font-bold text-purple-400 capitalize mt-1">{{ calibrationResult.recommendedProfile }}</span>
        </div>
      </div>
      <p class="text-neutral-300">{{ calibrationResult.details }}</p>
    </div>
  </div>
</template>
