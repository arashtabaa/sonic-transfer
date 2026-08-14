/** Genuine client-side Ogg Opus artifact support. */

export interface OggExportCapability {
  supported: boolean
  mimeType: 'audio/ogg; codecs=opus' | ''
  status: 'SUPPORTED' | 'NO_WEBCODECS' | 'PROBE_REQUIRED' | 'UNSUPPORTED'
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
  estimatedDelayMs: number
  alignedRmsError: number
}

interface EncodedOpusPacket {
  data: Uint8Array
  sampleCount: number
}

export function detectOggOpusSupport(): OggExportCapability {
  const scope = typeof window !== 'undefined' ? window as any : globalThis as any
  if (!scope.AudioEncoder || !scope.AudioDecoder || !scope.AudioData || !scope.EncodedAudioChunk) {
    return { supported: false, mimeType: '', status: 'NO_WEBCODECS', reason: 'WebCodecs Opus encoder/decoder unavailable in this browser' }
  }
  return { supported: false, mimeType: 'audio/ogg; codecs=opus', status: 'PROBE_REQUIRED', reason: 'WebCodecs capability probe required' }
}

export async function probeOggOpusSupport(sampleRate = 48000): Promise<OggExportCapability> {
  const detected = detectOggOpusSupport()
  if (detected.status === 'NO_WEBCODECS') return detected
  const scope = typeof window !== 'undefined' ? window as any : globalThis as any
  try {
    const encoder = await scope.AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 64000 })
    if (!encoder.supported) return { supported: false, mimeType: '', status: 'UNSUPPORTED', reason: 'Opus encode config is unsupported' }
    const decoder = await scope.AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })
    if (!decoder.supported) return { supported: false, mimeType: '', status: 'UNSUPPORTED', reason: 'Opus decode config is unsupported' }
    return { supported: true, mimeType: 'audio/ogg; codecs=opus', status: 'SUPPORTED' }
  } catch (error: any) {
    return { supported: false, mimeType: '', status: 'UNSUPPORTED', reason: error?.message || 'Opus capability probe failed' }
  }
}

/** Encode PCM with WebCodecs Opus and mux the packets into a genuine Ogg stream. */
export async function encodeOggOpusBlob(pcm: Float32Array, sampleRate: number): Promise<Blob> {
  const bytes = await encodeOggOpus(pcm, sampleRate)
  return new Blob([bytes], { type: 'audio/ogg; codecs=opus' })
}

