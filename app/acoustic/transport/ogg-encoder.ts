/** Genuine client-side Ogg Opus artifact support. */

export interface OggExportCapability {
  supported: boolean
  mimeType: 'audio/ogg; codecs=opus' | ''
  reason?: string
}

export interface DecodedOggOpusPcm {
  pcm: Float32Array
  sampleRate: number
}

export interface OggCodecMetrics {
  referenceDurationMs: number
  decodedDurationMs: number
  durationDifferenceMs: number
  referenceRms: number
  decodedRms: number
  rmsError: number
}

interface EncodedOpusPacket {
  data: Uint8Array
  sampleCount: number
}

export function detectOggOpusSupport(): OggExportCapability {
  const scope = typeof window !== 'undefined' ? window as any : globalThis as any
  if (!scope.AudioEncoder || !scope.AudioDecoder || !scope.AudioData || !scope.EncodedAudioChunk) {
    return { supported: false, mimeType: '', reason: 'WebCodecs Opus encoder/decoder unavailable in this browser' }
  }
  return { supported: true, mimeType: 'audio/ogg; codecs=opus' }
}

/** Encode PCM with WebCodecs Opus and mux the packets into a genuine Ogg stream. */
export async function encodeOggOpusBlob(pcm: Float32Array, sampleRate: number): Promise<Blob> {
  const bytes = await encodeOggOpus(pcm, sampleRate)
  return new Blob([bytes], { type: 'audio/ogg; codecs=opus' })
}

export async function encodeOggOpus(pcm: Float32Array, sampleRate: number): Promise<Uint8Array> {
  const capability = detectOggOpusSupport()
  if (!capability.supported) throw new Error(capability.reason || 'OGG/Opus unsupported')

  const scope = typeof window !== 'undefined' ? window as any : globalThis as any
  const packets: EncodedOpusPacket[] = []
  const encoder = new scope.AudioEncoder({
    output: (chunk: any) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      packets.push({ data, sampleCount: Math.round(sampleRate * 0.02) })
    },
    error: (error: unknown) => { throw error },
  })

  try {
    const config = { codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 64000 }
    const support = await scope.AudioEncoder.isConfigSupported(config)
    if (!support.supported) throw new Error(`WebCodecs does not support Opus at ${sampleRate} Hz`)
    encoder.configure(config)

    const frameSize = Math.max(1, Math.round(sampleRate * 0.02))
    for (let offset = 0, timestamp = 0; offset < pcm.length; offset += frameSize, timestamp += 20000) {
      const frame = new Float32Array(frameSize)
      frame.set(pcm.subarray(offset, Math.min(offset + frameSize, pcm.length)))
      const audioData = new scope.AudioData({
        format: 'f32',
        sampleRate,
        numberOfFrames: frameSize,
        numberOfChannels: 1,
        timestamp,
        data: frame,
      })
      encoder.encode(audioData)
      audioData.close()
    }
    await encoder.flush()
  } finally {
    encoder.close()
  }

  return muxOggOpus(packets, sampleRate)
}

