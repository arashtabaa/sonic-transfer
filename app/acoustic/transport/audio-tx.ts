import type { AudioFrame } from '../modulation/modem'

interface AudioTxOptions {
  sampleRate?: number
  gain?: number
}

function getWorkletPath(filename: string): string {
  const baseURL = (typeof window !== 'undefined' && (window as any).__NUXT__?.config?.app?.baseURL) || '/'
  const cleanBase = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return `${cleanBase}${filename.replace(/^\//, '')}`
}

/**
 * Manages speaker output for acoustic transmission using Web Audio API.
 * Uses AudioWorklet for sample generation or falls back to BufferSourceNode.
 */
export class AudioTransmitter {
  private audioContext: AudioContext | null = null
  private audioWorkletNode: AudioWorkletNode | null = null
  private gainNode: GainNode | null = null
  private isPlaying = false
  private queue: AudioFrame[] = []
  private isBufferSourceActive = false
  private drainedResolvers: Array<() => void> = []

  constructor(private options: AudioTxOptions = {}) {}

  public async start(): Promise<void> {
    if (!this.audioContext) {
      const sampleRate = this.options.sampleRate || 48000
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate })
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }
    if (this.isPlaying) return

    this.gainNode = this.audioContext.createGain()
    this.gainNode.gain.value = this.options.gain ?? 0.7
    this.gainNode.connect(this.audioContext.destination)

    const workletPath = getWorkletPath('acoustic-tx-worklet.js')

    try {
      await this.audioContext.audioWorklet.addModule(workletPath)
      this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'acoustic-tx-worklet')
      this.audioWorkletNode.connect(this.gainNode)
      this.audioWorkletNode.port.onmessage = (event) => {
        if (event.data === 'fill_buffer') {
          this.sendNextFrameToWorklet()
        }
      }
      this.isPlaying = true
      this.sendNextFrameToWorklet()
    } catch (e) {
      console.warn(`AudioWorklet (${workletPath}) failed, using BufferSourceNode fallback`, e)
      this.isPlaying = true
      if (this.queue.length > 0) {
        this.playBufferSourceQueue()
      }
    }
  }

  public stop(): void {
    if (!this.isPlaying) return
    this.isPlaying = false
    this.queue = []
    this.isBufferSourceActive = false

    if (this.audioWorkletNode) {
      this.audioWorkletNode.disconnect()
      this.audioWorkletNode = null
    }

    this.notifyDrained()
  }

  public enqueueFrame(frame: AudioFrame): void {
    this.queue.push(frame)
    if (this.isPlaying) {
      if (this.audioWorkletNode) {
        this.sendNextFrameToWorklet()
      } else if (!this.isBufferSourceActive) {
        this.playBufferSourceQueue()
      }
    }
  }

  public async playFrame(frame: AudioFrame): Promise<void> {
    this.enqueueFrame(frame)
    await this.waitUntilDrained()
  }

  public isQueueEmpty(): boolean {
    return this.queue.length === 0 && !this.isBufferSourceActive
  }

  public waitUntilDrained(): Promise<void> {
    if (this.isQueueEmpty()) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.drainedResolvers.push(resolve)
    })
  }

  private notifyDrained(): void {
    const resolvers = this.drainedResolvers
    this.drainedResolvers = []
    resolvers.forEach(r => r())
  }

  public setGain(gain: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = gain
    }
  }

  private sendNextFrameToWorklet(): void {
    if (!this.audioWorkletNode || !this.isPlaying) return

    if (this.queue.length > 0) {
      const frame = this.queue.shift()!
      this.audioWorkletNode.port.postMessage({ type: 'play_samples', samples: frame.samples })
    } else {
      this.notifyDrained()
    }
  }

  private playBufferSourceQueue(): void {
    if (!this.isPlaying || !this.audioContext || !this.gainNode || this.queue.length === 0) {
      this.isBufferSourceActive = false
      this.notifyDrained()
      return
    }

    this.isBufferSourceActive = true
    const frame = this.queue.shift()!
    const buffer = this.audioContext.createBuffer(1, frame.samples.length, this.audioContext.sampleRate)
    buffer.copyToChannel(frame.samples, 0)

    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(this.gainNode)
    source.onended = () => {
      this.isBufferSourceActive = false
      if (this.isPlaying && this.queue.length > 0) {
        this.playBufferSourceQueue()
      } else {
        this.notifyDrained()
      }
    }
    source.start()
  }

  public getSampleRate(): number {
    return this.audioContext?.sampleRate || this.options.sampleRate || 48000
  }

  public getContextState(): AudioContextState | 'uninitialized' {
    return this.audioContext?.state || 'uninitialized'
  }
}
