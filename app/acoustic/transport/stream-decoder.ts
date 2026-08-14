import { decodeFrame, FRAME_FOOTER_SIZE, FRAME_HEADER_SIZE, PREAMBLE_BYTES, type AcousticFrame } from '../protocol/frame'
import { BFSKAcousticModem } from '../modulation/bfsk-modem'

export interface StreamDecoderStats {
  framesDetected: number
  crcValid: number
  crcRejected: number
}

export interface ControlFrameObservation {
  frame: AcousticFrame
  pcm: Float32Array
  startSample: number
  endSample: number
  signalPeak: number
  signalRms: number
  clippingFraction: number
}
export type ObservationCaptureMode = 'OFF' | 'CALIBRATION_ONLY' | 'ALL_DIAGNOSTIC'

/**
 * Persistent receiver for arbitrary microphone/audio-artifact chunks.
 * It owns sample timing, symbol acquisition, byte assembly and frame resync;
 * callers only need to pass each PCM chunk to pushSamples().
 */
export class BFSKStreamDecoder {
  private sampleBuffer = new Float32Array(0)
  private locked = false
  private symbolOffset = 0
  private byteFifo: number[] = []
  private lastAcquisitionScanLength = -1
  private readonly stride: number
  private readonly bitsPerSymbol: number
  private readonly stats: StreamDecoderStats = { framesDetected: 0, crcValid: 0, crcRejected: 0 }
  private historyChunks: Array<{ startSample: number; samples: Float32Array }> = []
  private historyLength = 0
  private consumedSamples = 0
  private frameStartSample = 0
  private readonly observations: ControlFrameObservation[] = []
  private observationCaptureMode: ObservationCaptureMode = 'OFF'

  constructor(private readonly modem: BFSKAcousticModem) {
    this.stride = modem.getSymbolStrideSamples()
    this.bitsPerSymbol = modem.getBitsPerSymbol()
  }

  public pushSamples(samples: Float32Array): AcousticFrame[] {
    if (samples.length === 0) return []
    if (this.observationCaptureMode !== 'OFF') {
      const inputStartSample = this.consumedSamples + this.sampleBuffer.length
      const historyCopy = new Float32Array(samples)
      this.historyChunks.push({ startSample: inputStartSample, samples: historyCopy })
      this.historyLength += historyCopy.length
      while (this.historyLength > 2_000_000 && this.historyChunks.length > 0) {
        const first = this.historyChunks[0]!
        const excess = this.historyLength - 2_000_000
        if (first.samples.length <= excess) {
          this.historyChunks.shift()
          this.historyLength -= first.samples.length
        } else {
          this.historyChunks[0] = { startSample: first.startSample + excess, samples: first.samples.slice(excess) }
          this.historyLength -= excess
        }
      }
    }
    const merged = new Float32Array(this.sampleBuffer.length + samples.length)
    merged.set(this.sampleBuffer)
    merged.set(samples, this.sampleBuffer.length)
    this.sampleBuffer = merged

    const frames: AcousticFrame[] = []
    while (true) {
      if (!this.locked) {
        const acquired = this.acquireLock()
        if (acquired === null) break
        this.symbolOffset = acquired
        this.frameStartSample = this.consumedSamples + acquired
        this.locked = true
      }

      if (this.sampleBuffer.length < this.symbolOffset + this.stride) break
      const symbol = this.modem.analyzeSymbol(this.sampleBuffer, this.symbolOffset)
      if (!symbol) break

      if (!symbol.hasCarrier) {
        // A carrier gap ends the current acquisition. Keep only samples after
        // this symbol so the next frame can be acquired independently.
        this.consume(this.symbolOffset + this.stride)
        this.locked = false
        this.byteFifo = []
        continue
      }

      for (let bit = this.bitsPerSymbol - 1; bit >= 0; bit--) {
        this.byteFifo.push((symbol.symbol >> bit) & 1)
      }
      this.consume(this.stride)
      this.symbolOffset = 0
      frames.push(...this.extractFrames())
    }
    return frames
  }

