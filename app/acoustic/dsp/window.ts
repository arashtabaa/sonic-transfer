export type WindowType = 'hann' | 'hamming' | 'blackman' | 'rectangular'

export function applyWindow(samples: Float32Array, windowType: WindowType = 'hann'): Float32Array {
  const N = samples.length
  const out = new Float32Array(N)

  if (windowType === 'rectangular') {
    out.set(samples)
    return out
  }

  for (let i = 0; i < N; i++) {
    let factor = 1
    const n = i / (N - 1)

    if (windowType === 'hann') {
      factor = 0.5 * (1 - Math.cos(2 * Math.PI * n))
    } else if (windowType === 'hamming') {
      factor = 0.54 - 0.46 * Math.cos(2 * Math.PI * n)
    } else if (windowType === 'blackman') {
      factor = 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n)
    }

    out[i] = samples[i]! * factor
  }

  return out
}
