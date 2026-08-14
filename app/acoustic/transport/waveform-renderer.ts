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
  ): RenderedWaveformResult {
    const config = getProfileConfig(profileKey, sampleRate)
    const modem = new BFSKAcousticModem(config)
    const sessionId = Math.floor(Math.random() * 1000000)
    const packetizer = new AcousticPacketizer(sessionId)

    const canonicalPayload = appendFileHeaderMetaToBuffer(data, { filename, contentType })
    const encoder = createEncoder(canonicalPayload, sliceSize, true)
    const fountain = encoder.fountain()

    const frames: AudioFrame[] = []
    let totalSamples = 0

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

    // Generate Fountain Data blocks (k + 80% redundancy for offline rendering)
    const extraBlocks = Math.max(30, Math.ceil(encoder.k * 0.8))

    for (let seq = 1; seq <= encoder.k + extraBlocks; seq++) {
      const block = fountain.next().value
      const blockBytes = blockToBinary(block)
      const dataFrameBuffer = encodeFrame(sessionId, AcousticFrameType.DATA, seq, blockBytes)

      const audioFrame = modem.encode(dataFrameBuffer)
      frames.push(audioFrame)
      totalSamples += audioFrame.samples.length
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
    }
  }
}