  public reset(): void {
    this.sampleBuffer = new Float32Array(0)
    this.locked = false
    this.symbolOffset = 0
    this.byteFifo = []
    this.lastAcquisitionScanLength = -1
    this.stats.framesDetected = 0
    this.stats.crcValid = 0
    this.stats.crcRejected = 0
    this.historyChunks = []
    this.historyLength = 0
    this.consumedSamples = 0
    this.frameStartSample = 0
    this.observations.length = 0
  }

  public getStats(): StreamDecoderStats {
    return { ...this.stats }
  }

  public getSampleRate(): number {
    return this.modem.config.sampleRate
  }

  public takeObservations(): ControlFrameObservation[] {
    return this.observations.splice(0, this.observations.length)
  }

  public setObservationCaptureMode(mode: ObservationCaptureMode): void {
    this.observationCaptureMode = mode
    if (mode === 'OFF') {
      this.historyChunks = []
      this.historyLength = 0
      this.observations.length = 0
    }
  }

  private acquireLock(): number | null {
    const acquisitionSymbols = Math.ceil((PREAMBLE_BYTES.length * 8) / this.bitsPerSymbol)
    // Drop complete silent strides before scanning timing offsets. This keeps
    // inter-frame silence from pushing the next preamble beyond the scan
    // window and avoids treating silence as a candidate lock.
    let trimmedSilence = false
    while (this.sampleBuffer.length >= this.stride * acquisitionSymbols) {
      const first = this.modem.analyzeSymbol(this.sampleBuffer, 0)
      if (first?.hasCarrier) break
      this.consume(this.stride)
      trimmedSilence = true
    }
    if (trimmedSilence) this.lastAcquisitionScanLength = -1
    const remainingSymbols = Math.floor(this.sampleBuffer.length / this.stride)
    if (remainingSymbols < acquisitionSymbols) return null
    if (this.sampleBuffer.length <= this.lastAcquisitionScanLength + this.stride) return null
    this.lastAcquisitionScanLength = this.sampleBuffer.length
    const maxOffset = Math.min(this.stride - 1, this.sampleBuffer.length - this.stride * acquisitionSymbols)
    let best: { offset: number; score: number } | null = null

    for (let offset = 0; offset <= maxOffset; offset++) {
      let value = 0
      let score = 0
      let carrierCount = 0
      const bits: number[] = []
      for (let i = 0; i < acquisitionSymbols; i++) {
        const symbol = this.modem.analyzeSymbol(this.sampleBuffer, offset + i * this.stride)
        if (!symbol || !symbol.hasCarrier) break
        carrierCount++
        for (let bit = this.bitsPerSymbol - 1; bit >= 0; bit--) {
          bits.push((symbol.symbol >> bit) & 1)
        }
        score += symbol.confidence
      }
      if (carrierCount !== acquisitionSymbols) continue
      for (let i = 0; i < PREAMBLE_BYTES.length * 8; i++) value = (value << 1) | bits[i]!
      const bytes = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
      const preambleScore = bytes.reduce((sum, byte, i) => sum + (byte === PREAMBLE_BYTES[i] ? 1000 : 0), 0)
      const candidate = { offset, score: preambleScore + score }
      if (preambleScore === PREAMBLE_BYTES.length * 1000) {
        this.lastAcquisitionScanLength = -1
        return offset
      }
      if (!best || candidate.score > best.score) best = candidate
    }

    // Acquisition is deliberately preamble-based. Locking onto noise or
    // silence would manufacture bytes and make CRC resynchronization harder.
    return best && best.score >= 4000 ? best.offset : null
  }

