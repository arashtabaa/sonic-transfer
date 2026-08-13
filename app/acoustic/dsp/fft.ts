/**
 * Fast Fourier Transform (FFT) and Goertzel Algorithm for Acoustic Signal Demodulation
 */

export class FFT {
  private n: number
  private m: number
  private cosTable: Float32Array
  private sinTable: Float32Array

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of 2, got ${size}`)
    }
    this.n = size
    this.m = Math.log2(size)

    this.cosTable = new Float32Array(size / 2)
    this.sinTable = new Float32Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size)
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size)
    }
  }

  /**
   * Compute magnitude spectrum of real input samples.
   */
  public getMagnitudeSpectrum(realInput: Float32Array): Float32Array {
    const N = this.n
    const real = new Float32Array(N)
    const imag = new Float32Array(N)
    real.set(realInput.subarray(0, N))

    this.transform(real, imag)

    const magnitudes = new Float32Array(N / 2)
    for (let i = 0; i < N / 2; i++) {
      const r = real[i]!
      const im = imag[i]!
      magnitudes[i] = Math.sqrt(r * r + im * im)
    }
    return magnitudes
  }

  /**
   * In-place Radix-2 Cooley-Tukey FFT.
   */
  public transform(real: Float32Array, imag: Float32Array): void {
    const N = this.n
    // Bit reversal
    let j = 0
    for (let i = 0; i < N - 1; i++) {
      if (i < j) {
        const tempR = real[i]!
        real[i] = real[j]!
        real[j] = tempR
        const tempI = imag[i]!
        imag[i] = imag[j]!
        imag[j] = tempI
      }
      let k = N >> 1
      while (k <= j) {
        j -= k
        k >>= 1
      }
      j += k
    }

    // FFT compute
    let step = 1
    for (let level = 0; level < this.m; level++) {
      const jump = step << 1
      const tableStep = N / jump
      for (let group = 0; group < step; group++) {
        const tableIdx = group * tableStep
        const wr = this.cosTable[tableIdx]!
        const wi = this.sinTable[tableIdx]!

        for (let pair = group; pair < N; pair += jump) {
          const match = pair + step
          const tr = wr * real[match]! - wi * imag[match]!
          const ti = wr * imag[match]! + wi * real[match]!

          real[match] = real[pair]! - tr
          imag[match] = imag[pair]! - ti
          real[pair] = real[pair]! + tr
          imag[pair] = imag[pair]! + ti
        }
      }
      step = jump
    }
  }
}

/**
 * Goertzel algorithm for efficiently calculating the power of a specific frequency target.
 */
export function goertzelMagnitude(
  samples: Float32Array,
  targetFreq: number,
  sampleRate: number,
): number {
  const N = samples.length
  const k = Math.round((N * targetFreq) / sampleRate)
  const omega = (2 * Math.PI * k) / N
  const cosine = Math.cos(omega)
  const coeff = 2 * cosine

  let q0 = 0
  let q1 = 0
  let q2 = 0

  for (let i = 0; i < N; i++) {
    q0 = coeff * q1 - q2 + samples[i]!
    q2 = q1
    q1 = q0
  }

  const real = q1 - q2 * cosine
  const imag = q2 * Math.sin(omega)
  return Math.sqrt(real * real + imag * imag) / (N / 2)
}
