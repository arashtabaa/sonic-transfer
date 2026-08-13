// @ts-nocheck
class AcousticTxWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.currentBuffer = null
    this.bufferOffset = 0
    this.port.onmessage = (event) => {
      if (event.data.type === 'play_samples') {
        this.queue.push(event.data.samples)
      }
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0]

    for (let i = 0; i < output.length; i++) {
      if (!this.currentBuffer || this.bufferOffset >= this.currentBuffer.length) {
        if (this.queue.length > 0) {
          this.currentBuffer = this.queue.shift()
          this.bufferOffset = 0
        } else {
          output[i] = 0
          continue
        }
      }
      output[i] = this.currentBuffer[this.bufferOffset++]
    }

    if (this.queue.length < 2) {
      this.port.postMessage('fill_buffer')
    }

    return true
  }
}

registerProcessor('acoustic-tx-worklet', AcousticTxWorkletProcessor)
