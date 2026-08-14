export interface SyntheticChannelConfig {
  snrDb?: number
  gain?: number
  frequencyOffsetHz?: number
  clockDriftPpm?: number
  delaySamples?: number
  echo?: { delaySamples: number; gain: number }
  dropoutMs?: number
  impulseCount?: number
  impulseAmplitude?: number
}

export interface SyntheticChannelInput {
  pcm: Float32Array
  sampleRate: number
  seed: number
  impairment?: SyntheticChannelConfig
}

/** Deterministic diagnostic channel. It is intentionally not a physical-room model. */
export function applySyntheticChannel({ pcm, sampleRate, seed, impairment = {} }: SyntheticChannelInput): Float32Array {
  const gain = impairment.gain ?? 1
  const drift = 1 + (impairment.clockDriftPpm ?? 0) / 1_000_000
  // A fixed nominal carrier keeps this test-only pitch warp deterministic; the modem's
  // carrier-bank decoder experiences it as a frequency offset across the band.
  const frequencyWarp = 1 + (impairment.frequencyOffsetHz ?? 0) / 4000
  const delay = Math.max(0, Math.round(impairment.delaySamples ?? 0))
  const outputLength = pcm.length + delay
  const output = new Float32Array(outputLength)
  for (let i = 0; i < pcm.length; i++) {
    const sourceIndex = i / (drift * frequencyWarp)
    const left = Math.floor(sourceIndex)
    const fraction = sourceIndex - left
    const sample = left + 1 < pcm.length ? pcm[left]! * (1 - fraction) + pcm[left + 1]! * fraction : pcm[Math.min(left, pcm.length - 1)] || 0
    const destination = i + delay
    output[destination] = sample * gain
    if (impairment.echo && destination + impairment.echo.delaySamples < output.length) {
      output[destination + impairment.echo.delaySamples]! += sample * gain * impairment.echo.gain
    }
  }

  const random = seededRandom(seed)
  const noiseRms = impairment.snrDb === undefined ? 0 : rms(output) / Math.pow(10, impairment.snrDb / 20)
  for (let i = 0; i < output.length; i++) output[i] = clamp(output[i]! + gaussian(random) * noiseRms)

  if (impairment.dropoutMs) {
    const width = Math.round(sampleRate * impairment.dropoutMs / 1000)
    const start = Math.max(0, Math.floor(output.length / 2) - Math.floor(width / 2))
    output.fill(0, start, Math.min(output.length, start + width))
  }
  const impulseCount = impairment.impulseCount ?? 0
  const impulseAmplitude = impairment.impulseAmplitude ?? 1
  for (let i = 0; i < impulseCount; i++) output[Math.floor(random() * output.length)] = (random() * 2 - 1) * impulseAmplitude
  return output
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function gaussian(random: () => number): number {
  const u = Math.max(Number.EPSILON, random())
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / (samples.length || 1))
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value))
}
