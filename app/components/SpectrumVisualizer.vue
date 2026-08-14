<script setup lang="ts">
import { FFT, applyWindow } from '~/acoustic'

const props = withDefaults(defineProps<{
  samples?: Float32Array | null
  active?: boolean
  sampleRate?: number
  activeFreqStart?: number
  activeFreqEnd?: number
  snrDb?: number | null
  height?: number
}>(), {
  samples: null,
  active: false,
  sampleRate: 48000,
  activeFreqStart: 2000,
  activeFreqEnd: 6000,
  snrDb: null,
  height: 140,
})

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationFrameId: number | null = null
let lastRenderAt = 0
const FFT_SIZE = 512

function stopLoop() {
  if (animationFrameId !== null) cancelAnimationFrame(animationFrameId)
  animationFrameId = null
}

function drawSpectrum() {
  animationFrameId = null
  if (!props.active || (typeof document !== 'undefined' && document.hidden)) return
  const canvas = canvasRef.value
  if (!canvas) return
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (now - lastRenderAt < 80) {
    animationFrameId = requestAnimationFrame(drawSpectrum)
    return
  }
  lastRenderAt = now
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const width = canvas.width
  const height = canvas.height
  ctx.fillStyle = '#18181b'
  ctx.fillRect(0, 0, width, height)

  const nyquist = props.sampleRate / 2
  const bandX1 = Math.max(0, Math.min(width, props.activeFreqStart / nyquist * width))
  const bandX2 = Math.max(0, Math.min(width, props.activeFreqEnd / nyquist * width))
  ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'
  ctx.fillRect(bandX1, 0, Math.max(2, bandX2 - bandX1), height)

  ctx.strokeStyle = '#27272a'
  ctx.lineWidth = 1
  ctx.font = '10px monospace'
  ctx.fillStyle = '#71717a'
  for (let hz = 0; hz <= nyquist; hz += 5000) {
    const x = hz / nyquist * width
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height - 18); ctx.stroke()
    ctx.fillText(hz >= 1000 ? `${Math.round(hz / 1000)}k` : '0', Math.min(width - 24, x + 2), height - 4)
  }

  const samples = props.samples
  const window = new Float32Array(FFT_SIZE)
  if (samples?.length) window.set(samples.subarray(Math.max(0, samples.length - FFT_SIZE)))
  const windowed = applyWindow(window, 'hann')
  const real = new Float32Array(windowed)
  const imag = new Float32Array(FFT_SIZE)
  new FFT(FFT_SIZE).transform(real, imag)
  ctx.beginPath()
  ctx.strokeStyle = '#10b981'
  ctx.lineWidth = 2
  for (let bin = 0; bin < FFT_SIZE / 2; bin++) {
    const magnitude = Math.sqrt(real[bin]! * real[bin]! + imag[bin]! * imag[bin]!) / FFT_SIZE
    const x = bin / (FFT_SIZE / 2 - 1) * width
    const y = height - 20 - Math.min(height - 24, magnitude * height * 8)
    if (bin === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.fillStyle = '#a1a1aa'
  ctx.fillText(`0 Hz — ${(nyquist / 1000).toFixed(1)} kHz`, 8, 12)
  ctx.fillText(`SNR: ${props.snrDb === null || props.snrDb === undefined ? 'unavailable' : `${props.snrDb.toFixed(1)} dB`}`, Math.max(8, width - 145), 12)
  animationFrameId = requestAnimationFrame(drawSpectrum)
}

function startLoop() {
  stopLoop()
  if (props.active) animationFrameId = requestAnimationFrame(drawSpectrum)
}

function onVisibilityChange() {
  if (document.hidden) stopLoop()
  else startLoop()
}

watch(() => props.active, startLoop)
onMounted(() => {
  if (canvasRef.value) {
    canvasRef.value.width = canvasRef.value.clientWidth || 600
    canvasRef.value.height = props.height
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  startLoop()
})
onUnmounted(() => {
  stopLoop()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="relative w-full overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow">
    <canvas ref="canvasRef" class="block h-35 w-full" />
    <div class="absolute bottom-2 left-3 text-xs font-mono text-neutral-400">
      0 Hz → Nyquist · {{ props.snrDb === null || props.snrDb === undefined ? 'SNR: unavailable' : `SNR: ${props.snrDb.toFixed(1)} dB` }}
    </div>
  </div>
</template>
