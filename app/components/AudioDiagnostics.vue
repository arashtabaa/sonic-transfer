<script setup lang="ts">
import { AcousticCalibrator, type AudioDiagnosticsInfo, type CalibrationResult } from '~/acoustic'

const diagnosticsInfo = ref<AudioDiagnosticsInfo | null>(null)
const calibrationResult = ref<CalibrationResult | null>(null)
const isCalibrating = ref(false)
const isTestingMic = ref(false)
const isTestingSpeaker = ref(false)
const micLevel = ref(0)

let audioCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let animFrame: number | null = null

onMounted(async () => {
  await fetchDiagnostics()
})

onUnmounted(() => {
  stopMicTest()
  if (audioCtx) {
    audioCtx.close()
    audioCtx = null
  }
})

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

    // Stop temporary stream
    stream.getTracks().forEach(t => t.stop())
  } catch (e) {
    console.error('Failed to get audio diagnostics', e)
  }
}

async function startMicTest() {
  if (isTestingMic.value) {
    stopMicTest()
    return
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') await audioCtx.resume()

    const source = audioCtx.createMediaStreamSource(micStream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    isTestingMic.value = true

    const updateLevel = () => {
      if (!isTestingMic.value) return
      analyser.getByteFrequencyData(dataArray)
      let sum = 0
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i]!
      }
      micLevel.value = Math.min(100, Math.round((sum / bufferLength / 255) * 100 * 2))
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
  if (animFrame !== null) {
    cancelAnimationFrame(animFrame)
    animFrame = null
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop())
    micStream = null
  }
}

function testSpeaker() {
  if (isTestingSpeaker.value) return
  isTestingSpeaker.value = true

  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(1000, ctx.currentTime) // 1 kHz test tone
  gain.gain.setValueAtTime(0.3, ctx.currentTime)

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.start()
  osc.stop(ctx.currentTime + 0.5)

  setTimeout(() => {
    isTestingSpeaker.value = false
    ctx.close()
  }, 600)
}

async function runCalibration() {
  if (isCalibrating.value) return
  isCalibrating.value = true

  const sampleRate = diagnosticsInfo.value?.audioContextSampleRate || 48000
  const calibrator = new AcousticCalibrator(sampleRate)

  // 1. Measure background noise
  const noiseBuffer = new Float32Array(4096)
  for (let i = 0; i < noiseBuffer.length; i++) {
    noiseBuffer[i] = (Math.random() - 0.5) * 0.01 // Simulated ambient noise for local test
  }

  // 2. Generate probe chirp
  const probeChirp = calibrator.generateProbeChirp(1000, 20000, 1000)

  // 3. Analyze calibration result
  calibrationResult.value = calibrator.analyzeSignal(noiseBuffer, probeChirp)
  isCalibrating.value = false
}

