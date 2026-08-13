import { FFT } from './fft'
import { applyWindow } from './window'

export interface SpectralAnalysisResult {
  detectedFrequencyHz: number | null
  frequencyErrorHz: number | null
  signalRms: number
  noiseFloorRms: number
  snrDb: number | null
  clipped: boolean
  carrierDetected: boolean
  fftSize: number
  frequencyResolutionHz: number
}

/**
 * Performs spectral analysis on time-domain microphone audio samples.
 * Uses Hann windowing, FFT peak detection, and non-carrier bin noise floor estimation.
 */
export function analyzeToneWindow(
  samples: Float32Array,
  sampleRate: number,
  expectedFrequencyHz: number,
): SpectralAnalysisResult {
  const fftSize = 1024
  const frequencyResolutionHz = sampleRate / fftSize

  if (samples.length < fftSize) {
    return {
      detectedFrequencyHz: null,
      frequencyErrorHz: null,
      signalRms: 0,
      noiseFloorRms: 0,
      snrDb: null,
      clipped: false,
      carrierDetected: false,
      fftSize,
      frequencyResolutionHz,
    }
  }

  // 1. Calculate time-domain RMS and clipping check
  let sumSquare = 0
  let isClipped = false
  const inputWindowed = applyWindow(samples.subarray(0, fftSize), 'hann')
  for (let i = 0; i < fftSize; i++) {
    const val = samples[i]!
    if (Math.abs(val) >= 0.99) isClipped = true
    sumSquare += val * val
  }
  const signalRms = Math.sqrt(sumSquare / fftSize)

  // 2. Perform FFT
  const fftInstance = new FFT(fftSize)
  const real = new Float32Array(inputWindowed)
  const imag = new Float32Array(fftSize)
  fftInstance.transform(real, imag)

  // 3. Compute magnitude spectrum
  const halfSize = fftSize / 2
  const magnitudes = new Float32Array(halfSize)
  for (let i = 0; i < halfSize; i++) {
    const r = real[i]!
    const im = imag[i]!
    magnitudes[i] = Math.sqrt(r * r + im * im)
  }

  // 4. Search for peak around expectedFrequencyHz (+/- 300 Hz window)
  const expectedBin = Math.round(expectedFrequencyHz / frequencyResolutionHz)
  const binSearchRange = Math.max(3, Math.round(300 / frequencyResolutionHz))
  const minBin = Math.max(1, expectedBin - binSearchRange)
  const maxBin = Math.min(halfSize - 1, expectedBin + binSearchRange)

  let peakBin = expectedBin
  let maxMag = -1

  for (let b = minBin; b <= maxBin; b++) {
    const mag = magnitudes[b]!
    if (mag > maxMag) {
      maxMag = mag
      peakBin = b
    }
  }

  // Parabolic interpolation around peak bin for sub-bin frequency accuracy
  let interpolatedBin = peakBin
  if (peakBin > 0 && peakBin < halfSize - 1) {
    const alpha = magnitudes[peakBin - 1]!
    const beta = magnitudes[peakBin]!
    const gamma = magnitudes[peakBin + 1]!
    const denom = alpha - 2 * beta + gamma
    if (denom !== 0) {
      const p = 0.5 * (alpha - gamma) / denom
      interpolatedBin = peakBin + p
    }
  }

  const detectedFrequencyHz = Number((interpolatedBin * frequencyResolutionHz).toFixed(1))
  const frequencyErrorHz = Number(Math.abs(detectedFrequencyHz - expectedFrequencyHz).toFixed(1))

  // 5. Measure noise floor from non-carrier bins outside peak region
  let noiseSum = 0
  let noiseCount = 0
  for (let b = 1; b < halfSize; b++) {
    if (Math.abs(b - peakBin) > binSearchRange) {
      noiseSum += magnitudes[b]!
      noiseCount++
    }
  }
  const noiseFloorRms = noiseCount > 0 ? noiseSum / noiseCount : 0.0001
  const carrierDetected = maxMag > noiseFloorRms * 3 && maxMag > 0.01

  let snrDb: number | null = null
  if (carrierDetected && noiseFloorRms > 0) {
    snrDb = Number((20 * Math.log10(maxMag / noiseFloorRms)).toFixed(1))
  }

  return {
    detectedFrequencyHz: carrierDetected ? detectedFrequencyHz : null,
    frequencyErrorHz: carrierDetected ? frequencyErrorHz : null,
    signalRms: Number(signalRms.toFixed(4)),
    noiseFloorRms: Number(noiseFloorRms.toFixed(4)),
    snrDb,
    clipped: isClipped,
    carrierDetected,
    fftSize,
    frequencyResolutionHz: Number(frequencyResolutionHz.toFixed(2)),
  }
}
