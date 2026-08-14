import { decodeFrame, type AcousticFrame } from '../protocol/frame'

export interface PilotMultitoneConfig {
  sampleRate: number
  startFreq: number
  endFreq: number
  carrierCount: 4 | 8 | 12 | 16
  symbolDurationMs: 5 | 10 | 15
  guardMs: number
  gain: number
  pilotInterval: 8 | 16 | 32
}

export interface CarrierDiagnostic {
  frequency: number
  referenceMagnitude: number
  phaseRadians: number
  noiseEstimate: number
  confidence: number
  usable: boolean
}

export interface PilotSymbolDiagnostic {
  magnitudes: number[]
  normalizedMagnitudes: number[]
  decisions: number[]
  confidence: number
  noiseEstimate: number
  hammingWeight: number
  peakPcm: number
}

const PREAMBLE_SIGNS = [1, -1, 1, -1]
const FRAME_GAP_SYMBOLS = 2

export class PilotMultitoneModem {
  readonly samplesPerSymbol: number
  readonly guardSamples: number
  readonly stride: number
  readonly carrierFrequencies: number[]

  constructor(public readonly config: PilotMultitoneConfig) {
    this.samplesPerSymbol = Math.round(config.sampleRate * config.symbolDurationMs / 1000)
    this.guardSamples = Math.round(config.sampleRate * config.guardMs / 1000)
    this.stride = this.samplesPerSymbol + this.guardSamples
    this.carrierFrequencies = Array.from({ length: config.carrierCount }, (_, i) => config.startFreq + (config.endFreq - config.startFreq) * (i + 0.5) / config.carrierCount)
  }

  encode(packet: Uint8Array): { samples: Float32Array; durationMs: number } {
    const bits = bytesToBits(packet)
    const dataSymbols = Math.ceil(bits.length / this.config.carrierCount)
    const pilotCount = Math.floor(Math.max(0, dataSymbols - 1) / this.config.pilotInterval)
    const symbols = PREAMBLE_SIGNS.length + dataSymbols + pilotCount + FRAME_GAP_SYMBOLS
    const samples = new Float32Array(symbols * this.stride)
    let symbol = 0
    for (const sign of PREAMBLE_SIGNS) this.renderSymbol(samples, symbol++ * this.stride, this.carrierFrequencies.map(() => sign))
    for (let data = 0; data < dataSymbols; data++) {
      if (data > 0 && data % this.config.pilotInterval === 0) this.renderSymbol(samples, symbol++ * this.stride, this.carrierFrequencies.map(() => 1))
      const signs = this.carrierFrequencies.map((_, carrier) => bits[data * this.config.carrierCount + carrier] === 1 ? -1 : 1)
      this.renderSymbol(samples, symbol++ * this.stride, signs)
    }
    symbol += FRAME_GAP_SYMBOLS
    return { samples, durationMs: samples.length / this.config.sampleRate * 1000 }
  }

  analyzeSymbol(samples: Float32Array, offset: number, channel?: CarrierDiagnostic[]): PilotSymbolDiagnostic | null {
    if (offset < 0 || offset + this.samplesPerSymbol > samples.length) return null
    const correlations = this.carrierFrequencies.map(f => correlate(samples, offset, this.samplesPerSymbol, f, this.config.sampleRate))
    const magnitudes = correlations.map(z => Math.hypot(z.re, z.im))
    const reference = channel?.map(c => Math.max(c.referenceMagnitude, 1e-9)) || magnitudes.map(value => Math.max(value, 1e-9))
    const normalizedMagnitudes = magnitudes.map((value, i) => value / reference[i]!)
    const decisions = correlations.map((z, i) => {
      const h = channel?.[i]
      const equalized = h ? complexDivide(z, { re: h.referenceMagnitude * Math.cos(h.phaseRadians), im: h.referenceMagnitude * Math.sin(h.phaseRadians) }) : z
      return equalized.re < 0 ? 1 : 0
    })
    const noiseEstimate = median(magnitudes) * 0.15
    return { magnitudes, normalizedMagnitudes, decisions, confidence: Math.min(...magnitudes) / Math.max(noiseEstimate, 1e-9), noiseEstimate, hammingWeight: decisions.reduce((a, b) => a + b, 0 as number), peakPcm: Math.max(...Array.from(samples.subarray(offset, offset + this.samplesPerSymbol)).map(Math.abs)) }
  }

  estimateChannel(samples: Float32Array, offset: number): CarrierDiagnostic[] {
    const first = this.analyzeRaw(samples, offset)
    const second = this.analyzeRaw(samples, offset + this.stride)
    return first.map((z, i) => {
      const estimate = { re: (z.re - second[i]!.re) / 2, im: (z.im - second[i]!.im) / 2 }
      const magnitude = Math.hypot(estimate.re, estimate.im)
      return { frequency: this.carrierFrequencies[i]!, referenceMagnitude: magnitude, phaseRadians: Math.atan2(estimate.im, estimate.re), noiseEstimate: Math.hypot((z.re + second[i]!.re) / 2, (z.im + second[i]!.im) / 2), confidence: magnitude / Math.max(Math.hypot((z.re + second[i]!.re) / 2, (z.im + second[i]!.im) / 2), 1e-9), usable: magnitude > 1e-5 }
    })
  }

