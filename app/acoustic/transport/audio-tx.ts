import type { AudioFrame } from '../modulation/modem'

interface AudioTxOptions {
  sampleRate?: number
  gain?: number
}

interface QueuedFrameItem {
  frameId: number
  frame: AudioFrame
  resolve?: () => void
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
  private queue: QueuedFrameItem[] = []
  private isBufferSourceActive = false
  private frameResolvers = new Map<number, () => void>()
  private drainedResolvers: Array<() => void> = []
  private nextFrameId = 1

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
        if (!event.data) return
        if (event.data.type === 'fill_buffer') {
          this.sendNextFrameToWorklet()
        } else if (event.data.type === 'frame_finished') {
          const frameId = event.data.frameId as number
          const resolver = this.frameResolvers.get(frameId)
          if (resolver) {
            this.frameResolvers.delete(frameId)
            resolver()
          }
        } else if (event.data.type === 'worklet_drained') {
          this.notifyDrained()
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

    this.frameResolvers.forEach(r => r())
    this.frameResolvers.clear()
    this.notifyDrained()
  }

  public enqueueFrame(frame: AudioFrame): number {
    const frameId = this.nextFrameId++
    const item: QueuedFrameItem = { frameId, frame }
    this.queue.push(item)

    if (this.isPlaying) {
      if (this.audioWorkletNode) {
        this.sendNextFrameToWorklet()
      } else if (!this.isBufferSourceActive) {
        this.playBufferSourceQueue()
      }
    }
    return frameId
  }

  public playFrame(frame: AudioFrame): Promise<void> {
    const frameId = this.enqueueFrame(frame)
    return new Promise((resolve) => {
      this.frameResolvers.set(frameId, resolve)
    })
  }

  public isQueueEmpty(): boolean {
    return this.queue.length === 0 && !this.isBufferSourceActive && this.frameResolvers.size === 0
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
      const item = this.queue.shift()!
      this.audioWorkletNode.port.postMessage({
        type: 'play_samples',
        frameId: item.frameId,
        samples: item.frame.samples,
      })
    } else if (this.queue.length === 0 && this.frameResolvers.size === 0) {
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
    const item = this.queue.shift()!
    const buffer = this.audioContext.createBuffer(1, item.frame.samples.length, this.audioContext.sampleRate)
    buffer.copyToChannel(item.frame.samples, 0)

    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(this.gainNode)
    source.onended = () => {
      this.isBufferSourceActive = false

      // Resolve frame promise on source.onended ONLY!
      const resolver = this.frameResolvers.get(item.frameId)
      if (resolver) {
        this.frameResolvers.delete(item.frameId)
        resolver()
      }

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
