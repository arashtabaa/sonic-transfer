import { FFT, goertzelMagnitude } from '../dsp/fft'
import { applyWindow } from '../dsp/window'
import type { AcousticModem, AudioFrame, ModemConfig, ModemMetrics } from './modem'

/**
 * Robust Multi-Frequency Shift Keying (MFSK) Acoustic Modem.
 * Encodes binary data as frequency tones with continuous phase and guard intervals.
 */
export class BFSKAcousticModem implements AcousticModem {
  public readonly config: ModemConfig
  private carrierFreqs: number[] = []
  private samplesPerSymbol: number
  private guardSamples: number
  private packetsReceived = 0
  private validPackets = 0
  private invalidPackets = 0
  private lastSnrDb = 20

  constructor(config: ModemConfig) {
    this.config = config
    const sampleRate = config.sampleRate

    // Generate carrier frequencies spaced evenly
    const freqStep = (config.endFreq - config.startFreq) / (config.carrierCount - 1 || 1)
    for (let i = 0; i < config.carrierCount; i++) {
      this.carrierFreqs.push(config.startFreq + i * freqStep)
    }

    this.samplesPerSymbol = Math.round((config.symbolDurationMs / 1000) * sampleRate)
    this.guardSamples = Math.round((config.guardMs / 1000) * sampleRate)
  }

  public encode(packet: Uint8Array): AudioFrame {
    const sampleRate = this.config.sampleRate
    const bitsPerSymbol = Math.log2(this.config.carrierCount) | 0 || 1
    const totalBits = packet.length * 8

    // Convert packet bytes to bits
    const bits: number[] = []
    for (let i = 0; i < packet.length; i++) {
      const b = packet[i]!
      for (let bit = 7; bit >= 0; bit--) {
        bits.push((b >> bit) & 1)
      }
    }

    // Group bits into symbol indices
    const symbols: number[] = []
    for (let i = 0; i < bits.length; i += bitsPerSymbol) {
      let sym = 0
      for (let b = 0; b < bitsPerSymbol; b++) {
        if (i + b < bits.length) {
          sym = (sym << 1) | bits[i + b]!
        }
      }
      symbols.push(sym % this.config.carrierCount)
    }

    const totalSymbolSamples = (this.samplesPerSymbol + this.guardSamples) * symbols.length
    const samples = new Float32Array(totalSymbolSamples)

    let currentPhase = 0
    let writeIdx = 0

    for (const sym of symbols) {
      const freq = this.carrierFreqs[sym]!
      const phaseIncrement = (2 * Math.PI * freq) / sampleRate

      // Write active symbol samples with continuous phase & Hann ramp
      for (let s = 0; s < this.samplesPerSymbol; s++) {
        const envelope = 0.5 * (1 - Math.cos((2 * Math.PI * s) / (this.samplesPerSymbol - 1)))
        samples[writeIdx++] = Math.sin(currentPhase) * envelope * this.config.gain
        currentPhase += phaseIncrement
      }

      // Write guard zero samples to mitigate multipath echo
      for (let g = 0; g < this.guardSamples; g++) {
        samples[writeIdx++] = 0
      }
    }

    const durationMs = (totalSymbolSamples / sampleRate) * 1000
    return { samples, durationMs }
  }

  public decode(samples: Float32Array): Uint8Array[] {
    const decodedPackets: Uint8Array[] = []
    const sampleRate = this.config.sampleRate
    const bitsPerSymbol = Math.log2(this.config.carrierCount) | 0 || 1

    const symbolLen = this.samplesPerSymbol + this.guardSamples
    if (samples.length < symbolLen) {
      return decodedPackets
    }

    const numSymbols = Math.floor(samples.length / symbolLen)
    const detectedBits: number[] = []

    for (let i = 0; i < numSymbols; i++) {
      const symOffset = i * symbolLen
      const windowed = applyWindow(
        samples.subarray(symOffset, symOffset + this.samplesPerSymbol),
        'hann',
      )

      // Evaluate Goertzel magnitude for each carrier tone
      let maxMag = -1
      let bestSym = 0
      let noiseSum = 0

      for (let c = 0; c < this.carrierFreqs.length; c++) {
        const mag = goertzelMagnitude(windowed, this.carrierFreqs[c]!, sampleRate)
        if (mag > maxMag) {
          noiseSum += maxMag > 0 ? maxMag : 0
          maxMag = mag
          bestSym = c
        } else {
          noiseSum += mag
        }
      }

      const avgNoise = noiseSum / (this.carrierFreqs.length - 1 || 1)
      if (avgNoise > 0 && maxMag > 0) {
        const snrRatio = maxMag / (avgNoise + 1e-6)
        this.lastSnrDb = 10 * Math.log10(snrRatio)
      }

      // Convert symbol back to bits
      for (let b = bitsPerSymbol - 1; b >= 0; b--) {
        detectedBits.push((bestSym >> b) & 1)
      }
    }

    // Assemble bits into byte arrays
    const numBytes = Math.floor(detectedBits.length / 8)
    if (numBytes > 0) {
      const rawBytes = new Uint8Array(numBytes)
      for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
        let val = 0
        for (let b = 0; b < 8; b++) {
          val = (val << 1) | detectedBits[byteIdx * 8 + b]!
        }
        rawBytes[byteIdx] = val
      }
      decodedPackets.push(rawBytes)
    }

    return decodedPackets
  }

  public reset(): void {
    this.packetsReceived = 0
    this.validPackets = 0
    this.invalidPackets = 0
  }

  public getMetrics(): ModemMetrics {
    const total = this.validPackets + this.invalidPackets
    const discardRate = total > 0 ? this.invalidPackets / total : 0
    const bitsPerSymbol = Math.log2(this.config.carrierCount) | 0 || 1
    const symbolRateSec = 1000 / (this.config.symbolDurationMs + this.config.guardMs)
    const rawBitrate = bitsPerSymbol * symbolRateSec

    return {
      profileKey: this.config.profileKey,
      carrierFreqs: [...this.carrierFreqs],
      symbolDurationMs: this.config.symbolDurationMs,
      rawBitrate,
      usefulBitrate: rawBitrate * (1 - discardRate),
      snrDb: this.lastSnrDb,
      packetsReceived: this.packetsReceived,
      validPackets: this.validPackets,
      invalidPackets: this.invalidPackets,
      packetDiscardRate: discardRate,
    }
  }
}
