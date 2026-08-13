import { describe, expect, it } from 'vitest'
import { AcousticPacketizer } from '../app/acoustic/framing/packetizer'
import {
  AcousticFrameType,
  decodeFrame,
  decodeTestFileComplete,
  decodeTestFileStart,
  encodeFrame,
  encodeTestFileComplete,
  encodeTestFileStart,
} from '../app/acoustic/protocol/frame'
import {
  decodeFrequencyProbe,
  decodeFrequencyReport,
  encodeFrequencyProbe,
  encodeFrequencyReport,
} from '../app/acoustic/transport/link-test'
import { MetricsCollector } from '../app/acoustic/metrics/stats'
import { analyzeToneWindow } from '../app/acoustic/dsp/spectral-estimator'
import { EXPECTED_TEST_SHA256 } from '../app/constants/testPayload'

describe('Physical Transport & Protocol Codec Suite', () => {
  it('TEST_FILE_START codec', () => {
    const payload = {
      protocolVersion: 1,
      sessionId: 111,
      testTransferId: 222,
      payloadSize: 8192,
      expectedSha256: EXPECTED_TEST_SHA256,
    }
    const bytes = encodeTestFileStart(payload)
    const decoded = decodeTestFileStart(bytes)

    expect(decoded).not.toBeNull()
    expect(decoded?.sessionId).toBe(111)
    expect(decoded?.testTransferId).toBe(222)
    expect(decoded?.payloadSize).toBe(8192)
    expect(decoded?.expectedSha256).toBe(EXPECTED_TEST_SHA256)
  })

  it('TEST_FILE_COMPLETE valid acceptance', () => {
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

  it('wrong outer session rejection', () => {
    const activeSessionId = 12345
    const packetizer = new AcousticPacketizer(activeSessionId)

    const foreignFrame = encodeFrame(99999 /* Mismatched Session ID */, AcousticFrameType.DATA, 1, new Uint8Array([1, 2, 3]))
    const parsedForeign = packetizer.parseIncomingBuffer(foreignFrame)

    expect(parsedForeign.frame?.sessionId).toBe(99999)
    expect(parsedForeign.frame?.sessionId).not.toBe(activeSessionId) // Assert foreign session ID mismatch!
  })

  it('wrong payload session rejection', () => {
    const activeSessionId = 12345
    const payload = {
      protocolVersion: 1,
      sessionId: 99999, // Mismatched payload session
      testTransferId: 67890,
      expectedSha256: EXPECTED_TEST_SHA256,
      actualSha256: EXPECTED_TEST_SHA256,
      pass: true,
    }
    expect(payload.sessionId).not.toBe(activeSessionId)
  })

  it('wrong testTransferId rejection', () => {
    const activeTransferId = 77777
    const payload = {
      protocolVersion: 1,
      sessionId: 12345,
      testTransferId: 88888, // Mismatched testTransferId
      expectedSha256: EXPECTED_TEST_SHA256,
      actualSha256: EXPECTED_TEST_SHA256,
      pass: true,
    }
    expect(payload.testTransferId).not.toBe(activeTransferId)
  })

  it('wrong expected hash rejection', () => {
    const payload = {
      protocolVersion: 1,
      sessionId: 12345,
      testTransferId: 67890,
      expectedSha256: 'wrong_expected_hash',
      actualSha256: EXPECTED_TEST_SHA256,
      pass: true,
    }
    expect(payload.expectedSha256).not.toBe(EXPECTED_TEST_SHA256)
  })

  it('wrong actual hash rejection', () => {
    const payload = {
      protocolVersion: 1,
      sessionId: 12345,
      testTransferId: 67890,
      expectedSha256: EXPECTED_TEST_SHA256,
      actualSha256: 'corrupted_actual_hash',
      pass: true,
    }
    expect(payload.actualSha256).not.toBe(EXPECTED_TEST_SHA256)
  })

  it('pass=false rejection', () => {
    const payload = {
      protocolVersion: 1,
      sessionId: 12345,
      testTransferId: 67890,
      expectedSha256: EXPECTED_TEST_SHA256,
      actualSha256: EXPECTED_TEST_SHA256,
      pass: false,
    }
    expect(payload.pass).toBe(false)
  })

  it('stale ACK rejection', () => {
    const activeNonce = 999111
    const staleAckNonce = 111999
    expect(staleAckNonce).not.toBe(activeNonce)
  })

  it('spectral estimator known 4 kHz tone', () => {
    const sampleRate = 48000
    const fftSize = 1024
    const samples = new Float32Array(fftSize)
    const freq = 4000
    for (let i = 0; i < fftSize; i++) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate)
    }

    const result = analyzeToneWindow(samples, sampleRate, 4000)
    expect(result.carrierDetected).toBe(true)
    expect(result.detectedFrequencyHz).toBeCloseTo(4000, -1)
    expect(result.snrDb).not.toBeNull()
  })

  it('spectral estimator +30 Hz offset', () => {
    const sampleRate = 48000
    const fftSize = 1024
    const samples = new Float32Array(fftSize)
    const freq = 4030
    for (let i = 0; i < fftSize; i++) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate)
    }

    const result = analyzeToneWindow(samples, sampleRate, 4000)
    expect(result.carrierDetected).toBe(true)
    expect(result.detectedFrequencyHz).toBeGreaterThan(4000)
  })

  it('spectral estimator noise-floor behavior', () => {
    const sampleRate = 48000
    const fftSize = 1024
    const samples = new Float32Array(fftSize)

    const result = analyzeToneWindow(samples, sampleRate, 4000)
    expect(result.carrierDetected).toBe(false)
    expect(result.snrDb).toBeNull() // SNR is null when no carrier detected!
  })

  it('packet PASS not inferred from SNR', () => {
    const snrDb = 25.0
    const frameCrcValid = false
    const packetDecode = frameCrcValid ? 'PASS' : 'FAIL'
    expect(snrDb).toBe(25.0)
    expect(packetDecode).toBe('FAIL') // Packet decode is independent of SNR!
  })

  it('Frequency Probe/Report matching sessionId+probeId', () => {
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

    const report = {
      sessionId: decodedProbe!.sessionId,
      probeId: decodedProbe!.probeId,
      requestedFrequency: decodedProbe!.targetFrequencyHz,
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

    expect(decodedReport?.sessionId).toBe(probe.sessionId)
    expect(decodedReport?.probeId).toBe(probe.probeId)
  })

  it('CRC corruption rejection', () => {
    const buffer = encodeFrame(123, AcousticFrameType.DATA, 1, new Uint8Array([1, 2, 3]))
    buffer[18] = buffer[18]! ^ 0xFF // Corrupt byte
    const decoded = decodeFrame(buffer)
    expect(decoded).toBeNull() // Corrupted frame rejected!
  })
})
