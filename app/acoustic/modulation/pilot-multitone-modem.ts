import { decodeFrame, type AcousticFrame } from '../protocol/frame'
import { ModemProfileKey } from './modem'
import { SymbolTiming } from './symbol-timing'

export interface PilotMultitoneConfig {
  profileKey: ModemProfileKey.FAST_DATA_EXPERIMENTAL
  modulationId: 'PILOT_MULTITONE_V2'
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
  heuristicNoiseEstimate: number
  hammingWeight: number
  peakPcm: number
}

export function getPilotMultitoneConfig(sampleRate = 48000, pilotInterval: 8 | 16 | 32 = 16): PilotMultitoneConfig {
  return { profileKey: ModemProfileKey.FAST_DATA_EXPERIMENTAL, modulationId: 'PILOT_MULTITONE_V2', sampleRate, startFreq: 6000, endFreq: Math.min(18000, sampleRate / 2 - 1500), carrierCount: 16, symbolDurationMs: 5, guardMs: 1, gain: 0.7, pilotInterval }
}

const PREAMBLE_SIGNS = [1, -1, 1, -1]
const FRAME_GAP_SYMBOLS = 2

export class PilotMultitoneModem {
  readonly samplesPerSymbol: number
  readonly guardSamples: number
  readonly stride: number
  readonly timingStride: number
  readonly timing: SymbolTiming
  readonly carrierFrequencies: number[]

  constructor(public readonly config: PilotMultitoneConfig) {
    this.samplesPerSymbol = Math.round(config.sampleRate * config.symbolDurationMs / 1000)
    this.guardSamples = Math.round(config.sampleRate * config.guardMs / 1000)
    this.stride = this.samplesPerSymbol + this.guardSamples
    this.timing = new SymbolTiming(config.sampleRate, config.symbolDurationMs, config.guardMs)
    this.timingStride = this.timing.strideExact
    this.carrierFrequencies = Array.from({ length: config.carrierCount }, (_, i) => config.startFreq + (config.endFreq - config.startFreq) * (i + 0.5) / config.carrierCount)
  }

  encode(packet: Uint8Array): { samples: Float32Array; durationMs: number } {
    const bits = bytesToBits(packet)
    const dataSymbols = Math.ceil(bits.length / this.config.carrierCount)
    const pilotCount = Math.floor(Math.max(0, dataSymbols - 1) / this.config.pilotInterval)
    const symbols = PREAMBLE_SIGNS.length + dataSymbols + pilotCount + FRAME_GAP_SYMBOLS
    const samples = new Float32Array(this.timing.symbolStart(0, symbols))
    let symbol = 0
    for (const sign of PREAMBLE_SIGNS) this.renderSymbol(samples, this.timing.symbolStart(0, symbol), this.timing.activeLength(0, symbol++), this.carrierFrequencies.map(() => sign))
    for (let data = 0; data < dataSymbols; data++) {
      if (data > 0 && data % this.config.pilotInterval === 0) this.renderSymbol(samples, this.timing.symbolStart(0, symbol), this.timing.activeLength(0, symbol++), this.carrierFrequencies.map(() => 1))
      const signs = this.carrierFrequencies.map((_, carrier) => bits[data * this.config.carrierCount + carrier] === 1 ? -1 : 1)
      this.renderSymbol(samples, this.timing.symbolStart(0, symbol), this.timing.activeLength(0, symbol++), signs)
    }
    symbol += FRAME_GAP_SYMBOLS
    return { samples, durationMs: samples.length / this.config.sampleRate * 1000 }
  }

  analyzeSymbol(samples: Float32Array, offset: number, channel?: CarrierDiagnostic[], activeSamples = this.samplesPerSymbol, phaseOffset = offset): PilotSymbolDiagnostic | null {
    if (offset < 0 || offset + activeSamples > samples.length) return null
    const correlations = this.carrierFrequencies.map(f => correlate(samples, offset, activeSamples, f, this.config.sampleRate, phaseOffset))
    const magnitudes = correlations.map(z => Math.hypot(z.re, z.im))
    const reference = channel?.map(c => Math.max(c.referenceMagnitude, 1e-9)) || magnitudes.map(value => Math.max(value, 1e-9))
    const normalizedMagnitudes = magnitudes.map((value, i) => value / reference[i]!)
    const decisions = correlations.map((z, i) => {
      const h = channel?.[i]
      const equalized = h ? complexDivide(z, { re: h.referenceMagnitude * Math.cos(h.phaseRadians), im: h.referenceMagnitude * Math.sin(h.phaseRadians) }) : z
      return equalized.re < 0 ? 1 : 0
    })
    const noiseEstimate = median(magnitudes) * 0.15
    return { magnitudes, normalizedMagnitudes, decisions, confidence: Math.min(...magnitudes) / Math.max(noiseEstimate, 1e-9), heuristicNoiseEstimate: noiseEstimate, hammingWeight: decisions.reduce((a, b) => a + b, 0 as number), peakPcm: Math.max(...Array.from(samples.subarray(offset, offset + activeSamples)).map(Math.abs)) }
  }

