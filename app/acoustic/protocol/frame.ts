import { crc32 } from './crc32'

export enum AcousticFrameType {
  BEACON = 0x01,
  LINK_PROBE = 0x02,
  LINK_ACK = 0x03,
  CHANNEL_REPORT = 0x04,
  PROFILE_PROPOSE = 0x05,
  PROFILE_ACCEPT = 0x06,
  PROFILE_REJECT = 0x07,
  TEST_FILE_START = 0x08,
  TEST_FILE_COMPLETE = 0x09,
  TRANSFER_START = 0x0A,
  TRANSFER_STATUS = 0x0B,
  TRANSFER_END = 0x0C,
  FREQUENCY_PROBE = 0x0E,
  FREQUENCY_REPORT = 0x0F,
  SESSION_HEADER = 0x10,
  DATA = 0x11,
  END = 0x12,
  PROFILE_PROBE_END = 0x13,
}

export interface AcousticFrame {
  version: number
  sessionId: number
  frameType: AcousticFrameType
  sequence: number
  payload: Uint8Array
  checksum: number
}

export interface SessionHeaderPayload {
  protocolVersion: number
  sessionId: number
  filename: string
  contentType: string
  originalSize: number
  encodedSize: number
  fileChecksum: number
  sha256Hex?: string
  totalFountainK: number
  modemProfile: string
}

export interface TestFileStartPayload {
  protocolVersion: number
  sessionId: number
  testTransferId: number
  payloadSize: number
  expectedSha256: string
}

export interface TestFileCompletePayload {
  protocolVersion: number
  sessionId: number
  testTransferId: number
  expectedSha256: string
  actualSha256: string
  pass: boolean
}

export interface TransferStatusPayload { protocolVersion: number; transferSessionId: number; blocksReceived: number; decodedCount: number; complete: boolean }
export interface TransferEndPayload { protocolVersion: number; transferSessionId: number; expectedSha256: string; actualSha256: string; pass: boolean; blocksReceived: number }

export function encodeTransferStatus(payload: TransferStatusPayload): Uint8Array { return new TextEncoder().encode(JSON.stringify(payload)) }
export function decodeTransferStatus(bytes: Uint8Array): TransferStatusPayload | null { try { const p = JSON.parse(new TextDecoder().decode(bytes)); return p.protocolVersion === 1 && Number.isInteger(p.transferSessionId) && Number.isInteger(p.blocksReceived) && Number.isInteger(p.decodedCount) && typeof p.complete === 'boolean' ? p : null } catch { return null } }
export function encodeTransferEnd(payload: TransferEndPayload): Uint8Array { return new TextEncoder().encode(JSON.stringify(payload)) }
export function decodeTransferEnd(bytes: Uint8Array): TransferEndPayload | null { try { const p = JSON.parse(new TextDecoder().decode(bytes)); return p.protocolVersion === 1 && Number.isInteger(p.transferSessionId) && typeof p.expectedSha256 === 'string' && typeof p.actualSha256 === 'string' && typeof p.pass === 'boolean' && Number.isInteger(p.blocksReceived) ? p : null } catch { return null } }

export interface ProfileProbePayload {
  protocolVersion: number
  sessionId: number
  verificationNonce: number
  profile: string
  probeSequence: number
  totalProbes: number
}

export type ProfileVerificationClass = 'READY' | 'MARGINAL' | 'FAILED'

export interface ChannelReportPayload {
  protocolVersion: number
  sessionId: number
  verificationNonce: number
  profile: string
  attemptedProbes: number
  framesDetected: number
  crcValid: number
  crcInvalid: number
  per: number
  classification: ProfileVerificationClass
  sampleRate: number
  configFingerprint: string
}

export interface ProfileProbeEndPayload {
  protocolVersion: number
  sessionId: number
  verificationNonce: number
  profile: string
  attemptedProbes: number
}

export interface ProfileRejectPayload {
  protocolVersion: number
  sessionId: number
  verificationNonce: number
  profile: string
  reason: 'UNSUPPORTED_PROFILE' | 'NYQUIST_INCOMPATIBLE' | 'INVALID_CONFIG' | 'UNSUPPORTED_MODULATION' | 'BUSY' | 'PROTOCOL_VERSION_MISMATCH'
}

