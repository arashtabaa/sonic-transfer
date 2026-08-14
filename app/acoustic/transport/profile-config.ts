import { getProfileConfig, ModemProfileKey } from '../modulation/modem'
import { getPilotMultitoneConfig } from '../modulation/pilot-multitone-modem'
import type { DataPhyConfig } from './data-phy'

export function buildVerifiedDataProfileConfig(profile: ModemProfileKey, sampleRate: number, gain: number, explicitConfig?: DataPhyConfig): DataPhyConfig {
  const baseConfig = explicitConfig
    ? { ...explicitConfig, sampleRate }
    : profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL
      ? getPilotMultitoneConfig(sampleRate)
      : getProfileConfig(profile, sampleRate)
  return { ...baseConfig, sampleRate, gain } as DataPhyConfig
}

export function fingerprintVerifiedDataProfile(profile: ModemProfileKey, sampleRate: number, config: DataPhyConfig): string {
  const modulation = (config as any).modulationId || (profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL ? 'GUARDED_MULTITONE_V1' : 'MFSK-FSK-v1')
  return JSON.stringify({ protocolVersion: 1, modulation, profile, startFreq: config.startFreq, endFreq: config.endFreq, carrierCount: config.carrierCount, symbolDurationMs: config.symbolDurationMs, guardMs: config.guardMs, gain: config.gain, txSampleRate: sampleRate })
}
