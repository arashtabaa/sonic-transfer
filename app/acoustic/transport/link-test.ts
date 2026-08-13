import { AcousticPacketizer } from '../framing/packetizer'
import { BFSKAcousticModem } from '../modulation/bfsk-modem'
import { getProfileConfig, ModemProfileKey } from '../modulation/modem'
import { crc32 } from '../protocol/crc32'

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
   * Generates a Link Probe payload containing random nonce and timestamp
   */
  static createProbePayload(sessionId: number, nonce: number): Uint8Array {
    const buffer = new Uint8Array(12)
    const view = new DataView(buffer.buffer)
    view.setUint32(0, sessionId, false)
    view.setUint32(4, nonce, false)
    view.setUint32(8, Date.now() >>> 0, false)
    return buffer
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
