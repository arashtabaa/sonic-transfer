import type { FrequencyMeasurementPayload } from '../protocol/frame'

export interface FrequencyProbeAnalysisOptions {
  sampleRate: number
  frequenciesHz: number[]
  toneDurationMs: number
  guardMs: number
  timingToleranceMs?: number
  clippingThreshold?: number
}

export class FrequencyProbeAnalyzer {
  constructor(private readonly options: FrequencyProbeAnalysisOptions) {}

  analyze(samples: Float32Array, initialOffset = 0): FrequencyMeasurementPayload[] {
    const toneSamples = Math.round(this.options.sampleRate * this.options.toneDurationMs / 1000)
    const guardSamples = Math.round(this.options.sampleRate * this.options.guardMs / 1000)
    const stride = toneSamples + guardSamples
    const tolerance = Math.round(this.options.sampleRate * (this.options.timingToleranceMs ?? 12) / 1000)
    return this.options.frequenciesHz.map((frequency, index) => {
      const expected = initialOffset + index * stride
      const offset = this.findBestOffset(samples, expected, toneSamples, frequency, tolerance)
      const signal = samples.subarray(Math.max(0, offset), Math.min(samples.length, offset + toneSamples))
      const guardStart = Math.max(0, offset - guardSamples)
      const noise = guardSamples > 0 ? samples.subarray(guardStart, Math.min(samples.length, guardStart + guardSamples)) : new Float32Array(0)
      const signalRms = rms(signal)
      const noiseRms = noise.length ? rms(noise) : null
      const snrDb = noiseRms !== null && noiseRms > 1e-9 ? 20 * Math.log10(Math.max(signalRms, 1e-9) / noiseRms) : null
      const peak = maxAbs(signal)
      const clippingFraction = signal.length ? Array.from(signal).filter(value => Math.abs(value) >= (this.options.clippingThreshold ?? 0.98)).length / signal.length : 0
      const clipped = clippingFraction > 0.01
      return { frequencyHz: frequency, signalRms, noiseRms, snrDb, peak, usable: !clipped && signalRms > 1e-4 && (snrDb === null || snrDb >= 8), clipped }
    })
  }

  private findBestOffset(samples: Float32Array, expected: number, length: number, frequency: number, tolerance: number): number {
    let bestOffset = expected
    let bestEnergy = -Infinity
    for (let delta = -tolerance; delta <= tolerance; delta += Math.max(1, Math.floor(this.options.sampleRate / 4000))) {
      const offset = expected + delta
      if (offset < 0 || offset + length > samples.length) continue
      const energy = correlationEnergy(samples, offset, length, frequency, this.options.sampleRate)
      if (energy > bestEnergy) { bestEnergy = energy; bestOffset = offset }
    }
    return Math.max(0, bestOffset)
  }
}

export class StreamingFrequencyProbeAnalyzer {
  private chunks: Float32Array[] = []
  private length = 0
  constructor(private readonly analyzer: FrequencyProbeAnalyzer) {}
  pushSamples(samples: Float32Array): void { this.chunks.push(new Float32Array(samples)); this.length += samples.length }
  analyze(initialOffset = 0): FrequencyMeasurementPayload[] {
    const merged = new Float32Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) { merged.set(chunk, offset); offset += chunk.length }
    return this.analyzer.analyze(merged, initialOffset)
  }
  reset(): void { this.chunks = []; this.length = 0 }
}

function correlationEnergy(samples: Float32Array, offset: number, length: number, frequency: number, sampleRate: number): number {
  let re = 0
  let im = 0
  for (let i = 0; i < length; i++) {
    const phase = 2 * Math.PI * frequency * i / sampleRate
    re += samples[offset + i]! * Math.cos(phase)
    im += samples[offset + i]! * Math.sin(phase)
  }
  return Math.hypot(re, im)
}

function rms(samples: Float32Array): number { return samples.length ? Math.sqrt(Array.from(samples).reduce((sum, value) => sum + value * value, 0) / samples.length) : 0 }
function maxAbs(samples: Float32Array): number { return samples.length ? Math.max(...Array.from(samples).map(Math.abs)) : 0 }
