import { describe, expect, it } from 'vitest'
import { AudioBatchAccumulator, runDeterministicReceiveBenchmark } from '../app/acoustic'

describe('receive batching', () => {
  it('emits equivalent ordered batches across arbitrary chunk boundaries', () => {
    const accumulator = new AudioBatchAccumulator(4)
    const emitted: number[] = []
    accumulator.push(Float32Array.from([0, 1, 2]), batch => emitted.push(...batch))
    accumulator.push(Float32Array.from([3, 4, 5, 6, 7]), batch => emitted.push(...batch))
    accumulator.push(Float32Array.from([8]), batch => emitted.push(...batch))
    expect(emitted).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps the 30 second accounting benchmark deterministic', () => {
    expect(runDeterministicReceiveBenchmark()).toEqual({
      durationSeconds: 30,
      sampleRate: 48000,
      batchSize: 1024,
      totalSamples: 1440000,
      emittedBatches: 1406,
      remainderSamples: 256,
      audioChunksPerSecond: 1406 / 30,
      audioSamplesPerSecond: 48000,
      uiSnapshotHz: 12.5,
    })
  })
})
