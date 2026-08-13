import { describe, expect, it } from 'vitest'
import { AcousticLinkTester } from '../app/acoustic/transport/link-test'

describe('Acoustic Link Tester Preflight', () => {
  it('should encode and decode link probe payload cleanly', () => {
    const sessionId = 123456
    const nonce = 987654

    const payload = AcousticLinkTester.createProbePayload(sessionId, nonce)
    expect(payload.length).toBe(12)

    const parsed = AcousticLinkTester.parseProbePayload(payload)
    expect(parsed).not.toBeNull()
    expect(parsed?.sessionId).toBe(sessionId)
    expect(parsed?.nonce).toBe(nonce)
  })

  it('should classify link quality based on SNR and valid packet ratio', () => {
    expect(AcousticLinkTester.classifyQuality(22, 0.95)).toBe('Excellent')
    expect(AcousticLinkTester.classifyQuality(15, 0.8)).toBe('Good')
    expect(AcousticLinkTester.classifyQuality(9, 0.6)).toBe('Marginal')
    expect(AcousticLinkTester.classifyQuality(5, 0.4)).toBe('Failed')
  })
})