  private extractFrames(): AcousticFrame[] {
    const frames: AcousticFrame[] = []
    while (this.byteFifo.length >= 8) {
      const bytes = this.bitsToBytes()
      const preambleAt = this.findPreamble(bytes)
      if (preambleAt < 0) {
        this.byteFifo.splice(0, Math.max(0, (bytes.length - 3) * 8))
        return frames
      }
      if (preambleAt > 0) this.byteFifo.splice(0, preambleAt * 8)
      if (this.byteFifo.length < FRAME_HEADER_SIZE * 8) return frames

      const header = this.bitsToBytes().subarray(0, FRAME_HEADER_SIZE)
      const payloadLength = (header[14]! << 8) | header[15]!
      const totalLength = FRAME_HEADER_SIZE + payloadLength + FRAME_FOOTER_SIZE
      if (this.byteFifo.length < totalLength * 8) return frames

      const raw = this.bitsToBytes().subarray(0, totalLength)
      const frame = decodeFrame(raw)
      if (frame) {
        frames.push(frame)
        if (this.observationCaptureMode !== 'OFF' && (this.observationCaptureMode === 'ALL_DIAGNOSTIC' || frame.frameType === 0x15)) {
          const endSample = this.consumedSamples
          const start = Math.max(this.frameStartSample, this.historyChunks[0]?.startSample ?? this.frameStartSample)
          const pcm = this.collectHistory(start, endSample)
          let sumSquares = 0
          let peak = 0
          let clipped = 0
          for (const sample of pcm) {
            const magnitude = Math.abs(sample)
            sumSquares += sample * sample
            peak = Math.max(peak, magnitude)
            if (magnitude >= 0.98) clipped++
          }
          this.observations.push({ frame, pcm, startSample: start, endSample, signalPeak: peak, signalRms: pcm.length ? Math.sqrt(sumSquares / pcm.length) : 0, clippingFraction: pcm.length ? clipped / pcm.length : 0 })
        }
        this.stats.framesDetected++
        this.stats.crcValid++
        this.byteFifo.splice(0, totalLength * 8)
        // Each modem.encode(packet) pads only its final symbol. Remove that
        // per-frame padding before the next frame's preamble is assembled.
        const paddingBits = this.byteFifo.length % this.bitsPerSymbol
        if (paddingBits) this.byteFifo.splice(0, paddingBits)
      } else {
        this.stats.crcRejected++
        // Shift one byte and rescan for SONI; a bad frame must not poison the
        // following valid frame.
        this.byteFifo.splice(0, 8)
      }
    }
    return frames
  }

  private bitsToBytes(): Uint8Array {
    const result = new Uint8Array(Math.floor(this.byteFifo.length / 8))
    for (let i = 0; i < result.length; i++) {
      let value = 0
      for (let bit = 0; bit < 8; bit++) value = (value << 1) | this.byteFifo[i * 8 + bit]!
      result[i] = value
    }
    return result
  }

  private findPreamble(bytes: Uint8Array): number {
    for (let i = 0; i <= bytes.length - PREAMBLE_BYTES.length; i++) {
      if (PREAMBLE_BYTES.every((byte, j) => bytes[i + j] === byte)) return i
    }
    return -1
  }

  private consume(count: number): void {
    if (count <= 0) return
    const consumed = Math.min(count, this.sampleBuffer.length)
    this.sampleBuffer = this.sampleBuffer.slice(consumed)
    this.consumedSamples += consumed
  }

  private collectHistory(startSample: number, endSample: number): Float32Array {
    const start = Math.max(startSample, this.historyChunks[0]?.startSample ?? startSample)
    const end = Math.min(endSample, this.historyChunks[this.historyChunks.length - 1]?.startSample! + this.historyChunks[this.historyChunks.length - 1]!.samples.length || endSample)
    if (end <= start) return new Float32Array(0)
    const result = new Float32Array(end - start)
    for (const chunk of this.historyChunks) {
      const chunkEnd = chunk.startSample + chunk.samples.length
      const copyStart = Math.max(start, chunk.startSample)
      const copyEnd = Math.min(end, chunkEnd)
      if (copyEnd > copyStart) result.set(chunk.samples.subarray(copyStart - chunk.startSample, copyEnd - chunk.startSample), copyStart - start)
    }
    return result
  }
}
