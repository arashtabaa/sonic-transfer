/**
 * Cross-correlation for timing synchronization and preamble detection.
 */

export function crossCorrelate(
  signal: Float32Array,
  reference: Float32Array,
): { maxCorrelation: number; bestOffset: number } {
  const signalLen = signal.length
  const refLen = reference.length

  if (signalLen < refLen) {
    return { maxCorrelation: 0, bestOffset: -1 }
  }

  let maxCorr = -Infinity
  let bestOffset = -1

  // Compute energy of reference
  let refEnergy = 0
  for (let i = 0; i < refLen; i++) {
    refEnergy += reference[i]! * reference[i]!
  }
  const refNorm = Math.sqrt(refEnergy) || 1e-9

  const searchLen = signalLen - refLen + 1
  for (let offset = 0; offset < searchLen; offset++) {
    let dot = 0
    let sigEnergy = 0
    for (let i = 0; i < refLen; i++) {
      const s = signal[offset + i]!
      const r = reference[i]!
      dot += s * r
      sigEnergy += s * s
    }
    const sigNorm = Math.sqrt(sigEnergy) || 1e-9
    const normalizedCorr = dot / (refNorm * sigNorm)

    if (normalizedCorr > maxCorr) {
      maxCorr = normalizedCorr
      bestOffset = offset
    }
  }

  return { maxCorrelation: maxCorr, bestOffset }
}