export function encodeProfileProbe(payload: ProfileProbePayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

export function decodeProfileProbe(bytes: Uint8Array): ProfileProbePayload | null {
  try {
    const payload = parseObject(bytes) as ProfileProbePayload
    if (payload.protocolVersion !== PROTOCOL_VERSION || !isKnownProfile(payload.profile) || !isUint32(payload.sessionId) || !isUint32(payload.verificationNonce) || !Number.isInteger(payload.totalProbes) || payload.totalProbes < 1 || payload.totalProbes > 128 || !Number.isInteger(payload.probeSequence) || payload.probeSequence < 1 || payload.probeSequence > payload.totalProbes) return null
    return payload
  } catch { return null }
}

export function encodeChannelReport(payload: ChannelReportPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

export function decodeChannelReport(bytes: Uint8Array): ChannelReportPayload | null {
  try {
    const payload = parseObject(bytes) as ChannelReportPayload
    if (payload.protocolVersion !== PROTOCOL_VERSION || !isKnownProfile(payload.profile) || !isUint32(payload.sessionId) || !isUint32(payload.verificationNonce) || !Number.isInteger(payload.attemptedProbes) || payload.attemptedProbes < 1 || payload.attemptedProbes > 128 || !Number.isInteger(payload.framesDetected) || payload.framesDetected < 0 || !Number.isInteger(payload.crcValid) || payload.crcValid < 0 || payload.crcValid > payload.attemptedProbes || !Number.isInteger(payload.crcInvalid) || payload.crcInvalid < 0 || !Number.isFinite(payload.per) || payload.per < 0 || payload.per > 1 || !['READY', 'MARGINAL', 'FAILED'].includes(payload.classification) || !Number.isFinite(payload.sampleRate) || payload.sampleRate < 8000 || payload.sampleRate > 192000 || typeof payload.configFingerprint !== 'string' || payload.configFingerprint.length < 8 || payload.configFingerprint.length > 512) return null
    return payload
  } catch { return null }
}

export function encodeProfileProbeEnd(payload: ProfileProbeEndPayload): Uint8Array { return new TextEncoder().encode(JSON.stringify(payload)) }
export function decodeProfileProbeEnd(bytes: Uint8Array): ProfileProbeEndPayload | null {
  try { const payload = parseObject(bytes) as ProfileProbeEndPayload; return payload.protocolVersion === PROTOCOL_VERSION && isKnownProfile(payload.profile) && isUint32(payload.sessionId) && isUint32(payload.verificationNonce) && Number.isInteger(payload.attemptedProbes) && payload.attemptedProbes >= 1 && payload.attemptedProbes <= 128 ? payload : null } catch { return null }
}
export function encodeProfileReject(payload: ProfileRejectPayload): Uint8Array { return new TextEncoder().encode(JSON.stringify(payload)) }
export function decodeProfileReject(bytes: Uint8Array): ProfileRejectPayload | null {
  try { const payload = parseObject(bytes) as ProfileRejectPayload; return payload.protocolVersion === PROTOCOL_VERSION && isKnownProfile(payload.profile) && isUint32(payload.sessionId) && isUint32(payload.verificationNonce) && ['UNSUPPORTED_PROFILE', 'NYQUIST_INCOMPATIBLE', 'INVALID_CONFIG', 'UNSUPPORTED_MODULATION', 'BUSY', 'PROTOCOL_VERSION_MISMATCH'].includes(payload.reason) ? payload : null } catch { return null }
}

export function classifyProfileVerification(crcValid: number, attemptedProbes: number): ProfileVerificationClass {
  if (attemptedProbes <= 0) return 'FAILED'
  const ratio = crcValid / attemptedProbes
  if (ratio >= 0.9) return 'READY'
  if (ratio >= 0.6) return 'MARGINAL'
  return 'FAILED'
}

function parseObject(bytes: Uint8Array): Record<string, any> {
  const value = JSON.parse(new TextDecoder().decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object')
  return value
}

function isUint32(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff }
export const KNOWN_PROFILE_KEYS = ['auto', 'robust', 'balanced', 'turbo', 'near_ultrasonic', 'ultrasonic_experimental', 'fast_data_experimental', 'custom'] as const
export function isKnownProfile(value: unknown): boolean { return KNOWN_PROFILE_KEYS.includes(String(value) as typeof KNOWN_PROFILE_KEYS[number]) }

export function encodeTestFileStart(payload: TestFileStartPayload): Uint8Array {
  const jsonStr = JSON.stringify(payload)
  return new TextEncoder().encode(jsonStr)
}

export function decodeTestFileStart(bytes: Uint8Array): TestFileStartPayload | null {
  try {
    const jsonStr = new TextDecoder().decode(bytes)
    return JSON.parse(jsonStr) as TestFileStartPayload
  } catch {
    return null
  }
}

export function encodeTestFileComplete(payload: TestFileCompletePayload): Uint8Array {
  const jsonStr = JSON.stringify(payload)
  return new TextEncoder().encode(jsonStr)
}

export function decodeTestFileComplete(bytes: Uint8Array): TestFileCompletePayload | null {
  try {
    const jsonStr = new TextDecoder().decode(bytes)
    return JSON.parse(jsonStr) as TestFileCompletePayload
  } catch {
    return null
  }
}

/**
 * Reusable validation function for TEST_FILE_COMPLETE frames (Requirement 2).
 * Validates outer frame CRC32, outer session ID, payload session ID, payload testTransferId, expected SHA-256, actual SHA-256, and pass === true.
 */
export function validateTestFileCompleteFrame(
  frame: AcousticFrame | null,
  payload: TestFileCompletePayload | null,
  activeTestSessionId: number,
  activeTestTransferId: number,
  expectedSha256Constant: string,
): boolean {
  if (!frame || !payload) return false
  if (frame.frameType !== AcousticFrameType.TEST_FILE_COMPLETE) return false
  if (frame.sessionId !== activeTestSessionId) return false
  if (payload.protocolVersion !== 1) return false
  if (payload.sessionId !== activeTestSessionId) return false
  if (payload.testTransferId !== activeTestTransferId) return false
  if (payload.expectedSha256 !== expectedSha256Constant) return false
  if (payload.actualSha256 !== expectedSha256Constant) return false
  if (payload.pass !== true) return false
  return true
}

export const PREAMBLE_BYTES = new Uint8Array([0x53, 0x4F, 0x4E, 0x49]) // "SONI"
export const PROTOCOL_VERSION = 1
export const FRAME_HEADER_SIZE = 4 + 1 + 4 + 1 + 4 + 2 // Preamble (4) + Ver(1) + SessionID(4) + Type(1) + Seq(4) + Len(2)
export const FRAME_FOOTER_SIZE = 4 // CRC32 (4)

/**
 * Serialize an AcousticFrame into a Uint8Array byte buffer.
 */
export function encodeFrame(
  sessionId: number,
  frameType: AcousticFrameType,
  sequence: number,
  payload: Uint8Array,
): Uint8Array {
  const payloadLen = payload.length
  const totalSize = FRAME_HEADER_SIZE + payloadLen + FRAME_FOOTER_SIZE
  const buffer = new Uint8Array(totalSize)
  const view = new DataView(buffer.buffer)

  // 1. Preamble (4 bytes)
  buffer.set(PREAMBLE_BYTES, 0)

  // 2. Protocol Version (1 byte)
  view.setUint8(4, PROTOCOL_VERSION)

  // 3. Session ID (4 bytes)
  view.setUint32(5, sessionId, false)

  // 4. Frame Type (1 byte)
  view.setUint8(9, frameType)

  // 5. Sequence number (4 bytes)
  view.setUint32(10, sequence, false)

  // 6. Payload Length (2 bytes)
  view.setUint16(14, payloadLen, false)

  // 7. Payload
  buffer.set(payload, 16)

  // 8. CRC32 computed over header + payload
  const bodyForCrc = buffer.subarray(0, 16 + payloadLen)
  const checksum = crc32(bodyForCrc)
  view.setUint32(16 + payloadLen, checksum, false)

  return buffer
}

/**
 * Deserialize a Uint8Array byte buffer into an AcousticFrame. Returns null if CRC check fails or preamble is invalid.
 */
export function decodeFrame(buffer: Uint8Array): AcousticFrame | null {
  if (buffer.length < FRAME_HEADER_SIZE + FRAME_FOOTER_SIZE) {
    return null
  }

  // Check preamble
  if (
    buffer[0] !== PREAMBLE_BYTES[0] ||
    buffer[1] !== PREAMBLE_BYTES[1] ||
    buffer[2] !== PREAMBLE_BYTES[2] ||
    buffer[3] !== PREAMBLE_BYTES[3]
  ) {
    return null
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const version = view.getUint8(4)
  const sessionId = view.getUint32(5, false)
  const frameType = view.getUint8(9) as AcousticFrameType
  const sequence = view.getUint32(10, false)
  const payloadLen = view.getUint16(14, false)

  if (buffer.length < FRAME_HEADER_SIZE + payloadLen + FRAME_FOOTER_SIZE) {
    return null
  }

  const payload = buffer.subarray(16, 16 + payloadLen)
  const expectedCrc = view.getUint32(16 + payloadLen, false)

  const bodyForCrc = buffer.subarray(0, 16 + payloadLen)
  const actualCrc = crc32(bodyForCrc)

  if (expectedCrc !== actualCrc) {
    return null // Corrupted frame rejected!
  }

  return {
    version,
    sessionId,
    frameType,
    sequence,
    payload: new Uint8Array(payload),
    checksum: actualCrc,
  }
}

/**
 * Serialize SessionHeaderPayload to bytes
 */
export function encodeSessionHeader(header: SessionHeaderPayload): Uint8Array {
  const jsonStr = JSON.stringify(header)
  return new TextEncoder().encode(jsonStr)
}

/**
 * Deserialize bytes to SessionHeaderPayload
 */
export function decodeSessionHeader(bytes: Uint8Array): SessionHeaderPayload | null {
  try {
    const jsonStr = new TextDecoder().decode(bytes)
    return JSON.parse(jsonStr) as SessionHeaderPayload
  } catch {
    return null
  }
}
