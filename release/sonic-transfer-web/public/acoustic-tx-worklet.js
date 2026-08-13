// @ts-nocheck
class AcousticTxWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.currentFrameId = null
    this.currentBuffer = null
    this.bufferOffset = 0
    this.wasProcessing = false

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'play_samples') {
        this.queue.push({
          frameId: event.data.frameId || 0,
          samples: event.data.samples,
        })
      }
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0]
    if (!output) return true

    for (let i = 0; i < output.length; i++) {
      if (!this.currentBuffer || this.bufferOffset >= this.currentBuffer.length) {
        // Report finished frame ONLY after last sample has been written to output!
        if (this.currentBuffer && this.currentFrameId !== null) {
          this.port.postMessage({ type: 'frame_finished', frameId: this.currentFrameId })
          this.currentFrameId = null
          this.currentBuffer = null
        }

        if (this.queue.length > 0) {
          const item = this.queue.shift()
          this.currentFrameId = item.frameId
          this.currentBuffer = item.samples
          this.bufferOffset = 0
          this.wasProcessing = true
        } else {
          output[i] = 0
          if (this.wasProcessing) {
            this.wasProcessing = false
            this.port.postMessage({ type: 'worklet_drained' })
          }
          continue
        }
      }

      output[i] = this.currentBuffer[this.bufferOffset++]
    }

    if (this.queue.length < 2) {
      this.port.postMessage({ type: 'fill_buffer' })
    }

    return true
  }
}

registerProcessor('acoustic-tx-worklet', AcousticTxWorkletProcessor)