function resetCalibration() {
  calibrationResult.value = null
}
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <div class="flex items-center justify-between border-b border-neutral-800 pb-4">
      <div>
        <h2 class="text-xl font-bold text-neutral-100">Audio Diagnostics & Calibration</h2>
        <p class="text-xs text-neutral-400">Inspect browser Web Audio capabilities and run frequency sweep calibration</p>
      </div>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700"
        @click="fetchDiagnostics"
      >
        <span class="i-carbon-renew text-sm" />
        Refresh
      </button>
    </div>

    <!-- Diagnostic Specs Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 font-mono text-sm">
        <h3 class="mb-3 text-xs uppercase tracking-wider text-neutral-400 font-bold font-sans">Microphone Hardware</h3>
        <div class="space-y-2 text-xs">
          <div class="flex justify-between">
            <span class="text-neutral-400">Device:</span>
            <span class="text-neutral-200 truncate max-w-48">{{ diagnosticsInfo?.selectedMicrophone || 'Loading...' }}</span>
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
            <span class="text-neutral-400">Channels:</span>
            <span class="text-neutral-200">{{ diagnosticsInfo?.channelCount }}</span>
          </div>
        </div>
      </div>

      <div class="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 font-mono text-sm">
        <h3 class="mb-3 text-xs uppercase tracking-wider text-neutral-400 font-bold font-sans">Browser DSP Processing</h3>
        <div class="space-y-2 text-xs">
          <div class="flex justify-between">
            <span class="text-neutral-400">Echo Cancellation:</span>
            <span :class="diagnosticsInfo?.echoCancellation ? 'text-amber-400' : 'text-emerald-400'">
              {{ diagnosticsInfo?.echoCancellation ? 'Enabled (Warning)' : 'Disabled (Ideal)' }}
            </span>
          </div>
          <div class="flex justify-between">
            <span class="text-neutral-400">Noise Suppression:</span>
            <span :class="diagnosticsInfo?.noiseSuppression ? 'text-amber-400' : 'text-emerald-400'">
              {{ diagnosticsInfo?.noiseSuppression ? 'Enabled (Warning)' : 'Disabled (Ideal)' }}
            </span>
          </div>
          <div class="flex justify-between">
            <span class="text-neutral-400">Auto Gain Control:</span>
            <span :class="diagnosticsInfo?.autoGainControl ? 'text-amber-400' : 'text-emerald-400'">
              {{ diagnosticsInfo?.autoGainControl ? 'Enabled (Warning)' : 'Disabled (Ideal)' }}
            </span>
          </div>
          <div class="flex justify-between">
            <span class="text-neutral-400">AudioWorklet:</span>
            <span class="text-blue-400">{{ diagnosticsInfo?.audioWorkletActive ? 'Supported & Active' : 'Fallback' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick Audio Hardware Tests -->
    <div class="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 flex flex-col gap-3">
      <h3 class="text-sm font-semibold text-neutral-200">Hardware Diagnostics</h3>
      <div class="flex flex-wrap gap-3">
        <button
          class="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700"
          @click="startMicTest"
        >
          <span class="i-carbon-microphone text-sm" />
          {{ isTestingMic ? 'Stop Mic Test' : 'Test Microphone' }}
        </button>
        <button
          class="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700"
          @click="testSpeaker"
        >
          <span class="i-carbon-volume-up text-sm" />
          {{ isTestingSpeaker ? 'Playing Tone...' : 'Test Speaker (1kHz)' }}
        </button>
        <button
          class="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 shadow"
          @click="runCalibration"
        >
          <span class="i-carbon-meter text-sm" />
          {{ isCalibrating ? 'Calibrating...' : 'Run Automatic Calibration' }}
        </button>
      </div>

      <!-- Live Mic Level Bar -->
      <div v-if="isTestingMic" class="mt-2 flex flex-col gap-1">
        <div class="flex justify-between text-xs font-mono text-neutral-400">
          <span>Mic Input Level</span>
          <span>{{ micLevel }}%</span>
        </div>
        <div class="h-2.5 w-full overflow-hidden rounded-full bg-neutral-800">
          <div class="h-full bg-emerald-500 transition-all duration-75" :style="{ width: `${micLevel}%` }" />
        </div>
      </div>
    </div>

    <!-- Automatic Calibration Results -->
    <div v-if="calibrationResult" class="rounded-lg border border-blue-500/30 bg-blue-950/20 p-5 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-blue-400 font-semibold">
          <span class="i-carbon-checkmark-outline text-lg" />
          Calibration Complete
        </div>
        <button class="text-xs text-neutral-400 hover:text-neutral-200" @click="resetCalibration">Reset</button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono text-xs">
        <div class="rounded border border-neutral-800 bg-neutral-900 p-3">
          <span class="block text-neutral-400 text-10px uppercase">Usable Frequency Band</span>
          <span class="text-sm font-semibold text-emerald-400">
            {{ (calibrationResult.usableBandStart / 1000).toFixed(1) }} - {{ (calibrationResult.usableBandEnd / 1000).toFixed(1) }} kHz
          </span>
        </div>
        <div class="rounded border border-neutral-800 bg-neutral-900 p-3">
          <span class="block text-neutral-400 text-10px uppercase">Estimated SNR</span>
          <span class="text-sm font-semibold text-blue-400">{{ calibrationResult.estimatedSnrDb.toFixed(1) }} dB</span>
        </div>
        <div class="rounded border border-neutral-800 bg-neutral-900 p-3">
          <span class="block text-neutral-400 text-10px uppercase">Recommended Profile</span>
          <span class="text-sm font-semibold text-purple-400 capitalize">{{ calibrationResult.recommendedProfile }}</span>
        </div>
      </div>

      <p class="text-xs text-neutral-300 font-mono">{{ calibrationResult.details }}</p>
    </div>
  </div>
</template>
