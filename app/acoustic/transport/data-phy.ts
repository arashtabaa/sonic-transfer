import { BFSKAcousticModem } from '../modulation/bfsk-modem'
import { getProfileConfig, ModemProfileKey, type ModemConfig } from '../modulation/modem'
import { getFastDataConfig, ParallelMultitoneModem, ParallelMultitoneStreamDecoder, type ParallelMultitoneConfig } from '../modulation/parallel-multitone-modem'
import { BFSKStreamDecoder } from './stream-decoder'
import type { AcousticFrame } from '../protocol/frame'
import type { AudioFrame } from '../modulation/modem'

export type DataPhyConfig = ModemConfig | ParallelMultitoneConfig
export type DataTxPhy = BFSKAcousticModem | ParallelMultitoneModem
export type DataRxPhy = BFSKStreamDecoder | ParallelMultitoneStreamDecoder

export function createDataTxPhy(profile: ModemProfileKey, sampleRate: number, verifiedConfig?: DataPhyConfig): DataTxPhy {
  const config = verifiedConfig ? { ...verifiedConfig, sampleRate } : profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
    ? getFastDataConfig(sampleRate)
    : getProfileConfig(profile === ModemProfileKey.AUTO ? ModemProfileKey.BALANCED : profile, sampleRate)
  return profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
    ? new ParallelMultitoneModem(config as ParallelMultitoneConfig)
    : new BFSKAcousticModem(config as ModemConfig)
}

export function createDataRxPhy(profile: ModemProfileKey, localSampleRate: number, negotiatedConfig?: DataPhyConfig): DataRxPhy {
  const config = negotiatedConfig ? { ...negotiatedConfig, sampleRate: localSampleRate } : profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
    ? getFastDataConfig(localSampleRate)
    : getProfileConfig(profile === ModemProfileKey.AUTO ? ModemProfileKey.BALANCED : profile, localSampleRate)
  return profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
    ? new ParallelMultitoneStreamDecoder(config as ParallelMultitoneConfig)
    : new BFSKStreamDecoder(new BFSKAcousticModem(config as ModemConfig))
}

export function dataPhyKind(phy: DataTxPhy | DataRxPhy): 'MFSK' | 'GUARDED_MULTITONE' {
  return phy instanceof ParallelMultitoneModem || phy instanceof ParallelMultitoneStreamDecoder ? 'GUARDED_MULTITONE' : 'MFSK'
}

export function encodeWithDataTxPhy(phy: DataTxPhy, packet: Uint8Array): AudioFrame {
  return phy.encode(packet)
}

export function decodeWithDataRxPhy(phy: DataRxPhy, samples: Float32Array): AcousticFrame[] {
  return phy.pushSamples(samples)
}
