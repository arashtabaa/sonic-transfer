import { AcousticFrameType, encodeFrame } from '../protocol/frame'
import { ModemProfileKey } from '../modulation/modem'

export interface LinkTestOptions {
  profileKey: ModemProfileKey
  sampleRate: number
  gain: number
}

export interface LinkTestResult {
  success: boolean
  stage: 'output_ready' | 'carrier_detected' | 'preamble_detected' | 'crc_verified' | 'failed'
  snrDb: number
  packetSuccessRatio: number
  quality: 'Excellent' | 'Good' | 'Marginal' | 'Poor' | 'Failed'
  nonce: number
  recommendedProfile: ModemProfileKey
  message: string
}

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
  static createAckFrame(sessionId: number, nonce: number, snrDb: number, sequence = 1): Uint8Array {
    const buffer = new Uint8Array(16)
    const view = new DataView(buffer.buffer)
    view.setUint32(0, sessionId, false)
    view.setUint32(4, nonce, false)
    view.setFloat32(8, snrDb, false)
    view.setUint32(12, Date.now() >>> 0, false)
    return encodeFrame(sessionId, AcousticFrameType.LINK_ACK, sequence, buffer)
  }

  /**
   * Generates a Channel Report control frame
   */
  static createChannelReportFrame(sessionId: number, validRatio: number, snrDb: number, sequence = 1): Uint8Array {
    const buffer = new Uint8Array(12)
    const view = new DataView(buffer.buffer)
    view.setUint32(0, sessionId, false)
    view.setFloat32(4, validRatio, false)
    view.setFloat32(8, snrDb, false)
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
  static classifyQuality(snrDb: number, validRatio: number): LinkTestResult['quality'] {
    if (!validRatio || validRatio < 0.5) return 'Failed'
    if (snrDb >= 20 && validRatio >= 0.9) return 'Excellent'
    if (snrDb >= 14 && validRatio >= 0.75) return 'Good'
    if (snrDb >= 8 && validRatio >= 0.5) return 'Marginal'
    return 'Poor'
  }
}
