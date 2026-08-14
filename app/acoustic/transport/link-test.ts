import { AcousticFrameType, encodeFrame, type ChannelReportPayload, type ProfileProbePayload, classifyProfileVerification, encodeChannelReport, encodeProfileProbe } from '../protocol/frame'
import { getProfileConfig, ModemProfileKey, validateConfig, type ModemConfig } from '../modulation/modem'
import type { ParallelMultitoneConfig } from '../modulation/parallel-multitone-modem'

export interface LinkTestOptions {
  profileKey: ModemProfileKey
  sampleRate: number
  gain: number
}

export interface LinkTestResult {
  success: boolean
  stage: 'output_ready' | 'carrier_detected' | 'preamble_detected' | 'crc_verified' | 'failed'
  snrDb: number | null
  packetSuccessRatio: number
  quality: 'Excellent' | 'Good' | 'Marginal' | 'Poor' | 'Failed'
  nonce: number
  recommendedProfile: ModemProfileKey
  message: string
}

export interface ProfileProposalPayload {
  protocolVersion: number
  sessionId: number
  verificationNonce: number
  profile: ModemProfileKey
  sampleRate: number
  config: ModemConfig | ParallelMultitoneConfig
  probeCount: number
  configFingerprint: string
}

export function encodeProfileProposal(payload: ProfileProposalPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

export function decodeProfileProposal(bytes: Uint8Array): ProfileProposalPayload | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as ProfileProposalPayload
    const c = payload.config
    if (payload.protocolVersion !== 1 || !Object.values(ModemProfileKey).includes(payload.profile) || !Number.isInteger(payload.sessionId) || payload.sessionId < 0 || !Number.isInteger(payload.verificationNonce) || payload.verificationNonce < 0 || !Number.isInteger(payload.probeCount) || payload.probeCount < 1 || payload.probeCount > 128 || !Number.isFinite(payload.sampleRate) || payload.sampleRate < 8000 || payload.sampleRate > 192000 || typeof payload.configFingerprint !== 'string' || payload.configFingerprint.length < 8 || payload.configFingerprint.length > 512 || !c || c.profileKey !== payload.profile || c.sampleRate !== payload.sampleRate || ![c.startFreq, c.endFreq, c.carrierCount, c.symbolDurationMs, c.guardMs, c.gain].every(Number.isFinite) || c.carrierCount < 2 || c.carrierCount > 64 || c.symbolDurationMs <= 0 || c.guardMs < 0 || c.gain <= 0 || c.gain > 1) return null
    return payload
  } catch { return null }
}

export function encodeProfileAccept(payload: ProfileProposalPayload): Uint8Array {
  return encodeProfileProposal(payload)
}

export function decodeProfileAccept(bytes: Uint8Array): ProfileProposalPayload | null {
  return decodeProfileProposal(bytes)
}

export function createProfileProbeFrame(payload: ProfileProbePayload, sessionId: number, sequence: number): Uint8Array {
  return encodeFrame(sessionId, AcousticFrameType.LINK_PROBE, sequence, encodeProfileProbe(payload))
}

export function createChannelReportFrame(payload: ChannelReportPayload, sessionId: number, sequence = 1): Uint8Array {
  return encodeFrame(sessionId, AcousticFrameType.CHANNEL_REPORT, sequence, encodeChannelReport(payload))
}

export function classifyProfileReport(crcValid: number, attemptedProbes: number): ChannelReportPayload['classification'] {
  return classifyProfileVerification(crcValid, attemptedProbes)
}

export function validateProfileProposal(payload: ProfileProposalPayload, actualSampleRate: number): boolean {
  const localConfig = { ...payload.config, sampleRate: actualSampleRate }
  return payload.config.sampleRate === payload.sampleRate && validateConfig(localConfig).valid
}

export { decodeFrequencyProbe, decodeFrequencyReport, encodeFrequencyProbe, encodeFrequencyReport } from '../protocol/frame'
export type { FrequencyProbePayload, FrequencyReportPayload } from '../protocol/frame'

export class AcousticLinkTester {
  /**
   * Generates a Link Probe frame containing a random 32-bit nonce
   */
  static createProbeFrame(sessionId: number, nonce: number, sequence = 1): Uint8Array {
    const buffer = new Uint8Array(12)
    const view = new DataView(buffer.buffer)
    view.setUint32(0, sessionId, false)
    view.setUint32(4, nonce, false)
    view.setUint32(8, Date.now() >>> 0, false)
    return encodeFrame(sessionId, AcousticFrameType.LINK_PROBE, sequence, buffer)
  }

  /**
   * Generates a Link ACK frame in response to a valid probe
   */
  static createAckFrame(sessionId: number, nonce: number, snrDb: number | null, sequence = 1): Uint8Array {
    const buffer = new Uint8Array(16)
    const view = new DataView(buffer.buffer)
    view.setUint32(0, sessionId, false)
    view.setUint32(4, nonce, false)
    view.setFloat32(8, snrDb || 0, false)
    view.setUint32(12, Date.now() >>> 0, false)
    return encodeFrame(sessionId, AcousticFrameType.LINK_ACK, sequence, buffer)
  }

  /**
   * Generates a Channel Report control frame
   */
  static createChannelReportFrame(sessionId: number, validRatio: number, snrDb: number | null, sequence = 1): Uint8Array {
    const buffer = new Uint8Array(12)
    const view = new DataView(buffer.buffer)
    view.setUint32(0, sessionId, false)
    view.setFloat32(4, validRatio, false)
    view.setFloat32(8, snrDb || 0, false)
    return encodeFrame(sessionId, AcousticFrameType.CHANNEL_REPORT, sequence, buffer)
  }

  /**
   * Validates a received probe payload
   */
  static parseProbePayload(payload: Uint8Array): { sessionId: number; nonce: number } | null {
    if (payload.length < 12) return null
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const sessionId = view.getUint32(0, false)
    const nonce = view.getUint32(4, false)
    return { sessionId, nonce }
  }

  /**
   * Validates a received ACK payload
   */
  static parseAckPayload(payload: Uint8Array): { sessionId: number; nonce: number; snrDb: number } | null {
    if (payload.length < 16) return null
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const sessionId = view.getUint32(0, false)
    const nonce = view.getUint32(4, false)
    const snrDb = view.getFloat32(8, false)
    return { sessionId, nonce, snrDb }
  }

  /**
   * Classify link quality based on measured SNR and packet error rate
   */
  static classifyQuality(snrDb: number | null, validRatio: number): LinkTestResult['quality'] {
    if (!validRatio || validRatio < 0.5 || snrDb === null) return 'Failed'
    if (snrDb >= 20 && validRatio >= 0.9) return 'Excellent'
    if (snrDb >= 14 && validRatio >= 0.75) return 'Good'
    if (snrDb >= 8 && validRatio >= 0.5) return 'Marginal'
    return 'Poor'
  }
}
