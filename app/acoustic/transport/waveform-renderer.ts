import { BFSKAcousticModem } from '../modulation/bfsk-modem'
import { getProfileConfig, ModemProfileKey, type AudioFrame } from '../modulation/modem'
import { AcousticPacketizer } from '../framing/packetizer'
import { encodeFrame, encodeSessionHeader, AcousticFrameType } from '../protocol/frame'
import { createEncoder, appendFileHeaderMetaToBuffer, blockToBinary } from 'luby-transform'

export interface RenderedWaveformResult {
  pcm: Float32Array
  sampleRate: number
  durationSec: number
  totalFrames: number
  totalSamples: number
  modemProfile: ModemProfileKey
  encodedBytes: number
  canonicalBytes: number
  protocolBytes: number
  sourceBlocks: number
  fountainBlocks: number
}

export class SonicWaveformRenderer {
  /**
   * Renders raw binary payload into a continuous Float32Array PCM waveform
   * using the EXACT SAME Fountain encoder, frame packetizer, and acoustic modem as live transmission.
   */
  static renderPayloadToPcm(
    data: Uint8Array,
    filename = 'file.bin',
    contentType = 'application/octet-stream',
    profileKey = ModemProfileKey.ROBUST,
    sampleRate = 48000,
    sliceSize = 100,
    extraBlocks = 30,
  ): RenderedWaveformResult {
    const config = getProfileConfig(profileKey, sampleRate)
    const modem = new BFSKAcousticModem(config)
    const sessionNonce = new Uint32Array(1)
    if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness unavailable')
    globalThis.crypto.getRandomValues(sessionNonce)
    const sessionId = sessionNonce[0]!
    const packetizer = new AcousticPacketizer(sessionId)

    const canonicalPayload = appendFileHeaderMetaToBuffer(data, { filename, contentType })
    const encoder = createEncoder(canonicalPayload, sliceSize, true)
    const fountain = encoder.fountain()

    const frames: AudioFrame[] = []
    let totalSamples = 0
    let protocolBytes = 0

    // Generate Session Header + Fountain Data frames
    const headerBytes = packetizer.createSessionHeaderFrame({
      protocolVersion: 1,
      sessionId,
      filename,
      contentType,
      originalSize: data.length,
      encodedSize: encoder.compressed.length,
      fileChecksum: encoder.checksum,
      totalFountainK: encoder.k,
      modemProfile: profileKey,
    })

    const headerAudioFrame = modem.encode(headerBytes)
    frames.push(headerAudioFrame)
    totalSamples += headerAudioFrame.samples.length
    protocolBytes += headerBytes.length

    // Redundancy is an explicit renderer parameter, not a test-only multiplier.
    for (let seq = 1; seq <= encoder.k + extraBlocks; seq++) {
      const block = fountain.next().value
      const blockBytes = blockToBinary(block)
      const dataFrameBuffer = encodeFrame(sessionId, AcousticFrameType.DATA, seq, blockBytes)

      const audioFrame = modem.encode(dataFrameBuffer)
      frames.push(audioFrame)
      totalSamples += audioFrame.samples.length
      protocolBytes += dataFrameBuffer.length
    }

    // Concatenate all AudioFrames into continuous Float32Array PCM
    const pcm = new Float32Array(totalSamples)
    let offset = 0
    for (const f of frames) {
      pcm.set(f.samples, offset)
      offset += f.samples.length
    }

    return {
      pcm,
      sampleRate,
      durationSec: Number((totalSamples / sampleRate).toFixed(2)),
      totalFrames: frames.length,
      totalSamples,
      modemProfile: profileKey,
      encodedBytes: encoder.compressed.length,
      canonicalBytes: canonicalPayload.length,
      protocolBytes,
      sourceBlocks: encoder.k,
      fountainBlocks: encoder.k + extraBlocks,
    }
  }
}
