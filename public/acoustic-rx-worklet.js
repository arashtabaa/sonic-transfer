// @ts-nocheck
class AcousticRxWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.batchSize = 1024
    this.batch = new Float32Array(this.batchSize)
    this.batchLength = 0
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    if (input && input.length > 0) {
      const channelData = input[0]
      let offset = 0
      while (offset < channelData.length) {
        const copyLength = Math.min(this.batchSize - this.batchLength, channelData.length - offset)
        this.batch.set(channelData.subarray(offset, offset + copyLength), this.batchLength)
        this.batchLength += copyLength
        offset += copyLength
        if (this.batchLength === this.batchSize) {
          const samplesCopy = this.batch
          this.batch = new Float32Array(this.batchSize)
          this.batchLength = 0
          this.port.postMessage({ type: 'audio_samples', samples: samplesCopy }, [samplesCopy.buffer])
        }
      }
    }
    return true
  }
}

registerProcessor('acoustic-rx-worklet', AcousticRxWorkletProcessor)
