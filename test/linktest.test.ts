import { describe, expect, it } from 'vitest'
import { decodeFrame } from '../app/acoustic/protocol/frame'
import { AcousticLinkTester } from '../app/acoustic/transport/link-test'

describe('Acoustic Link Tester Preflight', () => {
  it('should encode and decode link probe control frame', () => {
    const sessionId = 123456
    const nonce = 987654

    const frameBytes = AcousticLinkTester.createProbeFrame(sessionId, nonce)
    const decoded = decodeFrame(frameBytes)

    expect(decoded).not.toBeNull()
    expect(decoded?.sessionId).toBe(sessionId)
    expect(decoded?.frameType).toBe(0x02 /* LINK_PROBE */)

    const parsed = AcousticLinkTester.parseProbePayload(decoded!.payload)
    expect(parsed?.nonce).toBe(nonce)
  })

  it('should encode and decode link ACK control frame', () => {
    const sessionId = 123456
    const nonce = 987654
    const snrDb = 22.5

    const frameBytes = AcousticLinkTester.createAckFrame(sessionId, nonce, snrDb)
    const decoded = decodeFrame(frameBytes)

    expect(decoded).not.toBeNull()
    expect(decoded?.frameType).toBe(0x03 /* LINK_ACK */)

    const parsed = AcousticLinkTester.parseAckPayload(decoded!.payload)
    expect(parsed?.nonce).toBe(nonce)
    expect(parsed?.snrDb).toBeCloseTo(snrDb, 1)
  })

  it('should classify link quality based on SNR and valid packet ratio', () => {
    expect(AcousticLinkTester.classifyQuality(22, 0.95)).toBe('Excellent')
    expect(AcousticLinkTester.classifyQuality(15, 0.8)).toBe('Good')
    expect(AcousticLinkTester.classifyQuality(9, 0.6)).toBe('Marginal')
    expect(AcousticLinkTester.classifyQuality(5, 0.4)).toBe('Failed')
  })
})
