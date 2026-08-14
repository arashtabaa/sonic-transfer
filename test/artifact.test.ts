import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AcousticPacketizer,
  BFSKAcousticModem,
  decodeFrame,
  encodeFrame,
  getProfileConfig,
  ModemProfileKey,
  SonicWaveformRenderer,
  BFSKStreamDecoder,
  decodeWavPcm,
  encodeWavBlob,
} from '../app/acoustic'
import { createDecoder, readFileHeaderMetaFromBuffer } from '../packages/luby-transform/src'
import { EXPECTED_TEST_SHA256, generateTestPayload } from '../app/constants/testPayload'

function computeSha256Hex(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}

describe('Sonic Audio Artifact Lab & Non-Regression Suite', () => {
  it('should render deterministic 8 KiB test payload through WAV and reconstruct exact bytes and SHA-256', async () => {
    const testData = generateTestPayload()
    const renderResult = SonicWaveformRenderer.renderPayloadToPcm(
      testData,
      'sonic-test-fixture.bin',
      'application/octet-stream',
      ModemProfileKey.ROBUST,
      48000,
      500,
      30,
    )

    expect(renderResult.pcm).toBeInstanceOf(Float32Array)
    expect(renderResult.pcm.length).toBeGreaterThan(0)
    expect(renderResult.sampleRate).toBe(48000)
    const wav = encodeWavBlob(renderResult.pcm, renderResult.sampleRate)
    const decodedWav = decodeWavPcm(await wav.arrayBuffer())
    expect(decodedWav.sampleRate).toBe(48000)

    // Feed rendered PCM samples into central receiver DSP decoder pipeline
    const config = getProfileConfig(ModemProfileKey.ROBUST, 48000)
    const modem = new BFSKAcousticModem(config)
    const streamDecoder = new BFSKStreamDecoder(modem)
    let packetizer: AcousticPacketizer | null = null
    const decoder = createDecoder()

    let reconstructedBytes: Uint8Array | null = null
    const packets = []
    for (let offset = 0; offset < decodedWav.pcm.length; offset += 2048) {
      packets.push(...streamDecoder.pushSamples(decodedWav.pcm.subarray(offset, Math.min(offset + 2048, decodedWav.pcm.length))))
    }
    for (const frame of packets) {
      const pkt = encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload)
      if (!packetizer) {
        const rawFrame = decodeFrame(pkt)
        if (rawFrame) packetizer = new AcousticPacketizer(rawFrame.sessionId)
      }
      if (!packetizer) continue

      const parsed = packetizer.parseIncomingBuffer(pkt)
      if (parsed.fountainBlock) {
        const isComplete = decoder.addBlock(parsed.fountainBlock)
        if (isComplete && !reconstructedBytes) {
          const decodedMerged = decoder.getDecoded()!
          const [bytes] = readFileHeaderMetaFromBuffer(decodedMerged)
          reconstructedBytes = bytes
          break
        }
      }
    }

    expect(reconstructedBytes).not.toBeNull()
    expect(reconstructedBytes?.length).toBe(testData.length)

    const actualHash = computeSha256Hex(reconstructedBytes!)
    expect(actualHash).toBe(EXPECTED_TEST_SHA256)
  })

  it('Non-regression: live AudioTransmitter & AudioReceiver exports remain valid', async () => {
    const { AudioTransmitter, AudioReceiver } = await import('../app/acoustic')
    expect(AudioTransmitter).toBeDefined()
    expect(AudioReceiver).toBeDefined()
  })
})