  estimateChannel(samples: Float32Array, offset: number, symbolSpacing = this.stride, activeSamples = this.samplesPerSymbol, phaseOffset = offset): CarrierDiagnostic[] {
    const first = this.analyzeRaw(samples, offset, activeSamples, phaseOffset)
    const second = this.analyzeRaw(samples, offset + symbolSpacing, activeSamples, phaseOffset + symbolSpacing)
    return first.map((z, i) => {
      const estimate = { re: (z.re - second[i]!.re) / 2, im: (z.im - second[i]!.im) / 2 }
      const magnitude = Math.hypot(estimate.re, estimate.im)
      return { frequency: this.carrierFrequencies[i]!, referenceMagnitude: magnitude, phaseRadians: Math.atan2(estimate.im, estimate.re), noiseEstimate: Math.hypot((z.re + second[i]!.re) / 2, (z.im + second[i]!.im) / 2), confidence: magnitude / Math.max(Math.hypot((z.re + second[i]!.re) / 2, (z.im + second[i]!.im) / 2), 1e-9), usable: magnitude > 1e-5 }
    })
  }

  estimatePilotChannel(samples: Float32Array, offset: number, activeSamples = this.samplesPerSymbol, phaseOffset = offset): CarrierDiagnostic[] {
    return this.analyzeRaw(samples, offset, activeSamples, phaseOffset).map((estimate, i) => {
      const magnitude = Math.hypot(estimate.re, estimate.im)
      return { frequency: this.carrierFrequencies[i]!, referenceMagnitude: magnitude, phaseRadians: Math.atan2(estimate.im, estimate.re), noiseEstimate: 0, confidence: magnitude / 1e-9, usable: magnitude > 1e-5 }
    })
  }

  private analyzeRaw(samples: Float32Array, offset: number, activeSamples = this.samplesPerSymbol, phaseOffset = offset) { return this.carrierFrequencies.map(f => correlate(samples, offset, activeSamples, f, this.config.sampleRate, phaseOffset)) }

  private renderSymbol(target: Float32Array, offset: number, activeSamples: number, signs: number[]): void {
    const amplitude = this.config.gain / this.config.carrierCount
    for (let sample = 0; sample < activeSamples; sample++) {
      const t = (offset + sample) / this.config.sampleRate
      let value = 0
      for (let carrier = 0; carrier < signs.length; carrier++) value += signs[carrier]! * Math.cos(2 * Math.PI * this.carrierFrequencies[carrier]! * t) * amplitude
      target[offset + sample] = value
    }
  }
}

export class PilotMultitoneStreamDecoder {
  private buffer = new Float32Array(0)
  private bufferOriginExact = 0
  private nextFrameOriginExact: number | null = null
  private acquisitionSearchIndex = 0
  private pendingCandidate: { index: number; origin: number; exactOrigin: number } | null = null
  private channel: CarrierDiagnostic[] | null = null
  private readonly pilotDiagnostics: Array<{ oldMagnitude: number; newMagnitude: number; oldPhase: number; newPhase: number; confidence: number; usable: boolean }> = []
  private readonly timingDiagnostics: Array<{ origin: number; frameSymbols: number; consumed: number; nextOrigin: number; bufferOrigin: number }> = []
  constructor(private readonly modem: PilotMultitoneModem) {}

