<script setup lang="ts">
const props = withDefaults(defineProps<{
  samples?: Float32Array | null
  activeFreqStart?: number
  activeFreqEnd?: number
  snrDb?: number
  height?: number
}>(), {
  samples: null,
  activeFreqStart: 2000,
  activeFreqEnd: 6000,
  snrDb: 20,
  height: 140,
})

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationFrameId: number | null = null

function render() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const width = canvas.width
  const height = canvas.height

  // Background
  ctx.fillStyle = '#18181b' // dark neutral
  ctx.fillRect(0, 0, width, height)

  // Draw grid lines
  ctx.strokeStyle = '#27272a'
  ctx.lineWidth = 1
  for (let x = 0; x < width; x += 40) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }

  // Highlight active frequency region band
  const bandStartRatio = Math.min(1, props.activeFreqStart / 24000)
  const bandEndRatio = Math.min(1, props.activeFreqEnd / 24000)
  const bandX1 = bandStartRatio * width
  const bandX2 = bandEndRatio * width

  ctx.fillStyle = 'rgba(59, 130, 246, 0.15)' // subtle blue band highlight
  ctx.fillRect(bandX1, 0, Math.max(2, bandX2 - bandX1), height)

  ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)'
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(bandX1, 0)
  ctx.lineTo(bandX1, height)
  ctx.moveTo(bandX2, 0)
  ctx.lineTo(bandX2, height)
  ctx.stroke()
  ctx.setLineDash([])

  // Render audio waveform or default signal baseline
  ctx.beginPath()
  ctx.strokeStyle = '#10b981' // emerald green signal
  ctx.lineWidth = 2

  const samples = props.samples
  if (samples && samples.length > 0) {
    const step = Math.ceil(samples.length / width)
    const centerY = height / 2

    for (let x = 0; x < width; x++) {
      const idx = x * step
      const val = samples[idx] || 0
      const y = centerY - val * (height / 2.2)

      if (x === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }
  } else {
    // Idle baseline line
    const centerY = height / 2
    ctx.moveTo(0, centerY)
    ctx.lineTo(width, centerY)
  }
  ctx.stroke()

  animationFrameId = requestAnimationFrame(render)
}

onMounted(() => {
  if (canvasRef.value) {
    canvasRef.value.width = canvasRef.value.clientWidth || 600
    canvasRef.value.height = props.height
  }
  render()
})

onUnmounted(() => {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
  }
})
</script>

<template>
  <div class="relative w-full overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow">
    <canvas ref="canvasRef" class="h-35 w-full block" />
    <div class="absolute bottom-2 left-3 flex gap-3 text-xs font-mono text-neutral-400">
      <span>Band: {{ (props.activeFreqStart / 1000).toFixed(1) }}k - {{ (props.activeFreqEnd / 1000).toFixed(1) }}kHz</span>
      <span>SNR: {{ props.snrDb.toFixed(1) }} dB</span>
    </div>
  </div>
</template>
