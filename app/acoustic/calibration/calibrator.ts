import { goertzelMagnitude } from '../dsp/fft'
import { applyWindow } from '../dsp/window'
import { ModemProfileKey } from '../modulation/modem'

export interface CalibrationResult {
  usableBandStart: number
  usableBandEnd: number
  estimatedSnrDb: number
  noiseFloorDb: number
  recommendedProfile: ModemProfileKey
  isUltrasonicViable: boolean
  details: string
}

export class AcousticCalibrator {
  private sampleRate: number

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
  }

  /**
   * Generates a calibrated chirp probe signal from minFreq to maxFreq for audio playback.
   */
  public generateProbeChirp(minFreq = 1000, maxFreq = 22000, durationMs = 1500): Float32Array {
    const totalSamples = Math.round((durationMs / 1000) * this.sampleRate)
    const samples = new Float32Array(totalSamples)

    const nyquist = this.sampleRate / 2
    const safeMaxFreq = Math.min(maxFreq, nyquist - 1000)

    for (let i = 0; i < totalSamples; i++) {
      const t = i / totalSamples
      const freq = minFreq + t * (safeMaxFreq - minFreq)
      const phase = 2 * Math.PI * (minFreq * (i / this.sampleRate) + (0.5 * (safeMaxFreq - minFreq) * Math.pow(i / this.sampleRate, 2)) / (durationMs / 1000))
      const window = 0.5 * (1 - Math.cos(2 * Math.PI * t)) // Hann window envelope
      samples[i] = Math.sin(phase) * window * 0.7
    }

    return samples
  }

  /**
   * Analyzes recorded audio samples to measure noise floor, frequency response, and SNR.
   */
  public analyzeSignal(noiseSamples: Float32Array, recordedChirp: Float32Array): CalibrationResult {
    const nyquist = this.sampleRate / 2

    // 1. Calculate Noise Floor
    let noiseEnergy = 0
    for (let i = 0; i < noiseSamples.length; i++) {
      noiseEnergy += noiseSamples[i]! * noiseSamples[i]!
    }
    const noiseRms = Math.sqrt(noiseEnergy / (noiseSamples.length || 1)) + 1e-6
    const noiseFloorDb = 20 * Math.log10(noiseRms)

    // 2. Measure SNR across frequency bands (Step 500 Hz)
    const bandStep = 500
    const bands: { freq: number; snrDb: number }[] = []

    for (let freq = 1000; freq <= nyquist - 1000; freq += bandStep) {
      const noiseMag = goertzelMagnitude(applyWindow(noiseSamples.subarray(0, 2048), 'hann'), freq, this.sampleRate)
      const signalMag = goertzelMagnitude(applyWindow(recordedChirp.subarray(0, 2048), 'hann'), freq, this.sampleRate)

      const snrRatio = signalMag / (noiseMag + 1e-6)
      const snrDb = 20 * Math.log10(Math.max(1, snrRatio))
      bands.push({ freq, snrDb })
    }

    // 3. Find Usable Frequency Band (SNR >= 10 dB)
    const usable = bands.filter(b => b.snrDb >= 10)
    let usableBandStart = 2000
    let usableBandEnd = 6000

    if (usable.length > 0) {
      usableBandStart = usable[0]!.freq
      usableBandEnd = usable[usable.length - 1]!.freq
    }

    // 4. Calculate average SNR of usable band
    let avgSnrDb = 0
    if (usable.length > 0) {
      const sum = usable.reduce((acc, b) => acc + b.snrDb, 0)
      avgSnrDb = sum / usable.length
    }

    // 5. Check Ultrasonic Viability
    const isUltrasonicViable = usableBandEnd >= 18000 && avgSnrDb >= 15 && this.sampleRate >= 44100

    // 6. Determine Recommended Profile based on actual measurements
    let recommendedProfile = ModemProfileKey.BALANCED

    if (avgSnrDb < 12) {
      recommendedProfile = ModemProfileKey.ROBUST
    } else if (isUltrasonicViable && avgSnrDb >= 20) {
      recommendedProfile = ModemProfileKey.NEAR_ULTRASONIC
    } else if (usableBandEnd >= 10000 && avgSnrDb >= 18) {
      recommendedProfile = ModemProfileKey.TURBO
    } else {
      recommendedProfile = ModemProfileKey.BALANCED
    }

    const details = `Usable band: ${(usableBandStart / 1000).toFixed(1)} kHz – ${(usableBandEnd / 1000).toFixed(1)} kHz | Est. SNR: ${avgSnrDb.toFixed(1)} dB | Noise Floor: ${noiseFloorDb.toFixed(1)} dB`

    return {
      usableBandStart,
      usableBandEnd,
      estimatedSnrDb: avgSnrDb,
      noiseFloorDb,
      recommendedProfile,
      isUltrasonicViable,
      details,
    }
  }
}
