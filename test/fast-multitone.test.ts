import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createDecoder, readFileHeaderMetaFromBuffer } from '../packages/luby-transform/src'
import { AcousticFrameType, AcousticPacketizer, createDataRxPhy, decodeWavPcm, encodeFrame, encodeWavBlob, getFastDataConfig, getPilotMultitoneConfig, ModemProfileKey, ParallelMultitoneModem, ParallelMultitoneStreamDecoder, renderFastPayloadToPcm } from '../app/acoustic'
import { generateTestPayload } from '../app/constants/testPayload'

function concat(...parts: Float32Array[]): Float32Array {
  const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

describe('FAST_DATA_EXPERIMENTAL guarded parallel multitone', () => {
  it('recovers exact frames across arbitrary chunks and silence', () => {
    const modem = new ParallelMultitoneModem(getFastDataConfig())
    const first = encodeFrame(77, AcousticFrameType.DATA, 1, Uint8Array.from({ length: 48 }, (_, i) => i))
    const second = encodeFrame(77, AcousticFrameType.DATA, 2, Uint8Array.from({ length: 48 }, (_, i) => 255 - i))
    const silence = new Float32Array(2400)
    const pcm = concat(modem.encode(first).samples, silence, modem.encode(second).samples)
    const decoder = new ParallelMultitoneStreamDecoder(getFastDataConfig())
    const frames = []
    for (let offset = 0; offset < pcm.length; offset += 37) frames.push(...decoder.pushSamples(pcm.subarray(offset, Math.min(offset + 37, pcm.length))))
    expect(frames.map(frame => frame.sequence)).toEqual([1, 2])
    expect(frames[0]!.payload).toEqual(Uint8Array.from({ length: 48 }, (_, i) => i))
  })

  it('reacquires after a corrupt frame and exposes a measured PCM rate', () => {
    const config = getFastDataConfig()
    const modem = new ParallelMultitoneModem(config)
    const bad = encodeFrame(88, AcousticFrameType.DATA, 1, new Uint8Array([1, 2, 3]))
    bad[bad.length - 1]! ^= 1
    const good = encodeFrame(88, AcousticFrameType.DATA, 2, new Uint8Array([4, 5, 6]))
    const pcm = concat(modem.encode(bad).samples, new Float32Array(960), modem.encode(good).samples)
    const decoder = new ParallelMultitoneStreamDecoder(config)
    const frames = decoder.pushSamples(pcm)
    expect(frames.map(frame => frame.sequence)).toEqual([2])
    const rawRate = config.carrierCount * 1000 / (config.symbolDurationMs + config.guardMs)
    expect(rawRate).toBeCloseTo(2666.67, 0)
  })

  it('reconstructs the 8 KiB fixture through FAST_DATA PCM and WAV-equivalent PCM', async () => {
    const payload = generateTestPayload()
    const rendered = renderFastPayloadToPcm(payload, 'sonic-test-fixture.bin', 'application/octet-stream', 48000, 10)
    const wav = encodeWavBlob(rendered.pcm, rendered.sampleRate)
    const wavPcm = decodeWavPcm(await wav.arrayBuffer())
    const decoder = new ParallelMultitoneStreamDecoder(getFastDataConfig(wavPcm.sampleRate))
    const frames = decoder.pushSamples(wavPcm.pcm)
    const packetizer = new AcousticPacketizer()
    const fountain = createDecoder()
    let reconstructed: Uint8Array | null = null
    for (const frame of frames) {
      const parsed = packetizer.parseIncomingBuffer(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
      if (parsed.fountainBlock && fountain.addBlock(parsed.fountainBlock)) {
        const [bytes] = readFileHeaderMetaFromBuffer(fountain.getDecoded()!)
        reconstructed = bytes
        break
      }
    }
    expect(reconstructed).not.toBeNull()
    expect(createHash('sha256').update(reconstructed!).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
    expect(rendered.durationSec).toBeGreaterThan(0)
  }, 120000)

  it('reconstructs the 8 KiB fixture through explicit PILOT_MULTITONE_V2 artifact PCM', async () => {
    const payload = generateTestPayload()
    const config = getPilotMultitoneConfig(48000)
    const rendered = renderFastPayloadToPcm(payload, 'sonic-test-fixture.bin', 'application/octet-stream', 48000, 10, config)
    expect(rendered.modulationId).toBe('PILOT_MULTITONE_V2')
    const decoder = createDataRxPhy(ModemProfileKey.FAST_DATA_EXPERIMENTAL, rendered.sampleRate, config)
    const frames = decoder.pushSamples(rendered.pcm)
    const packetizer = new AcousticPacketizer()
    const fountain = createDecoder()
    let reconstructed: Uint8Array | null = null
    for (const frame of frames) {
      const parsed = packetizer.parseIncomingBuffer(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
      if (parsed.fountainBlock && fountain.addBlock(parsed.fountainBlock)) { const [bytes] = readFileHeaderMetaFromBuffer(fountain.getDecoded()!); reconstructed = bytes; break }
    }
    expect(reconstructed).not.toBeNull()
    expect(createHash('sha256').update(reconstructed!).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
  }, 120000)

  it('reconstructs the 8 KiB fixture through explicit PILOT_MULTITONE_V2 WAV', async () => {
    const payload = generateTestPayload()
    const config = getPilotMultitoneConfig(48000)
    const rendered = renderFastPayloadToPcm(payload, 'sonic-test-fixture.bin', 'application/octet-stream', 48000, 10, config)
    const wav = encodeWavBlob(rendered.pcm, rendered.sampleRate)
    const wavPcm = decodeWavPcm(await wav.arrayBuffer())
    const decoder = createDataRxPhy(ModemProfileKey.FAST_DATA_EXPERIMENTAL, wavPcm.sampleRate, config)
    const packetizer = new AcousticPacketizer()
    const fountain = createDecoder()
    let reconstructed: Uint8Array | null = null
    for (const frame of decoder.pushSamples(wavPcm.pcm)) {
      const parsed = packetizer.parseIncomingBuffer(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
      if (parsed.fountainBlock && fountain.addBlock(parsed.fountainBlock)) { const [bytes] = readFileHeaderMetaFromBuffer(fountain.getDecoded()!); reconstructed = bytes; break }
    }
    expect(reconstructed).not.toBeNull()
    expect(createHash('sha256').update(reconstructed!).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
  }, 120000)

  it('reconstructs the 8 KiB fixture through whole-stream V2 cross-rate resampling in both directions', async () => {
    const payload = generateTestPayload()
    for (const [txRate, rxRate] of [[48000, 44100], [44100, 48000]] as const) {
      const txConfig = getPilotMultitoneConfig(txRate)
      const rendered = renderFastPayloadToPcm(payload, 'sonic-test-fixture.bin', 'application/octet-stream', txRate, 10, txConfig)
      const resampled = new Float32Array(Math.round(rendered.pcm.length * rxRate / txRate))
      for (let i = 0; i < resampled.length; i++) { const source = i * txRate / rxRate; const left = Math.floor(source); const fraction = source - left; resampled[i] = (rendered.pcm[left] || 0) * (1 - fraction) + (rendered.pcm[Math.min(left + 1, rendered.pcm.length - 1)] || 0) * fraction }
      const decoder = createDataRxPhy(ModemProfileKey.FAST_DATA_EXPERIMENTAL, rxRate, getPilotMultitoneConfig(rxRate))
      const packetizer = new AcousticPacketizer()
      const fountain = createDecoder()
      let reconstructed: Uint8Array | null = null
      for (const frame of decoder.pushSamples(resampled)) {
        const parsed = packetizer.parseIncomingBuffer(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
        if (parsed.fountainBlock && fountain.addBlock(parsed.fountainBlock)) { const [bytes] = readFileHeaderMetaFromBuffer(fountain.getDecoded()!); reconstructed = bytes; break }
      }
      expect(reconstructed).not.toBeNull()
      expect(createHash('sha256').update(reconstructed!).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
    }
  }, 180000)
})