  private analyzeRaw(samples: Float32Array, offset: number) { return this.carrierFrequencies.map(f => correlate(samples, offset, this.samplesPerSymbol, f, this.config.sampleRate)) }

  private renderSymbol(target: Float32Array, offset: number, signs: number[]): void {
    const amplitude = this.config.gain / this.config.carrierCount
    for (let sample = 0; sample < this.samplesPerSymbol; sample++) {
      const t = sample / this.config.sampleRate
      let value = 0
      for (let carrier = 0; carrier < signs.length; carrier++) value += signs[carrier]! * Math.cos(2 * Math.PI * this.carrierFrequencies[carrier]! * t) * amplitude
      target[offset + sample] = value
    }
  }
}

export class PilotMultitoneStreamDecoder {
  private buffer = new Float32Array(0)
  constructor(private readonly modem: PilotMultitoneModem) {}

  pushSamples(samples: Float32Array): AcousticFrame[] {
    const merged = new Float32Array(this.buffer.length + samples.length); merged.set(this.buffer); merged.set(samples, this.buffer.length); this.buffer = merged
    const frames: AcousticFrame[] = []
    while (true) {
      const start = this.findPreamble()
      if (start < 0) { this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - this.modem.stride * 6)); break }
      const parsed = this.tryDecode(start)
      if (!parsed) break
      if (parsed.frame) frames.push(parsed.frame)
      this.buffer = this.buffer.slice(start + parsed.consumed)
    }
    return frames
  }

  reset(): void { this.buffer = new Float32Array(0) }

  private findPreamble(): number {
    const need = this.modem.stride * (PREAMBLE_SIGNS.length + 2)
    for (let offset = 0; offset <= this.buffer.length - need; offset += 2) {
      const channel = this.modem.estimateChannel(this.buffer, offset)
      if (channel.some(c => !c.usable)) continue
      let valid = true
      for (let i = 0; i < PREAMBLE_SIGNS.length; i++) {
        const d = this.modem.analyzeSymbol(this.buffer, offset + i * this.modem.stride, channel)
        if (!d || d.confidence < 1.5 || d.decisions.some(bit => (bit === 1 ? -1 : 1) !== PREAMBLE_SIGNS[i])) { valid = false; break }
      }
      if (valid) return offset
    }
    return -1
  }

  private tryDecode(start: number): { frame: AcousticFrame | null; consumed: number } | null {
    const channel = this.modem.estimateChannel(this.buffer, start)
    const bits: number[] = []
    let symbol = PREAMBLE_SIGNS.length
    let dataSymbols = 0
    while (true) {
      if (dataSymbols > 0 && dataSymbols % this.modem.config.pilotInterval === 0) {
        const pilot = this.modem.analyzeSymbol(this.buffer, start + symbol++ * this.modem.stride, channel)
        if (!pilot) return null
        continue
      }
      const decision = this.modem.analyzeSymbol(this.buffer, start + symbol++ * this.modem.stride, channel)
      if (!decision) return null
      bits.push(...decision.decisions); dataSymbols++
      const bytes = bitsToBytes(bits)
      if (bytes.length < 16) continue
      const total = 16 + ((bytes[14]! << 8) | bytes[15]!) + 4
      if (bytes.length * 8 < total * 8) continue
      return { frame: decodeFrame(bytes.subarray(0, total)), consumed: (symbol + FRAME_GAP_SYMBOLS) * this.modem.stride }
    }
  }
}

function correlate(samples: Float32Array, offset: number, count: number, frequency: number, sampleRate: number) {
  let re = 0; let im = 0
  for (let i = 0; i < count; i++) { const phase = 2 * Math.PI * frequency * i / sampleRate; const sample = samples[offset + i]!; re += sample * Math.cos(phase); im -= sample * Math.sin(phase) }
  return { re: re * 2 / count, im: im * 2 / count }
}
function complexDivide(a: { re: number; im: number }, b: { re: number; im: number }) { const d = b.re * b.re + b.im * b.im || 1e-9; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d } }
function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] || 0 }
function bytesToBits(bytes: Uint8Array): number[] { const bits: number[] = []; for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1); return bits }
function bitsToBytes(bits: number[]): Uint8Array { const bytes = new Uint8Array(Math.floor(bits.length / 8)); for (let i = 0; i < bytes.length; i++) for (let bit = 0; bit < 8; bit++) bytes[i] = (bytes[i]! << 1) | bits[i * 8 + bit]!; return bytes }
