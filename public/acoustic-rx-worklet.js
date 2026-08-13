// @ts-nocheck
class AcousticRxWorkletProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0]
    if (input && input.length > 0) {
      const channelData = input[0]
      const samplesCopy = new Float32Array(channelData.length)
      samplesCopy.set(channelData)
      this.port.postMessage({ type: 'audio_samples', samples: samplesCopy }, [samplesCopy.buffer])
    }
    return true
  }
}

registerProcessor('acoustic-rx-worklet', AcousticRxWorkletProcessor)
