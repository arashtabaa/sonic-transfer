import { decodeFrame, type AcousticFrame } from '../protocol/frame'
import { ModemProfileKey } from './modem'

export interface ParallelMultitoneConfig {
  profileKey: ModemProfileKey.FAST_DATA_EXPERIMENTAL
  sampleRate: number
  startFreq: number
  endFreq: number
  carrierCount: 4 | 8 | 12 | 16
  symbolDurationMs: 5 | 10 | 15
  guardMs: number
  gain: number
}

export function getFastDataConfig(sampleRate = 48000, carrierCount: 4 | 8 | 12 | 16 = 16, symbolDurationMs: 5 | 10 | 15 = 5): ParallelMultitoneConfig {
  const endFreq = Math.min(18000, sampleRate / 2 - 1500)
  return { profileKey: ModemProfileKey.FAST_DATA_EXPERIMENTAL, sampleRate, startFreq: 6000, endFreq, carrierCount, symbolDurationMs, guardMs: 1, gain: 0.7 }
}

export interface ParallelMultitoneFrame { samples: Float32Array; durationMs: number }

const PREAMBLE_SYMBOLS = 4
const FRAME_GAP_SYMBOLS = 2

export class ParallelMultitoneModem {
  readonly samplesPerSymbol: number
  readonly guardSamples: number
  readonly stride: number
  readonly carrierFrequencies: number[]

  constructor(public readonly config: ParallelMultitoneConfig) {
    this.samplesPerSymbol = Math.round(config.sampleRate * config.symbolDurationMs / 1000)
    this.guardSamples = Math.round(config.sampleRate * config.guardMs / 1000)
    this.stride = this.samplesPerSymbol + this.guardSamples
    this.carrierFrequencies = Array.from({ length: config.carrierCount }, (_, i) => config.startFreq + (config.endFreq - config.startFreq) * (i + 0.5) / config.carrierCount)
  }

  encode(packet: Uint8Array): ParallelMultitoneFrame {
    const bits = bytesToBits(packet)
    const symbols = PREAMBLE_SYMBOLS + Math.ceil(bits.length / this.config.carrierCount) + FRAME_GAP_SYMBOLS
    const samples = new Float32Array(symbols * this.stride)
    for (let symbol = 0; symbol < symbols; symbol++) {
      const active = symbol < PREAMBLE_SYMBOLS
        ? this.carrierFrequencies.map(() => symbol % 2 === 0)
        : symbol >= symbols - FRAME_GAP_SYMBOLS
          ? this.carrierFrequencies.map(() => false)
        : this.carrierFrequencies.map((_, carrier) => bits[(symbol - PREAMBLE_SYMBOLS) * this.config.carrierCount + carrier] === 1)
      this.renderSymbol(samples, symbol * this.stride, active)
    }
    return { samples, durationMs: samples.length / this.config.sampleRate * 1000 }
  }

  analyzeSymbol(samples: Float32Array, offset: number): { bits: number[]; confidence: number; preamble: boolean } | null {
    if (offset < 0 || offset + this.samplesPerSymbol > samples.length) return null
    const energies = this.carrierFrequencies.map(frequency => this.energy(samples, offset, frequency))
    const peak = Math.max(...energies, 1e-9)
    const threshold = peak * 0.28
    const bits = energies.map(value => value >= threshold ? 1 : 0)
    const active = bits.filter(Boolean).length
    return { bits, confidence: peak, preamble: active >= Math.ceil(this.config.carrierCount * 0.8) }
  }

  private renderSymbol(target: Float32Array, offset: number, active: boolean[]): void {
    const activeCount = Math.max(1, active.filter(Boolean).length)
    const amplitude = this.config.gain / activeCount
    for (let sample = 0; sample < this.samplesPerSymbol; sample++) {
      const t = sample / this.config.sampleRate
      let value = 0
      for (let carrier = 0; carrier < active.length; carrier++) if (active[carrier]) value += Math.sin(2 * Math.PI * this.carrierFrequencies[carrier]! * t) * amplitude
      target[offset + sample] = value
    }
  }

