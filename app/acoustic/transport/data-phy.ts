import { BFSKAcousticModem } from '../modulation/bfsk-modem'
import { getProfileConfig, ModemProfileKey, type ModemConfig } from '../modulation/modem'
import { getFastDataConfig, ParallelMultitoneModem, ParallelMultitoneStreamDecoder, type ParallelMultitoneConfig } from '../modulation/parallel-multitone-modem'
import { PilotMultitoneModem, PilotMultitoneStreamDecoder, type PilotMultitoneConfig } from '../modulation/pilot-multitone-modem'
import { BFSKStreamDecoder } from './stream-decoder'
import type { AcousticFrame } from '../protocol/frame'
import type { AudioFrame } from '../modulation/modem'

export type DataPhyConfig = ModemConfig | ParallelMultitoneConfig | PilotMultitoneConfig
export type DataTxPhy = BFSKAcousticModem | ParallelMultitoneModem | PilotMultitoneModem
export type DataRxPhy = BFSKStreamDecoder | ParallelMultitoneStreamDecoder | PilotMultitoneStreamDecoder

export function createDataTxPhy(profile: ModemProfileKey, sampleRate: number, verifiedConfig?: DataPhyConfig): DataTxPhy {
  const config = verifiedConfig ? { ...verifiedConfig, sampleRate } : profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
    ? getFastDataConfig(sampleRate)
    : getProfileConfig(profile === ModemProfileKey.AUTO ? ModemProfileKey.BALANCED : profile, sampleRate)
  if (profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL && (config as any).modulationId === 'PILOT_MULTITONE_V2') return new PilotMultitoneModem(config as PilotMultitoneConfig)
  return profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
    ? new ParallelMultitoneModem(config as ParallelMultitoneConfig)
    : new BFSKAcousticModem(config as ModemConfig)
}

export function createDataRxPhy(profile: ModemProfileKey, localSampleRate: number, negotiatedConfig?: DataPhyConfig): DataRxPhy {
  const config = negotiatedConfig ? { ...negotiatedConfig, sampleRate: localSampleRate } : profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
    ? getFastDataConfig(localSampleRate)
    : getProfileConfig(profile === ModemProfileKey.AUTO ? ModemProfileKey.BALANCED : profile, localSampleRate)
  if (profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL && (config as any).modulationId === 'PILOT_MULTITONE_V2') return new PilotMultitoneStreamDecoder(new PilotMultitoneModem(config as PilotMultitoneConfig))
  return profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
    ? new ParallelMultitoneStreamDecoder(config as ParallelMultitoneConfig)
    : new BFSKStreamDecoder(new BFSKAcousticModem(config as ModemConfig))
}

export function dataPhyKind(phy: DataTxPhy | DataRxPhy): 'MFSK' | 'GUARDED_MULTITONE' | 'PILOT_MULTITONE_V2' {
  if (phy instanceof PilotMultitoneModem || phy instanceof PilotMultitoneStreamDecoder) return 'PILOT_MULTITONE_V2'
  return phy instanceof ParallelMultitoneModem || phy instanceof ParallelMultitoneStreamDecoder ? 'GUARDED_MULTITONE' : 'MFSK'
}

export function encodeWithDataTxPhy(phy: DataTxPhy, packet: Uint8Array): AudioFrame {
  return phy.encode(packet)
}

export function decodeWithDataRxPhy(phy: DataRxPhy, samples: Float32Array): AcousticFrame[] {
  return phy.pushSamples(samples)
}
