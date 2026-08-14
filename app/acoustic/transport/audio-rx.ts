interface AudioRxOptions {
  onAudioData: (samples: Float32Array) => void
  sampleRate?: number
}

export interface AudioDiagnosticsInfo {
  inputSampleRate: number
  audioContextSampleRate: number
  channelCount: number
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  selectedMicrophone: string
  audioWorkletActive: boolean
}

function getWorkletPath(filename: string): string {
  const baseURL = (typeof window !== 'undefined' && (window as any).__NUXT__?.config?.app?.baseURL) || '/'
  const cleanBase = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return `${cleanBase}${filename.replace(/^\//, '')}`
}

export class AudioReceiver {
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null
  private audioWorkletNode: AudioWorkletNode | null = null
  private scriptProcessorNode: ScriptProcessorNode | null = null
  private onAudioDataCallback: (samples: Float32Array) => void
  private isListening = false
  private diagnostics: AudioDiagnosticsInfo | null = null

  constructor(options: AudioRxOptions) {
    this.onAudioDataCallback = options.onAudioData
  }

  public setOnAudioDataCallback(fn: (samples: Float32Array) => void): void {
    this.onAudioDataCallback = fn
  }

  public async start(deviceId?: string): Promise<AudioDiagnosticsInfo> {
    if (this.isListening) {
      return this.diagnostics!
    }

    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (e) {
      console.warn('Failed to get mediaStream with disabled processing constraints, retrying basic constraints', e)
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    }

    const audioTrack = this.mediaStream.getAudioTracks()[0]!
    const trackSettings = audioTrack.getSettings()

    const requestedSampleRate = trackSettings.sampleRate || 48000
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: requestedSampleRate })

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }

    this.mediaStreamSource = this.audioContext.createMediaStreamSource(this.mediaStream)

    let workletActive = false
    const workletPath = getWorkletPath('acoustic-rx-worklet.js')

    try {
      await this.audioContext.audioWorklet.addModule(workletPath)
      this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'acoustic-rx-worklet')
      this.audioWorkletNode.port.onmessage = (event) => {
        if (event.data.type === 'audio_samples') {
          const samples = event.data.samples as Float32Array
          this.onAudioDataCallback(samples)
        }
      }
      this.mediaStreamSource.connect(this.audioWorkletNode)
      workletActive = true
    } catch (e) {
      console.warn(`AudioWorklet (${workletPath}) failed, using ScriptProcessorNode fallback`, e)
      const bufferSize = 2048
      this.scriptProcessorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1)
      this.scriptProcessorNode.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer.getChannelData(0)
        const samples = new Float32Array(inputBuffer.length)
        samples.set(inputBuffer)
        this.onAudioDataCallback(samples)
      }
      this.mediaStreamSource.connect(this.scriptProcessorNode)
      this.scriptProcessorNode.connect(this.audioContext.destination)
    }

    this.isListening = true

    this.diagnostics = {
      inputSampleRate: trackSettings.sampleRate || this.audioContext.sampleRate,
      audioContextSampleRate: this.audioContext.sampleRate,
      channelCount: trackSettings.channelCount || 1,
      echoCancellation: trackSettings.echoCancellation ?? false,
      noiseSuppression: trackSettings.noiseSuppression ?? false,
      autoGainControl: trackSettings.autoGainControl ?? false,
      selectedMicrophone: audioTrack.label || 'Default Microphone',
      audioWorkletActive: workletActive,
    }

    return this.diagnostics
  }

  public stop(): void {
    if (!this.isListening) return

    this.isListening = false

    if (this.audioWorkletNode) {
      this.audioWorkletNode.disconnect()
      this.audioWorkletNode = null
    }

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect()
      this.scriptProcessorNode = null
    }

    if (this.mediaStreamSource) {
      this.mediaStreamSource.disconnect()
      this.mediaStreamSource = null
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop())
      this.mediaStream = null
    }

    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
  }

  public getDiagnostics(): AudioDiagnosticsInfo | null {
    return this.diagnostics
  }

  public isActive(): boolean {
    return this.isListening
  }

  public getSampleRate(): number {
    return this.audioContext?.sampleRate || 48000
  }
}