  private energy(samples: Float32Array, offset: number, frequency: number): number {
    let sin = 0
    let cos = 0
    for (let i = 0; i < this.samplesPerSymbol; i++) {
      const phase = 2 * Math.PI * frequency * i / this.config.sampleRate
      sin += samples[offset + i]! * Math.sin(phase)
      cos += samples[offset + i]! * Math.cos(phase)
    }
    return Math.sqrt(sin * sin + cos * cos) / this.samplesPerSymbol
  }
}

export class ParallelMultitoneStreamDecoder {
  private buffer = new Float32Array(0)
  private pendingStart = -1
  private readonly modem: ParallelMultitoneModem

  constructor(config: ParallelMultitoneConfig) { this.modem = new ParallelMultitoneModem(config) }

  pushSamples(samples: Float32Array): AcousticFrame[] {
    const merged = new Float32Array(this.buffer.length + samples.length)
    merged.set(this.buffer); merged.set(samples, this.buffer.length); this.buffer = merged
    const frames: AcousticFrame[] = []
    while (true) {
      const start = this.pendingStart >= 0 ? this.pendingStart : this.findPreamble()
      if (start < 0) { this.retainTail(); break }
      const parsed = this.tryDecodeAt(start)
      if (parsed === null) { this.pendingStart = start; break }
      if (!parsed.frame) {
        this.buffer = this.buffer.slice(start + 1)
        this.pendingStart = -1
        continue
      }
      frames.push(parsed.frame)
      this.buffer = this.buffer.slice(start + parsed.consumed)
      this.pendingStart = -1
    }
    return frames
  }

  reset(): void { this.buffer = new Float32Array(0); this.pendingStart = -1 }

  private findPreamble(): number {
    const minimumDataSymbols = Math.ceil(16 * 8 / this.modem.config.carrierCount)
    for (let offset = 0; offset <= this.buffer.length - this.modem.stride * (PREAMBLE_SYMBOLS + minimumDataSymbols); offset += 4) {
      let valid = true
      for (let i = 0; i < PREAMBLE_SYMBOLS; i++) {
        const decision = this.modem.analyzeSymbol(this.buffer, offset + i * this.modem.stride)
        const matches = i % 2 === 0 ? !!decision?.preamble : !!decision && decision.bits.every(bit => bit === 0)
        if (!matches) { valid = false; break }
      }
      if (valid) {
        return offset
      }
    }
    return -1
  }

  private tryDecodeAt(start: number): { frame: AcousticFrame | null; consumed: number } | null {
    const bits: number[] = []
    const dataStart = start + PREAMBLE_SYMBOLS * this.modem.stride
    let symbols = 0
    while (true) {
      const decision = this.modem.analyzeSymbol(this.buffer, dataStart + symbols * this.modem.stride)
      if (!decision) return null
      bits.push(...decision.bits)
      symbols++
      const bytes = bitsToBytes(bits)
      if (bytes.length < 16) continue
      const total = 16 + ((bytes[14]! << 8) | bytes[15]!) + 4
      if (bytes.length * 8 < total * 8) continue
      const frame = decodeFrame(bytes.subarray(0, total))
      return { frame, consumed: PREAMBLE_SYMBOLS * this.modem.stride + (symbols + FRAME_GAP_SYMBOLS) * this.modem.stride }
    }
  }

  private retainTail(): void {
    const keep = Math.min(this.buffer.length, this.modem.config.sampleRate)
    this.buffer = this.buffer.slice(this.buffer.length - keep)
  }
}

function bytesToBits(bytes: Uint8Array): number[] { const bits: number[] = []; for (const byte of bytes) for (let i = 0; i < 8; i++) bits.push((byte >> (7 - i)) & 1); return bits }
function bitsToBytes(bits: number[]): Uint8Array { const bytes = new Uint8Array(Math.floor(bits.length / 8)); for (let i = 0; i < bytes.length; i++) for (let bit = 0; bit < 8; bit++) bytes[i] = (bytes[i]! << 1) | bits[i * 8 + bit]!; return bytes }
