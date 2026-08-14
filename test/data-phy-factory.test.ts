import { describe, expect, it } from 'vitest'
import {
  AcousticFrameType,
  ModemProfileKey,
  createDataRxPhy,
  createDataTxPhy,
  dataPhyKind,
  decodeChannelReport,
  decodeProfileProbe,
  decodeProfileProbeEnd,
  decodeProfileReject,
  encodeChannelReport,
  encodeProfileProbe,
  encodeProfileProbeEnd,
  encodeProfileReject,
  getFastDataConfig,
} from '../app/acoustic'

describe('canonical data PHY factory', () => {
  it('routes FAST TX and RX to guarded multitone', () => {
    const config = getFastDataConfig()
    expect(dataPhyKind(createDataTxPhy(ModemProfileKey.FAST_DATA_EXPERIMENTAL, 48000, config))).toBe('GUARDED_MULTITONE')
    expect(dataPhyKind(createDataRxPhy(ModemProfileKey.FAST_DATA_EXPERIMENTAL, 44100, config))).toBe('GUARDED_MULTITONE')
  })
})

describe('strict FAST profile payload validation', () => {
  const base = { protocolVersion: 1, sessionId: 7, verificationNonce: 9, profile: ModemProfileKey.FAST_DATA_EXPERIMENTAL }

  it('accepts FAST and rejects unknown profiles for every profile verification payload', () => {
    expect(decodeProfileProbe(encodeProfileProbe({ ...base, probeSequence: 1, totalProbes: 1 }))).not.toBeNull()
    expect(decodeProfileProbeEnd(encodeProfileProbeEnd({ ...base, attemptedProbes: 1 }))).not.toBeNull()
    expect(decodeProfileReject(encodeProfileReject({ ...base, reason: 'INVALID_CONFIG' }))).not.toBeNull()
    expect(decodeChannelReport(encodeChannelReport({ ...base, attemptedProbes: 1, framesDetected: 1, crcValid: 1, crcInvalid: 0, per: 0, classification: 'READY', sampleRate: 48000, configFingerprint: 'fast-test-fingerprint' }))).not.toBeNull()
    const unknown = new TextEncoder().encode(JSON.stringify({ ...base, profile: 'future_profile', probeSequence: 1, totalProbes: 1 }))
    expect(decodeProfileProbe(unknown)).toBeNull()
  })
})
