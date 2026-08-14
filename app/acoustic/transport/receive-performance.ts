import { AUDIO_WORKLET_BATCH_SIZE, AudioBatchAccumulator } from './audio-batching'

export interface ReceiveBenchmarkMetrics {
  durationSeconds: number
  sampleRate: number
  batchSize: number
  totalSamples: number
  emittedBatches: number
  remainderSamples: number
  audioChunksPerSecond: number
  audioSamplesPerSecond: number
  uiSnapshotHz: number
}

/** Deterministic, allocation-bounded accounting benchmark for the receive hot path. */
export function runDeterministicReceiveBenchmark(durationSeconds = 30, sampleRate = 48000, batchSize = AUDIO_WORKLET_BATCH_SIZE): ReceiveBenchmarkMetrics {
  const totalSamples = Math.floor(durationSeconds * sampleRate)
  const accumulator = new AudioBatchAccumulator(batchSize)
  let emittedBatches = 0
  const source = new Float32Array(batchSize)
  for (let samples = totalSamples; samples > 0; samples -= source.length) {
    accumulator.push(source.subarray(0, Math.min(samples, source.length)), () => { emittedBatches++ })
  }
  return {
    durationSeconds,
    sampleRate,
    batchSize,
    totalSamples,
    emittedBatches,
    remainderSamples: totalSamples % batchSize,
    audioChunksPerSecond: emittedBatches / durationSeconds,
    audioSamplesPerSecond: totalSamples / durationSeconds,
    uiSnapshotHz: 1000 / 80,
  }
}
