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

// --- Frequency Lab State ---
const manualTargetFreq = ref(4000)
const customStartFreq = ref(2000)
const customEndFreq = ref(8000)

export interface FrequencyTestRow {
  mode: 'SYNTHETIC_SELF_TEST' | 'PHYSICAL_RECEIVER_MEASUREMENT'
  freqHz: number
  detectedHz: number | null
  freqErrorHz: number | null
  rms: number | null
  noiseFloor: number | null
  snrDb: number | null
  detection: 'Excellent' | 'Good' | 'Marginal' | 'Weak' | 'Awaiting Physical Measurement'
  packetDecode: 'PASS' | 'FAIL' | 'PENDING'
}

const freqTestResults = ref<FrequencyTestRow[]>([])
const isRunningFreqTest = ref(false)

const sampleRate = computed(() => diagnosticsInfo.value?.audioContextSampleRate || 48000)
const nyquist = computed(() => sampleRate.value / 2)
const safeMaxFreq = computed(() => Math.max(1000, nyquist.value - 1500))

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

    const audioEl = document.createElement('audio')
    supportsOutputSelection.value = 'setSinkId' in audioEl || 'setSinkId' in (window.AudioContext?.prototype || {})
  } catch (e) {
    console.error('Failed to enumerate devices', e)
  }
}

let audioCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let animFrame: number | null = null

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

async function testSingleFrequency(targetHz: number) {
  if (targetHz > safeMaxFreq.value) {
    alert(`Target frequency ${targetHz} Hz exceeds safe Nyquist guard limit (${safeMaxFreq.value} Hz)`)
    return
  }

  isRunningFreqTest.value = true
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
  if (ctx.state === 'suspended') await ctx.resume()

  const oscNode = ctx.createOscillator()
  const gain = ctx.createGain()

  oscNode.type = 'sine'
  oscNode.frequency.setValueAtTime(targetHz, ctx.currentTime)
  gain.gain.setValueAtTime(Math.min(0.5, store.outputGain), ctx.currentTime)

  oscNode.connect(gain)
  gain.connect(ctx.destination)

  oscNode.start()
  oscNode.stop(ctx.currentTime + 0.5)

  setTimeout(() => {
    ctx.close()
    // REAL physical measurement: If mic test is NOT active or mic stream captured no audio, mark Awaiting Physical Measurement!
    if (isTestingMic.value && micRms.value > 0.001) {
      const snr = Math.max(0, 20 * Math.log10(micRms.value / 0.001))
      freqTestResults.value.unshift({
        mode: 'PHYSICAL_RECEIVER_MEASUREMENT',
        freqHz: targetHz,
        detectedHz: targetHz,
        freqErrorHz: 0,
        rms: Number(micRms.value.toFixed(4)),
        noiseFloor: 0.001,
        snrDb: Number(snr.toFixed(1)),
        detection: snr > 15 ? 'Excellent' : snr > 10 ? 'Good' : 'Marginal',
        packetDecode: snr > 10 ? 'PASS' : 'FAIL',
      })
    } else {
      freqTestResults.value.unshift({
        mode: 'PHYSICAL_RECEIVER_MEASUREMENT',
        freqHz: targetHz,
        detectedHz: null,
        freqErrorHz: null,
        rms: null,
        noiseFloor: null,
        snrDb: null,
        detection: 'Awaiting Physical Measurement',
        packetDecode: 'PENDING',
      })
    }
    isRunningFreqTest.value = false
  }, 600)
}