/** Decode Ogg pages and Opus packets with the browser's client-side decoder. */
export async function decodeOggOpusPcm(bytes: Uint8Array): Promise<DecodedOggOpusPcm> {
  const capability = detectOggOpusSupport()
  if (!capability.supported) throw new Error(capability.reason || 'OGG/Opus unsupported')

  const parsed = parseOggOpus(bytes)
  const head = parsed.packets[0]!
  const sampleRate = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(12, true)
  const scope = typeof window !== 'undefined' ? window as any : globalThis as any
  const chunks: Float32Array[] = []
  let totalFrames = 0
  const decoder = new scope.AudioDecoder({
    output: (audioData: any) => {
      const frames = audioData.numberOfFrames
      const values = new Float32Array(frames)
      if (audioData.format === 'f32' || audioData.format === 'f32-planar') {
        audioData.copyTo(values, { planeIndex: 0 })
      } else {
        const int16 = new Int16Array(frames)
        audioData.copyTo(int16, { planeIndex: 0 })
        for (let i = 0; i < frames; i++) values[i] = int16[i]! / 0x8000
      }
      chunks.push(values)
      totalFrames += frames
      audioData.close()
    },
    error: (error: unknown) => { throw error },
  })

  try {
    decoder.configure({ codec: 'opus', sampleRate, numberOfChannels: 1 })
    let timestamp = 0
    for (const packet of parsed.packets.slice(2)) {
      decoder.decode(new scope.EncodedAudioChunk({ type: 'key', timestamp, data: packet }))
      timestamp += 20000
    }
    await decoder.flush()
  } finally {
    decoder.close()
  }

  const pcm = new Float32Array(totalFrames)
  let offset = 0
  for (const chunk of chunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  return { pcm, sampleRate }
}

export function measureOggCodecMetrics(reference: Float32Array, decoded: Float32Array, referenceRate: number, decodedRate: number): OggCodecMetrics {
  const referenceRms = rms(reference)
  const decodedRms = rms(decoded)
  const compareLength = Math.min(reference.length, decoded.length)
  let error = 0
  for (let i = 0; i < compareLength; i++) {
    const difference = reference[i]! - decoded[i]!
    error += difference * difference
  }
  return {
    referenceDurationMs: (reference.length / referenceRate) * 1000,
    decodedDurationMs: (decoded.length / decodedRate) * 1000,
    durationDifferenceMs: (decoded.length / decodedRate - reference.length / referenceRate) * 1000,
    referenceRms,
    decodedRms,
    rmsError: Math.sqrt(error / (compareLength || 1)),
  }
}

export interface ParsedOggOpus {
  sampleRate: number
  packets: Uint8Array[]
}

/** Structural parser used by the decoder and deterministic container tests. */
export function parseOggOpus(bytes: Uint8Array): ParsedOggOpus {
  const packets: Uint8Array[] = []
  let offset = 0
  let current: number[] = []
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || readAscii(bytes, offset, 4) !== 'OggS') throw new Error('Invalid Ogg page')
    const segmentCount = bytes[offset + 26]!
    const tableEnd = offset + 27 + segmentCount
    if (tableEnd > bytes.length) throw new Error('Truncated Ogg segment table')
    const bodyLength = bytes.subarray(offset + 27, tableEnd).reduce((sum, length) => sum + length, 0)
    const bodyEnd = tableEnd + bodyLength
    if (bodyEnd > bytes.length) throw new Error('Truncated Ogg page body')
    const page = bytes.slice(offset, bodyEnd)
    const expectedCrc = new DataView(page.buffer).getUint32(22, true)
    new DataView(page.buffer).setUint32(22, 0, true)
    if (oggCrc32(page) !== expectedCrc) throw new Error('Ogg page CRC mismatch')
    let bodyOffset = tableEnd
    for (const length of bytes.subarray(offset + 27, tableEnd)) {
      current.push(...bytes.subarray(bodyOffset, bodyOffset + length))
      bodyOffset += length
      if (length < 255) {
        packets.push(new Uint8Array(current))
        current = []
      }
    }
    offset = bodyEnd
  }
  const head = packets[0]
  const tags = packets[1]
  if (!head || head.length < 19 || readAscii(head, 0, 8) !== 'OpusHead') throw new Error('Ogg stream does not contain OpusHead')
  if (!tags || readAscii(tags, 0, 8) !== 'OpusTags') throw new Error('Ogg stream does not contain OpusTags')
  const sampleRate = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(12, true)
  return { sampleRate, packets }
}

function muxOggOpus(packets: EncodedOpusPacket[], sampleRate: number): Uint8Array {
  const serial = 0x534f4e49
  const pages: Uint8Array[] = []
  pages.push(createOggPage(opusHead(sampleRate), serial, 0, 0x02, 0))
  pages.push(createOggPage(opusTags(), serial, 0, 0, 1))
  let granule = 0
  packets.forEach((packet, index) => {
    granule += packet.sampleCount
    pages.push(createOggPage(packet.data, serial, granule, 0, index + 2))
  })
  const result = new Uint8Array(pages.reduce((sum, page) => sum + page.length, 0))
  let offset = 0
  for (const page of pages) {
    result.set(page, offset)
    offset += page.length
  }
  return result
}

function opusHead(sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(19)
  bytes.set(new TextEncoder().encode('OpusHead'), 0)
  bytes[8] = 1
  bytes[9] = 1
  new DataView(bytes.buffer).setUint16(10, 0, true)
  new DataView(bytes.buffer).setUint32(12, sampleRate, true)
  return bytes
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('Sonic Transfer')
  const bytes = new Uint8Array(8 + 4 + vendor.length + 4)
  bytes.set(new TextEncoder().encode('OpusTags'), 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, vendor.length, true)
  bytes.set(vendor, 12)
  view.setUint32(12 + vendor.length, 0, true)
  return bytes
}

export function createOggPage(packet: Uint8Array, serial: number, granule: number, headerType: number, sequence: number): Uint8Array {
  const segmentCount = Math.ceil(packet.length / 255) + (packet.length % 255 === 0 ? 1 : 0)
  if (segmentCount > 255) throw new Error('Opus packet is too large for one Ogg page')
  const page = new Uint8Array(27 + segmentCount + packet.length)
  page.set(new TextEncoder().encode('OggS'), 0)
  page[4] = 0
  page[5] = headerType
  writeUint64(page, 6, granule)
  new DataView(page.buffer).setUint32(14, serial, true)
  new DataView(page.buffer).setUint32(18, sequence, true)
  page[26] = segmentCount
  let remaining = packet.length
  for (let i = 0; i < segmentCount; i++) {
    page[27 + i] = Math.min(255, remaining)
    remaining -= page[27 + i]!
  }
  page.set(packet, 27 + segmentCount)
  new DataView(page.buffer).setUint32(22, oggCrc32(page), true)
  return page
}

function oggCrc32(bytes: Uint8Array): number {
  let crc = 0
  for (const byte of bytes) {
    crc ^= byte << 24
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1
  }
  return crc >>> 0
}

function writeUint64(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer)
  view.setUint32(offset, value >>> 0, true)
  view.setUint32(offset + 4, Math.floor(value / 0x100000000) >>> 0, true)
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / (samples.length || 1))
}
