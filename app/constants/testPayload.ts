import { crc32 } from '~/acoustic/protocol/crc32'

// Deterministic 8 KiB built-in test payload
export const TEST_PAYLOAD_SIZE = 8192

export function generateTestPayload(): Uint8Array {
  const data = new Uint8Array(TEST_PAYLOAD_SIZE)
  for (let i = 0; i < TEST_PAYLOAD_SIZE; i++) {
    data[i] = (i * 31 + 7) & 0xFF
  }
  return data
}

export const TEST_PAYLOAD_CRC = crc32(generateTestPayload())