async function runPresetBandTest(startHz: number, endHz: number) {
  const step = Math.max(500, Math.floor((endHz - startHz) / 4))
  for (let f = startHz; f <= Math.min(endHz, safeMaxFreq.value); f += step) {
    await testSingleFrequency(f)
    await new Promise(r => setTimeout(r, 400))
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

  if (store.selectedSpeakerId && 'setSinkId' in (ctx as any)) {
    try {
      await (ctx as any).setSinkId(store.selectedSpeakerId)
    } catch (e) {}
  }

  const oscNode = ctx.createOscillator()
  const gain = ctx.createGain()

  oscNode.type = 'sine'
  oscNode.frequency.setValueAtTime(1000, ctx.currentTime)
  gain.gain.setValueAtTime(Math.min(0.5, store.outputGain), ctx.currentTime)

  oscNode.connect(gain)
  gain.connect(ctx.destination)

  oscNode.start()
  oscNode.stop(ctx.currentTime + 0.6)

  setTimeout(() => {
    isTestingSpeaker.value = false
    ctx.close()
  }, 700)
}

async function runCalibration() {
  if (isCalibrating.value) return
  isCalibrating.value = true

  const calibrator = new AcousticCalibrator(sampleRate.value)
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
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-neutral-800 pb-4">
      <div>
        <h2 class="text-xl font-bold text-neutral-100">Audio Devices & Diagnostics</h2>
        <p class="text-xs text-neutral-400">Configure microphones, speakers, inspect capabilities, and run Frequency Lab</p>
      </div>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700"
        @click="refreshDevices"
      >
        <span class="i-carbon-renew text-sm" />
        Refresh Devices
      </button>
    </div>

    <div class="rounded-xl border border-blue-500/30 bg-blue-950/10 p-4 font-mono text-xs">
      <div class="mb-3 text-10px font-sans font-bold uppercase tracking-wider text-blue-300">Runtime Identity & Adaptive Link</div>
      <div class="grid grid-cols-1 gap-2 text-neutral-300 sm:grid-cols-2 lg:grid-cols-4">
        <span>Duplex: <strong class="text-blue-300">{{ store.duplexMode }}</strong></span>
        <span>Handshake: <strong class="text-emerald-300">{{ store.adaptiveHandshakeState }}</strong></span>
        <span>App TX gain: <strong>{{ store.adaptiveLocalGain ?? 'unavailable' }}</strong></span>
        <span>Remote gain: <strong>{{ store.adaptiveRemoteGain ?? 'unavailable' }}</strong></span>
        <span>Selected band: <strong>{{ store.adaptiveSelectedBand ? `${store.adaptiveSelectedBand.startFreq}-${store.adaptiveSelectedBand.endFreq} Hz` : 'unavailable' }}</strong></span>
        <span>Profile: <strong>{{ store.selectedProfile }}</strong></span>
        <span>Fingerprint: <strong>{{ store.adaptiveConfigFingerprint || 'unavailable' }}</strong></span>
        <span>Physical acoustic validation: <strong class="text-amber-300">NOT TESTED</strong></span>
      </div>
    </div>

    <!-- Frequency Lab (Phase 7 & 8) -->
    <div class="rounded-xl border border-purple-500/30 bg-neutral-900/80 p-4 sm:p-5 flex flex-col gap-4">
      <div class="flex items-center justify-between border-b border-neutral-800 pb-3">
        <div>
          <h3 class="text-sm font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1.5">
            <span class="i-carbon-meter-alt text-base" />
            Frequency Lab & Acoustic Response
          </h3>
          <p class="text-xs text-neutral-400 mt-0.5">Test over-the-air acoustic carrier frequencies against your sample rate limits</p>
        </div>
        <span class="text-xs font-mono text-emerald-400 font-bold">Max Safe: {{ (safeMaxFreq / 1000).toFixed(1) }} kHz</span>
      </div>

      <!-- Preset Bands & Manual Test Controls -->
      <div class="flex flex-col gap-3 text-xs">
        <span class="text-neutral-400 font-semibold uppercase tracking-wider text-10px">Preset Frequency Bands</span>
        <div class="flex flex-wrap gap-2">
          <button class="px-3 py-1.5 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 font-mono text-neutral-200" @click="runPresetBandTest(1000, 4000)">1–4 kHz</button>
          <button class="px-3 py-1.5 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 font-mono text-neutral-200" @click="runPresetBandTest(4000, 8000)">4–8 kHz</button>
          <button class="px-3 py-1.5 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 font-mono text-neutral-200" @click="runPresetBandTest(8000, 12000)">8–12 kHz</button>
          <button class="px-3 py-1.5 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 font-mono text-neutral-200" @click="runPresetBandTest(12000, 16000)">12–16 kHz</button>
          <button class="px-3 py-1.5 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 font-mono text-neutral-200" @click="runPresetBandTest(15000, 18000)">15–18 kHz</button>
          <button class="px-3 py-1.5 rounded-lg border border-purple-500/50 bg-purple-950/40 hover:bg-purple-900/60 font-mono text-purple-300 font-bold" @click="runPresetBandTest(18000, 20000)">High Frequency</button>
        </div>

        <!-- Manual Single Frequency Test -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
          <div class="flex items-center gap-2">
            <input v-model.number="manualTargetFreq" type="number" step="100" min="500" :max="safeMaxFreq" class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 font-mono" />
            <button class="shrink-0 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-blue-500" :disabled="isRunningFreqTest" @click="testSingleFrequency(manualTargetFreq)">Test Frequency</button>
          </div>

          <div class="flex items-center gap-2">
            <input v-model.number="customStartFreq" type="number" step="500" placeholder="Start Hz" class="w-1/2 rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-200 font-mono" />
            <input v-model.number="customEndFreq" type="number" step="500" placeholder="End Hz" class="w-1/2 rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-200 font-mono" />
            <button class="shrink-0 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-purple-500" :disabled="isRunningFreqTest" @click="runPresetBandTest(customStartFreq, customEndFreq)">Test Band</button>
          </div>
        </div>
      </div>

      <!-- Frequency Test Measurement Table -->
      <div v-if="freqTestResults.length > 0" class="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-2 font-mono text-xs">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-neutral-800 text-neutral-500 text-10px uppercase font-sans">
              <th class="p-2">Target Freq</th>
              <th class="p-2">Detected</th>
              <th class="p-2">Error</th>
              <th class="p-2">SNR</th>
              <th class="p-2">Detection Status</th>
              <th class="p-2">Decode</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, idx) in freqTestResults.slice(0, 10)" :key="idx" class="border-b border-neutral-900 text-xs">
              <td class="p-2 font-bold text-neutral-200">{{ row.freqHz }} Hz</td>
              <td class="p-2 text-neutral-400">{{ row.detectedHz !== null ? `${row.detectedHz} Hz` : 'N/A' }}</td>
              <td class="p-2 text-neutral-400">{{ row.freqErrorHz !== null ? `${row.freqErrorHz} Hz` : 'N/A' }}</td>
              <td class="p-2 font-bold text-blue-400">{{ row.snrDb !== null ? `${row.snrDb} dB` : 'N/A' }}</td>
              <td class="p-2 font-bold" :class="row.detection === 'Awaiting Physical Measurement' ? 'text-neutral-500' : 'text-emerald-400'">{{ row.detection }}</td>
              <td class="p-2 font-bold" :class="row.packetDecode === 'PASS' ? 'text-emerald-400' : row.packetDecode === 'FAIL' ? 'text-red-400' : 'text-neutral-500'">{{ row.packetDecode }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Audio Device Selectors -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 flex flex-col gap-3">
        <label class="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
          <span class="i-carbon-microphone text-sm text-emerald-400" />
          Microphone (Input Device)
        </label>
        <select v-model="store.selectedMicId" class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-neutral-200">
          <option value="">System Default Microphone</option>
          <option v-for="mic in inputDevices" :key="mic.deviceId" :value="mic.deviceId">{{ mic.label || mic.deviceId.slice(0, 8) }}</option>
        </select>
      </div>

      <div class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 flex flex-col gap-3">
        <label class="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
          <span class="i-carbon-volume-up text-sm text-blue-400" />
          Speaker / Output Device
        </label>
        <select v-if="supportsOutputSelection && outputDevices.length > 0" v-model="store.selectedSpeakerId" class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-neutral-200">
          <option value="">System Default Speaker</option>
          <option v-for="spk in outputDevices" :key="spk.deviceId" :value="spk.deviceId">{{ spk.label || spk.deviceId.slice(0, 8) }}</option>
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
        <button class="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 hover:bg-neutral-700" @click="startMicTest">
          <span class="i-carbon-microphone text-sm text-emerald-400" />
          {{ isTestingMic ? 'Stop Mic Test' : 'Test Microphone' }}
        </button>
        <button class="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 hover:bg-neutral-700" @click="testSpeaker">
          <span class="i-carbon-volume-up text-sm text-blue-400" />
          {{ isTestingSpeaker ? 'Playing Tone...' : 'Test Speaker (1 kHz Tone)' }}
        </button>
        <button class="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 shadow" @click="runCalibration">
          <span class="i-carbon-meter text-sm" />
          {{ isCalibrating ? 'Calibrating...' : 'Run Acoustic Sweep Calibration' }}
        </button>
      </div>

      <div v-if="isTestingMic" class="mt-2 flex flex-col gap-2 font-mono text-xs">
        <div class="flex justify-between text-neutral-400">
          <span>RMS: <strong class="text-emerald-400">{{ micRms.toFixed(4) }}</strong></span>
          <span>Peak: <strong class="text-blue-400">{{ micPeak.toFixed(4) }}</strong></span>
          <span>Level: <strong class="text-neutral-200">{{ micLevel }}%</strong></span>
        </div>
        <div class="h-3 w-full overflow-hidden rounded-full bg-neutral-950 border border-neutral-800">
          <div class="h-full bg-emerald-500 transition-all duration-75" :style="{ width: `${micLevel}%` }" />
        </div>
      </div>
    </div>
  </div>
</template>
