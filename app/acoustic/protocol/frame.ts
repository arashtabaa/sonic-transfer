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

export interface TestFileCompletePayload {
  protocolVersion: number
  sessionId: number
  testTransferId: number
  expectedSha256: string
  actualSha256: string
  pass: boolean
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