  pushSamples(samples: Float32Array): AcousticFrame[] {
    const merged = new Float32Array(this.buffer.length + samples.length); merged.set(this.buffer); merged.set(samples, this.buffer.length); this.buffer = merged
    const frames: AcousticFrame[] = []
    while (true) {
      const candidate = this.pendingCandidate || this.findPreamble()
      if (!candidate) {
        const timingSearchRadius = Math.ceil(this.modem.timingStride * 4)
        const predicted = this.nextFrameOriginExact === null ? null : this.nextFrameOriginExact - this.bufferOriginExact
        const keepFrom = predicted === null ? this.buffer.length - this.modem.stride * 6 : Math.max(0, Math.floor(predicted) - timingSearchRadius)
        const discarded = Math.max(0, Math.min(keepFrom, this.buffer.length - this.modem.timing.symbolStart(0, PREAMBLE_SIGNS.length + 2)))
        if (discarded > 0) { this.buffer = this.buffer.slice(discarded); this.bufferOriginExact += discarded; this.acquisitionSearchIndex = Math.max(0, this.acquisitionSearchIndex - discarded) }
        if (predicted !== null && (predicted < -timingSearchRadius || this.buffer.length > predicted + timingSearchRadius + this.modem.timing.symbolStart(0, PREAMBLE_SIGNS.length + 8))) {
          this.nextFrameOriginExact = null
          this.pendingCandidate = null
          this.acquisitionSearchIndex = 0
          continue
        }
        break
      }
      const minimumCandidateSamples = this.modem.timing.symbolStart(0, PREAMBLE_SIGNS.length + 8)
      if (this.buffer.length <= candidate.index + minimumCandidateSamples) { this.pendingCandidate = candidate; break }
      const parsed = this.tryDecode(candidate.origin)
      if (!parsed) {
        this.pendingCandidate = candidate
        break
      }
      this.pendingCandidate = null
      if (parsed.incomplete) { this.pendingCandidate = candidate; break }
      if (parsed.frame) {
        frames.push(parsed.frame)
        const frameOriginExact = this.bufferOriginExact + candidate.exactOrigin
        const consumed = candidate.index + parsed.consumed
        this.buffer = this.buffer.slice(consumed)
        this.bufferOriginExact += consumed
        this.nextFrameOriginExact = frameOriginExact + (parsed.frameSymbols + FRAME_GAP_SYMBOLS) * this.modem.timingStride
        this.timingDiagnostics.push({ origin: frameOriginExact, frameSymbols: parsed.frameSymbols, consumed, nextOrigin: this.nextFrameOriginExact, bufferOrigin: this.bufferOriginExact })
        this.acquisitionSearchIndex = 0
      } else {
        this.buffer = this.buffer.slice(candidate.index + 1)
        this.bufferOriginExact += candidate.index + 1
        this.nextFrameOriginExact = null
        this.acquisitionSearchIndex = 0
      }
    }
    return frames
  }

  reset(): void { this.buffer = new Float32Array(0); this.bufferOriginExact = 0; this.nextFrameOriginExact = null; this.acquisitionSearchIndex = 0; this.pendingCandidate = null; this.channel = null; this.pilotDiagnostics.length = 0; this.timingDiagnostics.length = 0 }

  getPilotDiagnostics() { return this.pilotDiagnostics.map(item => ({ ...item })) }
  getTimingDiagnostics() { return this.timingDiagnostics.map(item => ({ ...item })) }

