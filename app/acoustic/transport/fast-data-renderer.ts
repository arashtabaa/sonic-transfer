import { appendFileHeaderMetaToBuffer, blockToBinary, createEncoder } from 'luby-transform'
import { AcousticPacketizer } from '../framing/packetizer'
import { AcousticFrameType, encodeFrame } from '../protocol/frame'
import { ModemProfileKey } from '../modulation/modem'
import { getFastDataConfig } from '../modulation/parallel-multitone-modem'
import { createDataTxPhy } from './data-phy'
import type { DataPhyConfig } from './data-phy'

export interface FastRenderedWaveform { pcm: Float32Array; sampleRate: number; durationSec: number; totalFrames: number; sourceBlocks: number; transmittedBlocks: number; profile: ModemProfileKey; modulationId: string; config: DataPhyConfig }

export function renderFastPayloadToPcm(data: Uint8Array, filename = 'file.bin', contentType = 'application/octet-stream', sampleRate = 48000, extraBlocks?: number, phyConfig?: DataPhyConfig): FastRenderedWaveform {
  const config = phyConfig || getFastDataConfig(sampleRate)
  const modem = createDataTxPhy(ModemProfileKey.FAST_DATA_EXPERIMENTAL, sampleRate, config)
  const sessionId = 0x534f4e49
  const packetizer = new AcousticPacketizer(sessionId)
  const canonical = appendFileHeaderMetaToBuffer(data, { filename, contentType })
  const encoder = createEncoder(canonical, 100, true)
  const fountain = encoder.fountain()
  const redundancy = extraBlocks ?? Math.max(4, Math.ceil(encoder.k * 0.2))
  const frames: Float32Array[] = []
  const header = packetizer.createSessionHeaderFrame({ protocolVersion: 1, sessionId, filename, contentType, originalSize: data.length, encodedSize: encoder.compressed.length, fileChecksum: encoder.checksum, totalFountainK: encoder.k, modemProfile: ModemProfileKey.FAST_DATA_EXPERIMENTAL })
  frames.push(modem.encode(header).samples)
  for (let sequence = 1; sequence <= encoder.k + redundancy; sequence++) {
    const block = fountain.next().value
    frames.push(modem.encode(encodeFrame(sessionId, AcousticFrameType.DATA, sequence, blockToBinary(block))).samples)
  }
  const totalSamples = frames.reduce((sum, frame) => sum + frame.length, 0)
  const pcm = new Float32Array(totalSamples); let offset = 0
  for (const frame of frames) { pcm.set(frame, offset); offset += frame.length }
  return { pcm, sampleRate, durationSec: totalSamples / sampleRate, totalFrames: frames.length, sourceBlocks: encoder.k, transmittedBlocks: encoder.k + redundancy, profile: ModemProfileKey.FAST_DATA_EXPERIMENTAL, modulationId: (config as any).modulationId || 'GUARDED_MULTITONE_V1', config }
}
