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

export class AudioReceiver {
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null
  private audioWorkletNode: AudioWorkletNode | null = null
  private scriptProcessorNode: ScriptProcessorNode | null = null // Fallback
  private onAudioDataCallback: (samples: Float32Array) => void
  private isListening = false
  private diagnostics: AudioDiagnosticsInfo | null = null

  constructor(options: AudioRxOptions) {
    this.onAudioDataCallback = options.onAudioData
  }

  public async start(deviceId?: string): Promise<AudioDiagnosticsInfo> {
    if (this.isListening) {
      return this.diagnostics!
    }

    // 1. Request microphone input with processing disabled where supported
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
      // Fallback to basic audio constraint if strict ones fail
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    }

    const audioTrack = this.mediaStream.getAudioTracks()[0]!
    const trackSettings = audioTrack.getSettings()

    // 2. Setup AudioContext
    const requestedSampleRate = trackSettings.sampleRate || 48000
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: requestedSampleRate })

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }

    this.mediaStreamSource = this.audioContext.createMediaStreamSource(this.mediaStream)

    let workletActive = false
    try {
      // 3. Prefer AudioWorklet for real-time capture
      await this.audioContext.audioWorklet.addModule('/acoustic-rx-worklet.js')
      this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'acoustic-rx-worklet')
      this.audioWorkletNode.port.onmessage = (event) => {
        if (event.data.type === 'audio_samples') {
          const samples = event.data.samples as Float32Array
          this.onAudioDataCallback(samples)
        }
      }
      this.mediaStreamSource.connect(this.audioWorkletNode)
      // AudioWorkletNode does not need to connect to destination if we only process input
      workletActive = true
      console.log('AudioWorklet-based receiver started.')
    } catch (e) {
      console.warn('AudioWorklet for receiver failed, using ScriptProcessorNode fallback', e)
      // 4. Fallback to ScriptProcessorNode
      const bufferSize = 2048
      this.scriptProcessorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1)
      this.scriptProcessorNode.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer.getChannelData(0)
        const samples = new Float32Array(inputBuffer.length)
        samples.set(inputBuffer)
        this.onAudioDataCallback(samples)
      }
      this.mediaStreamSource.connect(this.scriptProcessorNode)
      // ScriptProcessorNode needs connection to destination to work in some browsers
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

    console.log('Audio receiver stopped.')
  }

  public getDiagnostics(): AudioDiagnosticsInfo | null {
    return this.diagnostics
  }

  public getSampleRate(): number {
    return this.audioContext?.sampleRate || 48000
  }
}
