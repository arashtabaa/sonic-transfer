import { describe, expect, it } from 'vitest'
import {
  AcousticFrameType,
  classifyProfileVerification,
  decodeChannelReport,
  decodeFrame,
  decodeProfileProbe,
  encodeChannelReport,
  encodeFrame,
  encodeProfileProbe,
  getProfileConfig,
  ModemProfileKey,
  validateProfileProposal,
} from '../app/acoustic'
import { decodeProfileAccept, decodeProfileProposal, encodeProfileAccept, encodeProfileProposal } from '../app/acoustic/transport/link-test'

describe('production DATA profile verification protocol', () => {
  it('round-trips a profile proposal, exact config, and probe identity', () => {
    const config = getProfileConfig(ModemProfileKey.TURBO, 48000)
    const proposal = { protocolVersion: 1, sessionId: 123, verificationNonce: 456, profile: ModemProfileKey.TURBO, sampleRate: 48000, config, probeCount: 30, configFingerprint: 'turbo-fingerprint-1' }
    expect(decodeProfileProposal(encodeProfileProposal(proposal))).toEqual(proposal)
    expect(decodeProfileAccept(encodeProfileAccept(proposal))).toEqual(proposal)
    expect(validateProfileProposal(proposal, 48000)).toBe(true)
    expect(validateProfileProposal(proposal, 44100)).toBe(true)
    const near = { ...proposal, profile: ModemProfileKey.NEAR_ULTRASONIC, config: getProfileConfig(ModemProfileKey.NEAR_ULTRASONIC, 48000) }
    expect(validateProfileProposal(near, 32000)).toBe(false)
    expect(validateProfileProposal({ ...proposal, config: { ...config, sampleRate: 44100 } }, 48000)).toBe(false)

    const probe = { protocolVersion: 1, sessionId: 123, verificationNonce: 456, profile: ModemProfileKey.TURBO, probeSequence: 7, totalProbes: 30 }
    const frame = decodeFrame(encodeFrame(123, AcousticFrameType.LINK_PROBE, 7, encodeProfileProbe(probe)))!
    expect(decodeProfileProbe(frame.payload)).toEqual(probe)
  })

  it('classifies from CRC-valid ratio and preserves report metrics', () => {
    expect(classifyProfileVerification(30, 30)).toBe('READY')
    expect(classifyProfileVerification(18, 30)).toBe('MARGINAL')
    expect(classifyProfileVerification(5, 30)).toBe('FAILED')
    const report = { protocolVersion: 1, sessionId: 1, verificationNonce: 2, profile: ModemProfileKey.BALANCED, attemptedProbes: 30, framesDetected: 28, crcValid: 27, crcInvalid: 3, per: 0.1, classification: 'READY' as const, sampleRate: 48000, configFingerprint: 'balanced-fingerprint-1' }
    expect(decodeChannelReport(encodeChannelReport(report))).toEqual(report)
  })
})
