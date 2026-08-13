import type { AudioFrame } from '../modulation/modem'

interface AudioTxOptions {
  sampleRate?: number
  gain?: number
}

interface QueuedFrameItem {
  frameId: number
  frame: AudioFrame
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
  private workletInFlightFrameIds = new Set<number>()
  private workletDrained = false
  private frameResolvers = new Map<number, { resolve: () => void; reject: (reason?: any) => void }>()
  private drainedResolvers: Array<() => void> = []
  private nextFrameId = 1

  constructor(private options: AudioTxOptions = {}) {}

  public async start(): Promise<void> {
    if (!this.audioContext) {
      const sampleRate = this.options.sampleRate || 48000
      if (typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
        this.audioContext = new AudioCtx({ sampleRate })
      } else {
        // Mock headless AudioContext for Node unit tests
        this.audioContext = {
          sampleRate,
          state: 'running',
          destination: {} as any,
          createGain: () => ({ gain: { value: 1 }, connect: () => {} } as any),
          createBuffer: () => ({ copyToChannel: () => {} } as any),
          createBufferSource: () => ({ buffer: null, connect: () => {}, start: function() { setTimeout(() => this.onended && this.onended(), 10) }, onended: null } as any),
          resume: async () => {},
        } as any
      }
    }

    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }
    if (!this.audioContext) return
    if (this.isPlaying) return

    this.gainNode = this.audioContext.createGain()
    this.gainNode.gain.value = this.options.gain ?? 0.7
    this.gainNode.connect(this.audioContext!.destination)

    const workletPath = getWorkletPath('acoustic-tx-worklet.js')

    try {
      await this.audioContext!.audioWorklet.addModule(workletPath)
      this.audioWorkletNode = new AudioWorkletNode(this.audioContext!, 'acoustic-tx-worklet')
      this.audioWorkletNode.connect(this.gainNode)
      this.audioWorkletNode.port.onmessage = (event) => {
        if (!event.data) return
        if (event.data.type === 'fill_buffer') {
          this.sendNextFrameToWorklet()
        } else if (event.data.type === 'frame_finished') {
          const frameId = event.data.frameId as number
          this.workletInFlightFrameIds.delete(frameId)
          const resolver = this.frameResolvers.get(frameId)
          if (resolver) {
            this.frameResolvers.delete(frameId)
            resolver.resolve()
          }
          if (this.isQueueEmpty()) {
            this.notifyDrained()
          }
        } else if (event.data.type === 'worklet_drained') {
          this.workletDrained = true
          if (this.isQueueEmpty()) {
            this.notifyDrained()
          }
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
    this.workletInFlightFrameIds.clear()
    this.workletDrained = true

    if (this.audioWorkletNode) {
      this.audioWorkletNode.disconnect()
      this.audioWorkletNode = null
    }

    // Requirement 2: Reject pending promises with explicit TransmissionCancelledError on stop!
    const err = new Error('TransmissionCancelledError: Playback stopped before frame completed')
    this.frameResolvers.forEach(r => r.reject(err))
    this.frameResolvers.clear()
    this.notifyDrained()
  }

  public enqueueFrame(frame: AudioFrame): number {
    this.workletDrained = false
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
    return new Promise((resolve, reject) => {
      this.frameResolvers.set(frameId, { resolve, reject })
    })
  }

  public isQueueEmpty(): boolean {
    const workletOk = this.audioWorkletNode ? (this.workletInFlightFrameIds.size === 0 && this.workletDrained) : true
    return this.queue.length === 0 && workletOk && !this.isBufferSourceActive && this.frameResolvers.size === 0
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
      this.workletInFlightFrameIds.add(item.frameId)
      this.audioWorkletNode.port.postMessage({
        type: 'play_samples',
        frameId: item.frameId,
        samples: item.frame.samples,
      })
    }
  }

  private playBufferSourceQueue(): void {
    if (!this.isPlaying || !this.audioContext || !this.gainNode || this.queue.length === 0) {
      this.isBufferSourceActive = false
      if (this.isQueueEmpty()) {
        this.notifyDrained()
      }
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

      // Requirement 2: Resolve frame promise on source.onended ONLY!
      const resolver = this.frameResolvers.get(item.frameId)
      if (resolver) {
        this.frameResolvers.delete(item.frameId)
        resolver.resolve()
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
