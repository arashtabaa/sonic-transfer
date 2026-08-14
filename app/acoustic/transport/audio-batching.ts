export const AUDIO_WORKLET_BATCH_SIZE = 1024

/** Bounded PCM accumulator used by tests and receive-path batching logic. */
export class AudioBatchAccumulator {
  private buffer: Float32Array
  private length = 0

  constructor(private readonly batchSize = AUDIO_WORKLET_BATCH_SIZE) {
    this.buffer = new Float32Array(batchSize)
  }

  push(samples: Float32Array, emit: (batch: Float32Array) => void): void {
    let offset = 0
    while (offset < samples.length) {
      const copyLength = Math.min(this.buffer.length - this.length, samples.length - offset)
      this.buffer.set(samples.subarray(offset, offset + copyLength), this.length)
      this.length += copyLength
      offset += copyLength
      if (this.length === this.buffer.length) {
        emit(this.buffer)
        this.buffer = new Float32Array(this.batchSize)
        this.length = 0
      }
    }
  }
}
