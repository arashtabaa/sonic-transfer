import { appendFileHeaderMetaToBuffer, blockToBinary, createEncoder } from 'luby-transform'
import { AcousticPacketizer } from '../framing/packetizer'
import { AcousticFrameType, encodeFrame } from '../protocol/frame'
import { getFastDataConfig, ParallelMultitoneModem } from '../modulation/parallel-multitone-modem'

export interface FastRenderedWaveform { pcm: Float32Array; sampleRate: number; durationSec: number; totalFrames: number; sourceBlocks: number; transmittedBlocks: number }

export function renderFastPayloadToPcm(data: Uint8Array, filename = 'file.bin', contentType = 'application/octet-stream', sampleRate = 48000, extraBlocks?: number): FastRenderedWaveform {
  const modem = new ParallelMultitoneModem(getFastDataConfig(sampleRate))
  const sessionId = 0x534f4e49
  const packetizer = new AcousticPacketizer(sessionId)
  const canonical = appendFileHeaderMetaToBuffer(data, { filename, contentType })
  const encoder = createEncoder(canonical, 100, true)
  const fountain = encoder.fountain()
  const redundancy = extraBlocks ?? Math.max(4, Math.ceil(encoder.k * 0.2))
  const frames: Float32Array[] = []
  const header = packetizer.createSessionHeaderFrame({ protocolVersion: 1, sessionId, filename, contentType, originalSize: data.length, encodedSize: encoder.compressed.length, fileChecksum: encoder.checksum, totalFountainK: encoder.k, modemProfile: 'fast_data_experimental' })
  frames.push(modem.encode(header).samples)
  for (let sequence = 1; sequence <= encoder.k + redundancy; sequence++) {
    const block = fountain.next().value
    frames.push(modem.encode(encodeFrame(sessionId, AcousticFrameType.DATA, sequence, blockToBinary(block))).samples)
  }
  const totalSamples = frames.reduce((sum, frame) => sum + frame.length, 0)
  const pcm = new Float32Array(totalSamples); let offset = 0
  for (const frame of frames) { pcm.set(frame, offset); offset += frame.length }
  return { pcm, sampleRate, durationSec: totalSamples / sampleRate, totalFrames: frames.length, sourceBlocks: encoder.k, transmittedBlocks: encoder.k + redundancy }
}