  private findPreamble(): { index: number; origin: number; exactOrigin: number } | null {
    const need = this.modem.timing.symbolStart(0, PREAMBLE_SIGNS.length + 2)
    const predicted = this.nextFrameOriginExact === null ? null : this.nextFrameOriginExact - this.bufferOriginExact
    const timingSearchRadius = Math.ceil(this.modem.timingStride * 4)
    const first = predicted === null ? this.acquisitionSearchIndex : Math.max(0, Math.floor(predicted) - timingSearchRadius)
    const last = predicted === null ? this.buffer.length - need : Math.min(this.buffer.length - need, Math.ceil(predicted) + timingSearchRadius)
    const offsets = predicted === null
      ? Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index)
      : []
    if (predicted !== null) {
      const center = Math.round(predicted)
      for (let delta = 0; delta <= timingSearchRadius; delta++) {
        if (delta === 0) offsets.push(center)
        else { offsets.push(center - delta); offsets.push(center + delta) }
      }
    }
    for (const offset of offsets) {
      if (offset < first || offset > last) continue
      const origin = offset
      const exactOrigin = predicted === null ? offset : predicted + (offset - Math.round(predicted))
      const firstSymbol = this.symbolOffset(origin, 0)
      const channel = this.modem.estimateChannel(this.buffer, firstSymbol, this.symbolOffset(origin, 1) - firstSymbol, this.activeLength(origin, 0), origin + firstSymbol)
      if (channel.some(c => !c.usable)) continue
      let valid = true
      for (let i = 0; i < PREAMBLE_SIGNS.length; i++) {
        const d = this.analyzeAt(this.buffer, origin, i, channel)
        if (!d || d.confidence < 1.5 || d.decisions.some(bit => (bit === 1 ? -1 : 1) !== PREAMBLE_SIGNS[i])) { valid = false; break }
      }
      if (valid) return { index: offset, origin, exactOrigin }
    }
    if (predicted === null && last >= first) this.acquisitionSearchIndex = last + 1
    return null
  }

  private tryDecode(origin: number): { frame: AcousticFrame | null; consumed: number; frameSymbols: number; incomplete: boolean } | null {
    const firstSymbol = this.symbolOffset(origin, 0)
    const channel = this.modem.estimateChannel(this.buffer, firstSymbol, this.symbolOffset(origin, 1) - firstSymbol, this.activeLength(origin, 0), origin + firstSymbol)
    this.channel = channel
    const bits: number[] = []
    let symbol = PREAMBLE_SIGNS.length
    let dataSymbols = 0
    let nextPilotAt = this.modem.config.pilotInterval
    while (true) {
      if (dataSymbols === nextPilotAt) {
        const pilotOffset = this.symbolOffset(origin, symbol++)
        const pilot = this.analyzeAt(this.buffer, origin, symbol - 1, channel)
        if (!pilot) return { frame: null, consumed: 0, frameSymbols: symbol, incomplete: true }
        const fresh = this.modem.estimatePilotChannel(this.buffer, pilotOffset, this.activeLength(origin, symbol - 1), origin + pilotOffset)
        for (let i = 0; i < channel.length; i++) {
          const old = channel[i]!
          const next = fresh[i]!
          this.pilotDiagnostics.push({ oldMagnitude: old.referenceMagnitude, newMagnitude: next.referenceMagnitude, oldPhase: old.phaseRadians, newPhase: next.phaseRadians, confidence: next.confidence, usable: next.usable })
          channel[i] = next
        }
        nextPilotAt += this.modem.config.pilotInterval
        continue
      }
      const currentSymbol = symbol++
      const decision = this.analyzeAt(this.buffer, origin, currentSymbol, channel)
      if (!decision) return { frame: null, consumed: 0, frameSymbols: symbol, incomplete: true }
      bits.push(...decision.decisions); dataSymbols++
      const bytes = bitsToBytes(bits)
      if (bytes.length < 16) continue
      const total = 16 + ((bytes[14]! << 8) | bytes[15]!) + 4
      if (bytes.length * 8 < total * 8) continue
      const nativeTiming = Math.abs(this.modem.timingStride - this.modem.stride) < 1e-9
      const consumed = nativeTiming
        ? this.symbolOffset(origin, symbol + FRAME_GAP_SYMBOLS) - Math.round(origin)
        : this.symbolOffset(origin, symbol - 1) + this.activeLength(origin, symbol - 1) - Math.round(origin)
      return { frame: decodeFrame(bytes.subarray(0, total)), consumed, frameSymbols: symbol, incomplete: false }
    }
  }

  private symbolOffset(origin: number, symbol: number): number { return Math.round(origin + symbol * this.modem.timingStride) }
  private activeLength(origin: number, symbol: number): number { return this.modem.timing.activeEnd(origin, symbol) - this.symbolOffset(origin, symbol) }
  private analyzeAt(samples: Float32Array, origin: number, symbol: number, channel: CarrierDiagnostic[]) { const offset = this.symbolOffset(origin, symbol); return this.modem.analyzeSymbol(samples, offset, channel, this.activeLength(origin, symbol), origin + offset) }
}

function correlate(samples: Float32Array, offset: number, count: number, frequency: number, sampleRate: number, phaseOffset = offset) {
  let re = 0; let im = 0
  for (let i = 0; i < count; i++) { const phase = 2 * Math.PI * frequency * (phaseOffset + i) / sampleRate; const sample = samples[offset + i]!; re += sample * Math.cos(phase); im -= sample * Math.sin(phase) }
  return { re: re * 2 / count, im: im * 2 / count }
}
function complexDivide(a: { re: number; im: number }, b: { re: number; im: number }) { const d = b.re * b.re + b.im * b.im || 1e-9; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d } }
function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] || 0 }
function bytesToBits(bytes: Uint8Array): number[] { const bits: number[] = []; for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1); return bits }
function bitsToBytes(bits: number[]): Uint8Array { const bytes = new Uint8Array(Math.floor(bits.length / 8)); for (let i = 0; i < bytes.length; i++) for (let bit = 0; bit < 8; bit++) bytes[i] = (bytes[i]! << 1) | bits[i * 8 + bit]!; return bytes }
