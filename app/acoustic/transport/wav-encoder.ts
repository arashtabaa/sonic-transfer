/**
 * Lossless 16-bit PCM WAV File Encoder
 */
export function encodeWavBlob(pcm: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  /* RIFF chunk descriptor */
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')

  /* fmt sub-chunk */
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true) // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  /* data sub-chunk */
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // Write 16-bit PCM samples
  let offset = 44
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!))
    const sample16 = s < 0 ? s * 0x8000 : s * 0x7FFF
    view.setInt16(offset, sample16, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export interface DecodedWavPcm {
  pcm: Float32Array
  sampleRate: number
}

/** Decode the lossless PCM WAV reference format emitted above. */
export function decodeWavPcm(buffer: ArrayBuffer): DecodedWavPcm {
  const view = new DataView(buffer)
  if (view.byteLength < 44 || readString(view, 0, 4) !== 'RIFF' || readString(view, 8, 4) !== 'WAVE') {
    throw new Error('Unsupported WAV container')
  }
  if (view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16) {
    throw new Error('Only 16-bit mono PCM WAV is supported')
  }
  const dataOffset = findChunk(view, 'data', 12)
  const dataSize = view.getUint32(dataOffset + 4, true)
  const sampleRate = view.getUint32(24, true)
  const sampleCount = Math.floor(Math.min(dataSize, view.byteLength - dataOffset - 8) / 2)
  const pcm = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) pcm[i] = view.getInt16(dataOffset + 8 + i * 2, true) / 0x8000
  return { pcm, sampleRate }
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i))
  }
}

function readString(view: DataView, offset: number, length: number): string {
  let result = ''
  for (let i = 0; i < length; i++) result += String.fromCharCode(view.getUint8(offset + i))
  return result
}

function findChunk(view: DataView, name: string, start: number): number {
  let offset = start
  while (offset + 8 <= view.byteLength) {
    const chunkName = readString(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    if (chunkName === name) return offset
    offset += 8 + size + (size & 1)
  }
  throw new Error(`WAV ${name} chunk not found`)
}
