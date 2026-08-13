import { crc32 } from '../acoustic/protocol/crc32'

export const TEST_PAYLOAD_SIZE = 8192

export function generateTestPayload(): Uint8Array {
  const data = new Uint8Array(TEST_PAYLOAD_SIZE)
  for (let i = 0; i < TEST_PAYLOAD_SIZE; i++) {
    data[i] = (i * 31 + 7) & 0xFF
  }
  return data
}

export const TEST_PAYLOAD_CRC = crc32(generateTestPayload())

// Pre-computed SHA-256 for deterministic 8 KiB test payload
export const EXPECTED_TEST_SHA256 = '3faac63d133ee546e983a131136bc44c9d3c0910d1c6b143d60509ef90a386e7'
