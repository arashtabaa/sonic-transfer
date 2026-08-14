/**
 * OGG / Opus Audio Artifact Exporter & Browser Capability Detector
 */

export interface OggExportCapability {
  supported: boolean
  mimeType: string
  reason?: string
}

export function detectOggOpusSupport(): OggExportCapability {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return { supported: false, mimeType: '', reason: 'MediaRecorder unavailable in this environment' }
  }

  const mimeTypes = [
    'audio/ogg; codecs=opus',
    'audio/ogg',
    'audio/webm; codecs=opus',
  ]

  for (const mime of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return { supported: true, mimeType: mime }
    }
  }

  return { supported: false, mimeType: '', reason: 'OGG/Opus recording unsupported by browser' }
}

/**
 * Encodes Float32Array PCM into an OGG/Opus audio Blob using Web Audio API MediaStreamDestination.
 */
export async function encodeOggOpusBlob(pcm: Float32Array, sampleRate: number): Promise<Blob> {
  const cap = detectOggOpusSupport()
  if (!cap.supported) {
    throw new Error(cap.reason || 'OGG/Opus unsupported')
  }

  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate })
  if (ctx.state === 'suspended') await ctx.resume()

  const buffer = ctx.createBuffer(1, pcm.length, sampleRate)
  buffer.copyToChannel(pcm, 0)

  const source = ctx.createBufferSource()
  source.buffer = buffer

  const dest = ctx.createMediaStreamDestination()
  source.connect(dest)

  const recorder = new MediaRecorder(dest.stream, { mimeType: cap.mimeType })
  const chunks: Blob[] = []

  const recordingPromise = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => {
      ctx.close()
      resolve(new Blob(chunks, { type: cap.mimeType }))
    }
    recorder.onerror = e => reject(e)
  })

  recorder.start()
  source.start(0)

  source.onended = () => {
    setTimeout(() => {
      recorder.stop()
    }, 100)
  }

  return recordingPromise
}
