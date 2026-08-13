import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { EXPECTED_TEST_SHA256, generateTestPayload, TEST_PAYLOAD_SIZE } from '../app/constants/testPayload'

describe('Built-in Test Payload Fixture Verification', () => {
  it('should generate exact 8 KiB deterministic payload matching EXPECTED_TEST_SHA256', () => {
    const payload = generateTestPayload()
    expect(payload.length).toBe(TEST_PAYLOAD_SIZE)

    const computedHash = createHash('sha256').update(payload).digest('hex')
    expect(computedHash).toBe(EXPECTED_TEST_SHA256)
  })
})
