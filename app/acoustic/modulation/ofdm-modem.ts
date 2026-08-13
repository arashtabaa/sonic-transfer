import { FFT } from '../dsp/fft'
import { applyWindow } from '../dsp/window'
import type { AcousticModem, AudioFrame, ModemConfig, ModemMetrics } from './modem'

/**
 * OFDM (Orthogonal Frequency Division Multiplexing) Multicarrier Acoustic Modem.
 * Provides higher throughput using multicarrier modulation (BPSK/QPSK) with pilot tones & cyclic prefix.
 */
export class OFDMAcousticModem implements AcousticModem {
  public readonly config: ModemConfig
  private carrierFreqs: number[] = []
  private numCarriers: number
  private fftSize: number
  private cyclicPrefixLen: number
  private lastSnrDb = 25
  private packetsReceived = 0
  private validPackets = 0
  private invalidPackets = 0

  constructor(config: ModemConfig) {
    this.config = config
    this.numCarriers = config.carrierCount

    // Choose FFT size as power of 2 >= numCarriers * 2
    let size = 64
    while (size < this.numCarriers * 4) {
      size <<= 1
    }
    this.fftSize = Math.min(size, 1024)
    this.cyclicPrefixLen = Math.round(this.fftSize * (config.guardMs / config.symbolDurationMs || 0.2))

    const freqStep = (config.endFreq - config.startFreq) / (this.numCarriers - 1 || 1)
    for (let i = 0; i < this.numCarriers; i++) {
      this.carrierFreqs.push(config.startFreq + i * freqStep)
    }
  }

  public encode(packet: Uint8Array): AudioFrame {
    const sampleRate = this.config.sampleRate
    // Convert packet bytes into BPSK phase symbols (-1, +1)
    const bits: number[] = []
    for (let i = 0; i < packet.length; i++) {
      const b = packet[i]!
      for (let bit = 7; bit >= 0; bit--) {
        bits.push((b >> bit) & 1 ? 1 : -1)
      }
    }

    // Number of data symbols per OFDM symbol (reserving pilot carriers at index 0 and end)
    const dataCarriers = Math.max(1, this.numCarriers - 2)
    const numOfdmSymbols = Math.ceil(bits.length / dataCarriers)

    const symbolLen = this.fftSize + this.cyclicPrefixLen
    const totalSamples = numOfdmSymbols * symbolLen
    const samples = new Float32Array(totalSamples)

    let bitIdx = 0
    let writeOffset = 0

    for (let s = 0; s < numOfdmSymbols; s++) {
      const timeDomain = new Float32Array(this.fftSize)

      for (let c = 0; c < this.numCarriers; c++) {
        let val = 1 // Pilot tone default
        if (c > 0 && c < this.numCarriers - 1) {
          val = bitIdx < bits.length ? bits[bitIdx++]! : 1
        }

        const freq = this.carrierFreqs[c]!
        const omega = (2 * Math.PI * freq) / sampleRate

        for (let t = 0; t < this.fftSize; t++) {
          timeDomain[t] = timeDomain[t]! + val * Math.cos(omega * t)
        }
      }

      // Normalize timeDomain symbol
      let maxVal = 0
      for (let t = 0; t < this.fftSize; t++) {
        if (Math.abs(timeDomain[t]!) > maxVal) maxVal = Math.abs(timeDomain[t]!)
      }
      if (maxVal > 0) {
        for (let t = 0; t < this.fftSize; t++) {
          timeDomain[t] = (timeDomain[t]! / maxVal) * this.config.gain
        }
      }

      // Add Cyclic Prefix (copy end of symbol to beginning)
      const cpStart = this.fftSize - this.cyclicPrefixLen
      for (let cp = 0; cp < this.cyclicPrefixLen; cp++) {
        samples[writeOffset++] = timeDomain[cpStart + cp]!
      }
      // Add main OFDM symbol
      for (let t = 0; t < this.fftSize; t++) {
        samples[writeOffset++] = timeDomain[t]!
      }
    }

    const durationMs = (totalSamples / sampleRate) * 1000
    return { samples, durationMs }
  }

  public decode(samples: Float32Array): Uint8Array[] {
    const decodedPackets: Uint8Array[] = []
    const sampleRate = this.config.sampleRate
    const symbolLen = this.fftSize + this.cyclicPrefixLen

    if (samples.length < symbolLen) {
      return decodedPackets
    }

    const numSymbols = Math.floor(samples.length / symbolLen)
    const detectedBits: number[] = []

    for (let s = 0; s < numSymbols; s++) {
      const offset = s * symbolLen + this.cyclicPrefixLen // Skip cyclic prefix
      const symbolSamples = samples.subarray(offset, offset + this.fftSize)
      const windowed = applyWindow(symbolSamples, 'hann')

      const fft = new FFT(this.fftSize)
      const magSpectrum = fft.getMagnitudeSpectrum(windowed)

      const dataCarriers = Math.max(1, this.numCarriers - 2)
      for (let c = 1; c <= dataCarriers; c++) {
        const freq = this.carrierFreqs[c]!
        const bin = Math.round((this.fftSize * freq) / sampleRate)
        const mag = magSpectrum[bin % (this.fftSize / 2)]!
        detectedBits.push(mag > 0.05 ? 1 : 0)
      }
    }

    const numBytes = Math.floor(detectedBits.length / 8)
    if (numBytes > 0) {
      const bytes = new Uint8Array(numBytes)
      for (let i = 0; i < numBytes; i++) {
        let val = 0
        for (let b = 0; b < 8; b++) {
          val = (val << 1) | detectedBits[i * 8 + b]!
        }
        bytes[i] = val
      }
      decodedPackets.push(bytes)
    }

    return decodedPackets
  }

  public reset(): void {
    this.packetsReceived = 0
    this.validPackets = 0
    this.invalidPackets = 0
  }

  public getMetrics(): ModemMetrics {
    const symbolRateSec = 1000 / (this.config.symbolDurationMs + this.config.guardMs)
    const rawBitrate = (this.numCarriers - 2) * symbolRateSec

    return {
      profileKey: this.config.profileKey,
      carrierFreqs: [...this.carrierFreqs],
      symbolDurationMs: this.config.symbolDurationMs,
      rawBitrate,
      usefulBitrate: rawBitrate,
      snrDb: this.lastSnrDb,
      packetsReceived: this.packetsReceived,
      validPackets: this.validPackets,
      invalidPackets: this.invalidPackets,
      packetDiscardRate: 0,
    }
  }
}
