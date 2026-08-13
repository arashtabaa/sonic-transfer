import type { AudioFrame, ModemConfig } from '../modulation/modem'

interface AudioTxOptions {
  sampleRate: number
  gain: number
}

/**
 * Manages speaker output for acoustic transmission using Web Audio API.
 * Can use AudioWorklet for sample generation or fall back to BufferSourceNode.
 */
export class AudioTransmitter {
  private audioContext: AudioContext
  private audioWorkletNode: AudioWorkletNode | null = null
  private gainNode: GainNode
  private isPlaying = false
  private queue: AudioFrame[] = []

  constructor(options: AudioTxOptions) {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: options.sampleRate })
    this.gainNode = this.audioContext.createGain()
    this.gainNode.gain.value = options.gain
    this.gainNode.connect(this.audioContext.destination)
  }

  public async start(): Promise<void> {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }
    if (this.isPlaying) return

    try {
      // Try to use AudioWorklet for better performance and real-time generation
      await this.audioContext.audioWorklet.addModule('/acoustic-tx-worklet.js')
      this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'acoustic-tx-worklet')
      this.audioWorkletNode.connect(this.gainNode)
      this.audioWorkletNode.port.onmessage = (event) => {
        if (event.data === 'fill_buffer') {
          this.sendNextFrameToWorklet()
        }
      }
      this.isPlaying = true
      this.sendNextFrameToWorklet()
      console.log('AudioWorklet-based transmitter started.')
    } catch (e) {
      console.warn('AudioWorklet not available or failed, falling back to BufferSourceNode', e)
      // Fallback to BufferSourceNode if AudioWorklet is not supported
      this.isPlaying = true
      this.playBufferSourceQueue()
    }
  }

  public stop(): void {
    if (!this.isPlaying) return
    this.isPlaying = false
    this.queue = []

    if (this.audioWorkletNode) {
      this.audioWorkletNode.disconnect()
      this.audioWorkletNode = null
    } else {
      // For BufferSourceNode fallback, stopping happens by not queueing new sources
    }
    console.log('Audio transmitter stopped.')
  }

  public enqueueFrame(frame: AudioFrame): void {
    this.queue.push(frame)
    if (this.isPlaying && !this.audioWorkletNode) {
      // If using BufferSourceNode fallback, start playing if not already
      // This might need more sophisticated queue management to avoid re-triggering constantly
      // For now, assume a continuous loop or a single play call is managed externally
      // this.playBufferSourceQueue()
    }
  }

  public setGain(gain: number): void {
    this.gainNode.gain.value = gain
  }

  private sendNextFrameToWorklet(): void {
    if (!this.audioWorkletNode || !this.isPlaying) return

    if (this.queue.length > 0) {
      const frame = this.queue.shift()!
      this.audioWorkletNode.port.postMessage({ type: 'play_samples', samples: frame.samples })
    } else {
      // Keep sending 'empty' messages or signal ready for more data
      // This can be used to manage flow control between main thread and worklet
      // For simplicity, we assume worklet will ask for more when needed
    }
  }

  private playBufferSourceQueue(): void {
    if (!this.isPlaying || this.queue.length === 0) return

    // This fallback is simplified. For real-time continuous playback, a more advanced
    // scheduling mechanism for BufferSourceNodes is needed (like a look-ahead queue).
    // This might cause gaps or timing issues compared to AudioWorklet.

    const frame = this.queue.shift()!
    const buffer = this.audioContext.createBuffer(1, frame.samples.length, this.audioContext.sampleRate)
    buffer.copyToChannel(frame.samples, 0)

    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(this.gainNode)
    source.onended = () => {
      // Only re-queue if still playing and there are more frames
      if (this.isPlaying && this.queue.length > 0) {
        this.playBufferSourceQueue()
      }
    }
    source.start()
  }

  public getSampleRate(): number {
    return this.audioContext.sampleRate
  }

  public getContextState(): AudioContextState {
    return this.audioContext.state
  }
}
