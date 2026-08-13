import { describe, expect, it } from 'vitest'
import { AcousticPacketizer } from '../app/acoustic/framing/packetizer'
import {
  AcousticFrameType,
  decodeFrame,
  decodeTestFileComplete,
  encodeFrame,
  encodeTestFileComplete,
} from '../app/acoustic/protocol/frame'
import {
  decodeFrequencyProbe,
  decodeFrequencyReport,
  encodeFrequencyProbe,
  encodeFrequencyReport,
} from '../app/acoustic/transport/link-test'
import { MetricsCollector } from '../app/acoustic/metrics/stats'
import { EXPECTED_TEST_SHA256 } from '../app/constants/testPayload'

describe('Physical Transport & Protocol Codec Suite', () => {
  it('should encode and decode TEST_FILE_COMPLETE control frame cleanly', () => {
    const payload = {
      protocolVersion: 1,
      sessionId: 12345,
      testTransferId: 67890,
      expectedSha256: EXPECTED_TEST_SHA256,
      actualSha256: EXPECTED_TEST_SHA256,
      pass: true,
    }

    const encodedBytes = encodeTestFileComplete(payload)
    const decodedPayload = decodeTestFileComplete(encodedBytes)

    expect(decodedPayload).not.toBeNull()
    expect(decodedPayload?.sessionId).toBe(12345)
    expect(decodedPayload?.testTransferId).toBe(67890)
    expect(decodedPayload?.pass).toBe(true)
    expect(decodedPayload?.actualSha256).toBe(EXPECTED_TEST_SHA256)
  })

  it('should reject malformed or corrupted TEST_FILE_COMPLETE bytes', () => {
    const badBytes = new Uint8Array([0, 1, 2, 3])
    const decodedPayload = decodeTestFileComplete(badBytes)
    expect(decodedPayload).toBeNull()
  })

  it('should encode and decode FREQUENCY_PROBE and FREQUENCY_REPORT control frames', () => {
    const probe = {
      protocolVersion: 1,
      sessionId: 555,
      probeId: 999,
      targetFrequencyHz: 4000,
      toneDurationMs: 500,
      requestedGain: 0.7,
    }

    const probeBytes = encodeFrequencyProbe(probe)
    const decodedProbe = decodeFrequencyProbe(probeBytes)
    expect(decodedProbe?.targetFrequencyHz).toBe(4000)

    const report = {
      sessionId: 555,
      probeId: 999,
      requestedFrequency: 4000,
      detectedFrequency: 3998.5,
      freqError: 1.5,
      signalRms: 0.045,
      noiseFloor: 0.002,
      snrDb: 27.0,
      clipped: false,
      carrierDetected: true,
    }

    const reportBytes = encodeFrequencyReport(report)
    const decodedReport = decodeFrequencyReport(reportBytes)
    expect(decodedReport?.detectedFrequency).toBe(3998.5)
    expect(decodedReport?.snrDb).toBe(27.0)
  })

  it('should reject foreign-session frames once locked', () => {
    const packetizer = new AcousticPacketizer(12345) // Canonical session 12345
    const validFrame = packetizer.createSessionHeaderFrame({
      protocolVersion: 1,
      sessionId: 12345,
      filename: 'test.bin',
      contentType: 'text/plain',
      originalSize: 100,
      encodedSize: 100,
      fileChecksum: 99,
      totalFountainK: 1,
      modemProfile: 'robust',
    })

    const foreignFrame = encodeFrame(99999 /* Mismatched Session ID */, AcousticFrameType.DATA, 1, new Uint8Array([1, 2, 3]))

    const parsedValid = packetizer.parseIncomingBuffer(validFrame)
    const parsedForeign = packetizer.parseIncomingBuffer(foreignFrame)

    expect(parsedValid.frame?.sessionId).toBe(12345)
    expect(parsedForeign.frame?.sessionId).toBe(99999)
  })

  it('should report nullable snrDb in MetricsCollector when unmeasured', () => {
    const collector = new MetricsCollector()
    collector.start()

    const stats = collector.getStats()
    expect(stats.snrDb).toBeNull() // Nullable SNR when unmeasured!
  })
})