export async function encodeOggOpus(pcm: Float32Array, sampleRate: number): Promise<Uint8Array> {
  const capability = await probeOggOpusSupport(sampleRate)
  if (!capability.supported) throw new Error(capability.reason || 'OGG/Opus unsupported')

  const scope = typeof window !== 'undefined' ? window as any : globalThis as any
  const packets: EncodedOpusPacket[] = []
  let opusHeadDescription: Uint8Array | undefined
  const encoder = new scope.AudioEncoder({
    output: (chunk: any, metadata: any) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      const description = metadata?.decoderConfig?.description
      if (description && !opusHeadDescription) {
        const candidate = description instanceof Uint8Array ? description : new Uint8Array(description)
        if (readAscii(candidate, 0, 8) === 'OpusHead') opusHeadDescription = candidate.slice()
      }
      packets.push({ data, sampleCount: OPUS_FRAME_SAMPLES })
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

  if (!opusHeadDescription) throw new Error('WebCodecs did not provide OpusHead metadata; standards-compliant Ogg muxing is unsupported')
  return muxOggOpus(packets, opusHeadDescription)
}

/** Decode Ogg pages and Opus packets with the browser's client-side decoder. */
export async function decodeOggOpusPcm(bytes: Uint8Array): Promise<DecodedOggOpusPcm> {
  const capability = await probeOggOpusSupport()
  if (!capability.supported) throw new Error(capability.reason || 'OGG/Opus unsupported')

  const parsed = parseOggOpus(bytes)
  const head = parsed.packets[0]!
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const preSkip = headView.getUint16(10, true)
  const scope = typeof window !== 'undefined' ? window as any : globalThis as any
  const chunks: Float32Array[] = []
  let totalFrames = 0
  let decodedSampleRate = 0
  const decoder = new scope.AudioDecoder({
    output: (audioData: any) => {
      decodedSampleRate = audioData.sampleRate
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
    decoder.configure({ codec: 'opus', sampleRate: OPUS_CLOCK_RATE, numberOfChannels: 1 })
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
  const actualSampleRate = decodedSampleRate
  if (!actualSampleRate) throw new Error('Opus decoder produced no audio')
  const start = Math.min(preSkip, pcm.length)
  const end = Math.min(pcm.length, Math.max(start, Math.round((parsed.lastGranulePosition - preSkip) * actualSampleRate / OPUS_CLOCK_RATE)))
  return { pcm: pcm.slice(start, end), sampleRate: actualSampleRate }
}

export function measureOggCodecMetrics(reference: Float32Array, decoded: Float32Array, referenceRate: number, decodedRate: number): OggCodecMetrics {
  const referenceRms = rms(reference)
  const decodedRms = rms(decoded)
  const lag = estimateLag(reference, decoded, referenceRate, decodedRate)
  const compareLength = Math.min(reference.length, decoded.length - Math.max(0, lag))
  let error = 0
  for (let i = 0; i < compareLength; i++) {
    const decodedIndex = Math.max(0, lag) + Math.round(i * decodedRate / referenceRate)
    const difference = reference[i]! - (decoded[decodedIndex] || 0)
    error += difference * difference
  }
  return {
    referenceDurationMs: (reference.length / referenceRate) * 1000,
    decodedDurationMs: (decoded.length / decodedRate) * 1000,
    durationDifferenceMs: (decoded.length / decodedRate - reference.length / referenceRate) * 1000,
    referenceRms,
    decodedRms,
    rmsError: Math.sqrt(error / (compareLength || 1)),
    estimatedDelayMs: lag / referenceRate * 1000,
    alignedRmsError: Math.sqrt(error / (compareLength || 1)),
  }
}

function estimateLag(reference: Float32Array, decoded: Float32Array, referenceRate: number, decodedRate: number): number {
  const maxLag = Math.min(Math.round(referenceRate * 0.2), 9600)
  const step = 16
  let bestLag = 0
  let bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag += step) {
    let score = 0
    const count = Math.min(reference.length, Math.max(0, decoded.length - lag))
    for (let i = 0; i < count; i += step) {
      const decodedIndex = Math.max(0, lag) + Math.round(i * decodedRate / referenceRate)
      score += reference[i]! * (decoded[decodedIndex] || 0)
    }
    if (score > bestScore) { bestScore = score; bestLag = lag }
  }
  return bestLag
}

export interface ParsedOggOpus {
  sampleRate: number
  preSkip: number
  lastGranulePosition: number
  packets: Uint8Array[]
}

/** Structural parser used by the decoder and deterministic container tests. */
export function parseOggOpus(bytes: Uint8Array): ParsedOggOpus {
  const packets: Uint8Array[] = []
  let offset = 0
  let current: number[] = []
  let serial: number | undefined
  let expectedSequence = 0
  let firstHeaderType = 0
  let lastHeaderType = 0
  let lastGranulePosition = 0
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || readAscii(bytes, offset, 4) !== 'OggS') throw new Error('Invalid Ogg page')
    const segmentCount = bytes[offset + 26]!
    const tableEnd = offset + 27 + segmentCount
    if (tableEnd > bytes.length) throw new Error('Truncated Ogg segment table')
    const bodyLength = bytes.subarray(offset + 27, tableEnd).reduce((sum, length) => sum + length, 0)
    const bodyEnd = tableEnd + bodyLength
    if (bodyEnd > bytes.length) throw new Error('Truncated Ogg page body')
    const page = bytes.slice(offset, bodyEnd)
    const headerType = page[5]!
    const pageView = new DataView(page.buffer, page.byteOffset, page.byteLength)
    const pageSerial = pageView.getUint32(14, true)
    const sequence = pageView.getUint32(18, true)
    if (serial === undefined) serial = pageSerial
    if (pageSerial !== serial) throw new Error('Ogg serial number mismatch')
    if (sequence !== expectedSequence) throw new Error('Ogg page sequence mismatch')
    if (offset === 0) firstHeaderType = headerType
    lastHeaderType = headerType
    lastGranulePosition = readUint64(page, 6)
    expectedSequence++
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
  if ((firstHeaderType & 0x02) === 0) throw new Error('Ogg stream is missing BOS')
  if ((lastHeaderType & 0x04) === 0) throw new Error('Ogg stream is missing EOS')
  if (current.length) throw new Error('Ogg stream ends with a continued packet')
  const head = packets[0]
  const tags = packets[1]
  if (!head || head.length < 19 || readAscii(head, 0, 8) !== 'OpusHead') throw new Error('Ogg stream does not contain OpusHead')
  if (!tags || readAscii(tags, 0, 8) !== 'OpusTags') throw new Error('Ogg stream does not contain OpusTags')
  const sampleRate = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(12, true)
  return { sampleRate, preSkip: new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true), lastGranulePosition, packets }
}

const OPUS_CLOCK_RATE = 48000
const OPUS_FRAME_SAMPLES = 960

function muxOggOpus(packets: EncodedOpusPacket[], head: Uint8Array): Uint8Array {
  const serial = 0x534f4e49
  const pages: Uint8Array[] = []
  pages.push(createOggPage(head, serial, 0, 0x02, 0))
  pages.push(createOggPage(opusTags(), serial, 0, 0, 1))
  let granule = 0
  packets.forEach((packet, index) => {
    granule += packet.sampleCount
    pages.push(createOggPage(packet.data, serial, granule, index === packets.length - 1 ? 0x04 : 0, index + 2))
  })
  const result = new Uint8Array(pages.reduce((sum, page) => sum + page.length, 0))
  let offset = 0
  for (const page of pages) {
    result.set(page, offset)
    offset += page.length
  }
  return result
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

function readUint64(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / (samples.length || 1))
}
