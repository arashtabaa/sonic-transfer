export interface FrequencyProbeOptions {
  sampleRate: number
  frequenciesHz: number[]
  toneDurationMs?: number
  guardMs?: number
  gain?: number
}

export interface RenderedFrequencyProbe { samples: Float32Array; sampleRate: number; frequenciesHz: number[]; toneSamples: number; guardSamples: number }

export class FrequencyProbeRenderer {
  render(options: FrequencyProbeOptions): RenderedFrequencyProbe {
    const toneSamples = Math.max(1, Math.round(options.sampleRate * (options.toneDurationMs ?? 80) / 1000))
    const guardSamples = Math.max(0, Math.round(options.sampleRate * (options.guardMs ?? 20) / 1000))
    const frequenciesHz = options.frequenciesHz.filter(f => Number.isFinite(f) && f > 0 && f <= options.sampleRate / 2 - 1500)
    const samples = new Float32Array(frequenciesHz.length * (toneSamples + guardSamples))
    const gain = Math.min(0.5, Math.max(0, options.gain ?? 0.25))
    frequenciesHz.forEach((frequency, index) => {
      const offset = index * (toneSamples + guardSamples)
      for (let sample = 0; sample < toneSamples; sample++) samples[offset + sample] = gain * Math.sin(2 * Math.PI * frequency * sample / options.sampleRate)
    })
    return { samples, sampleRate: options.sampleRate, frequenciesHz, toneSamples, guardSamples }
  }
}
