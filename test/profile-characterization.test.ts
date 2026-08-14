import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDecoder, readFileHeaderMetaFromBuffer } from '../packages/luby-transform/src'
import { generateTestPayload } from '../app/constants/testPayload'
import { AcousticPacketizer, BFSKAcousticModem, BFSKStreamDecoder, decodeFrame, encodeFrame, getProfileConfig, ModemProfileKey, SonicWaveformRenderer } from '../app/acoustic'

async function roundTrip(profile: ModemProfileKey) {
  const payload = generateTestPayload()
  const rendered = SonicWaveformRenderer.renderPayloadToPcm(payload, 'sonic-test-fixture.bin', 'application/octet-stream', profile, 48000, 500, 30)
  const stream = new BFSKStreamDecoder(new BFSKAcousticModem(getProfileConfig(profile, 48000)))
  const frames = []
  for (let offset = 0; offset < rendered.pcm.length; offset += 2048) frames.push(...stream.pushSamples(rendered.pcm.subarray(offset, Math.min(offset + 2048, rendered.pcm.length))))
  const packetizer = new AcousticPacketizer()
  const decoder = createDecoder()
  for (const frame of frames) {
    const parsed = packetizer.parseIncomingBuffer(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
    if (parsed.fountainBlock && decoder.addBlock(parsed.fountainBlock)) {
      const [bytes] = readFileHeaderMetaFromBuffer(decoder.getDecoded()!)
      return { rendered, stats: stream.getStats(), sha: createHash('sha256').update(bytes).digest('hex') }
    }
  }
  return { rendered, stats: stream.getStats(), sha: null }
}

describe('existing production DATA profile characterization', () => {
  it('clean synthetic 8 KiB roundtrip for ROBUST, BALANCED, and TURBO', async () => {
    for (const profile of [ModemProfileKey.ROBUST, ModemProfileKey.BALANCED, ModemProfileKey.TURBO]) {
      const result = await roundTrip(profile)
      expect(result.stats.crcValid).toBeGreaterThan(0)
      expect(result.sha).toBe(createHash('sha256').update(generateTestPayload()).digest('hex'))
    }
  }, 180000)
})
