import { describe, expect, it } from 'vitest'
import { AcousticFrameType, AdaptiveHandshakeController, AdaptiveHandshakeRuntime, FrequencyProbeAnalyzer, FrequencyProbeRenderer, HALF_DUPLEX_TIMING, StreamingFrequencyProbeAnalyzer, actualCarrierFrequencies, classifyLevel, createAdaptivePilotConfig, decodeCalibrationCommand, decodeCalibrationPing, decodeFrequencyProbe, decodeFrequencyReport, decodeLevelReport, encodeCalibrationCommand, encodeCalibrationPing, encodeFrequencyProbe, encodeFrequencyReport, encodeLevelReport, fingerprintAdaptiveConfig, selectFrequencyBand, selectGain, selectMeasuredV2Config, type FrequencyMeasurement, type GainMeasurement } from '../app/acoustic'

const sha = 'a'.repeat(64)

describe('adaptive acoustic handshake V1', () => {
  it('uses strict calibration frame IDs and codecs', () => {
    expect(AcousticFrameType.CALIBRATION_COMMAND).toBe(0x14)
    const command = { protocolVersion: 1, controlSessionId: 10, calibrationNonce: 20, phase: 'START_GAIN_SWEEP' as const, direction: 'INITIATOR_TO_RESPONDER' as const, sequence: 1 }
    expect(decodeCalibrationCommand(encodeCalibrationCommand(command))).toEqual(command)
    const ping = { protocolVersion: 1, controlSessionId: 10, calibrationNonce: 20, pingSequence: 1, txAppGain: 0.26 }
    expect(decodeCalibrationPing(encodeCalibrationPing(ping))).toEqual(ping)
    const report = { protocolVersion: 1, controlSessionId: 10, calibrationNonce: 20, pingSequence: 1, signalPeak: 0.5, signalRms: 0.2, noiseRms: 0.01, snrDb: 26, clippingFraction: 0, crcValid: true, classification: 'GOOD' as const }
    expect(decodeLevelReport(encodeLevelReport(report))).toEqual(report)
    expect(decodeCalibrationPing(encodeCalibrationPing({ ...ping, txAppGain: 1.2 }))).toBeNull()
    expect(sha).toHaveLength(64)
  })

  it('selects the lowest gain with repeated reliable evidence', () => {
    const measurements: GainMeasurement[] = [0.18, 0.18, 0.18].map(gain => ({ gain, classification: 'TOO_WEAK', snrDb: 3, clippingFraction: 0, crcValid: true }))
    measurements.push(...[0.26, 0.26, 0.26].map(gain => ({ gain, classification: 'GOOD' as const, snrDb: 14, clippingFraction: 0, crcValid: true })))
    measurements.push(...[0.34, 0.34, 0.34].map(gain => ({ gain, classification: 'GOOD' as const, snrDb: 20, clippingFraction: 0.2, crcValid: true })))
    expect(selectGain(measurements).selectedGain).toBe(0.26)
    expect(classifyLevel(0.4, 0.01, 0.2, true)).toBe('TOO_LOUD')
  })

  it('rejects severe attenuation at the safe maximum', () => {
    const measurements: GainMeasurement[] = [0.12, 0.26, 0.46, 0.85].flatMap(gain => [1, 2, 3].map(() => ({ gain, classification: 'NOT_HEARD' as const, snrDb: null, clippingFraction: 0, crcValid: false })))
    expect(selectGain(measurements).reason).toBe('SIGNAL_TOO_WEAK_AT_MAX_APP_GAIN')
  })

  it('selects a contiguous viable band and applies the Nyquist guard', () => {
    const measurements: FrequencyMeasurement[] = [6000, 8000, 10000, 12000, 14000, 16000, 18000].map(frequencyHz => ({ frequencyHz, signalRms: 0.1, noiseRms: 0.01, snrDb: frequencyHz < 14000 ? 20 : 2, peak: 0.4, usable: frequencyHz < 14000, clipped: false }))
    const band = selectFrequencyBand(measurements, 48000, 4)
    expect(band?.selectedStartFreq).toBe(6000)
    expect(band?.selectedEndFreq).toBe(12000)
    expect(selectFrequencyBand(measurements.map(m => ({ ...m, frequencyHz: 23000 })), 48000, 4)).toBeNull()
  })

  it('records evidence-backed half-duplex dialogue and reaches READY only after profile verification', () => {
    let now = 100
    const runtime = new AdaptiveHandshakeRuntime(() => now++)
    runtime.start(10, 20)
    runtime.recordControlLink(true)
    const good = [0.26, 0.26, 0.26].map(gain => ({ gain, classification: 'GOOD' as const, snrDb: 14, clippingFraction: 0, crcValid: true }))
    expect(runtime.lockLocalGain(good).selectedGain).toBe(0.26)
    runtime.beginRemoteGain()
    expect(runtime.lockRemoteGain(good).selectedGain).toBe(0.26)
    const band = runtime.selectBand([6000, 8000, 10000, 12000].map(frequencyHz => ({ frequencyHz, signalRms: 0.1, noiseRms: 0.01, snrDb: 20, peak: 0.3, usable: true, clipped: false })), 48000, 4)
    expect(band).not.toBeNull()
    runtime.beginProfileVerification()
    runtime.profileAccepted()
    runtime.complete({ controlSessionId: 10, calibrationNonce: 20, localTxGain: 0.26, remoteTxGain: 0.26, selectedDataProfile: 'fast_data_experimental', modulationId: 'PILOT_MULTITONE_V2', startFreq: 6000, endFreq: 12000, carrierCount: 4, pilotInterval: 16, txSampleRate: 48000, rxSampleRate: 44100, configFingerprint: 'fingerprint-123', verificationClass: 'READY', createdAt: now })
    expect(runtime.state).toBe('READY')
    expect(runtime.events.some(event => event.message.includes('Selected DATA band'))).toBe(true)
  })

  it('centralizes response timing after the sender RX guard', () => {
    expect(HALF_DUPLEX_TIMING.RX_TO_TX_GUARD_MS).toBeGreaterThan(0)
    expect(1000 + HALF_DUPLEX_TIMING.RX_TO_TX_GUARD_MS).toBe(1200)
  })

  it('fingerprints the exact negotiated V2 profile and rejects unsafe bands', () => {
    const config = createAdaptivePilotConfig(44100, { selectedStartFreq: 6000, selectedEndFreq: 12000, selectedCarrierCount: 8 }, { gain: 0.34, pilotInterval: 8 })
    expect(config.endFreq).toBe(12000)
    expect(fingerprintAdaptiveConfig(config)).toContain('"pilotInterval":8')
    expect(() => createAdaptivePilotConfig(44100, { selectedStartFreq: 6000, selectedEndFreq: 22050, selectedCarrierCount: 8 })).toThrow()
  })

  it('renders and analyzes a chunk-offset frequency probe through PCM', () => {
    const probe = { protocolVersion: 1, controlSessionId: 10, calibrationNonce: 20, probeSequence: 1, frequenciesHz: [6000, 8000, 10000, 12000], toneDurationMs: 40, guardMs: 20, probeGain: 0.3 }
    expect(decodeFrequencyProbe(encodeFrequencyProbe(probe))).toEqual(probe)
    const rendered = new FrequencyProbeRenderer().render({ sampleRate: 44100, frequenciesHz: probe.frequenciesHz, toneDurationMs: probe.toneDurationMs, guardMs: probe.guardMs, gain: probe.probeGain })
    const shifted = new Float32Array(rendered.samples.length + 7)
    shifted.set(rendered.samples, 7)
    const chunks: Float32Array[] = []
    for (let i = 0; i < shifted.length; i += 257) chunks.push(shifted.subarray(i, Math.min(shifted.length, i + 257)))
    const merged = new Float32Array(shifted.length)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
    const measurements = new FrequencyProbeAnalyzer({ sampleRate: 44100, frequenciesHz: probe.frequenciesHz, toneDurationMs: probe.toneDurationMs, guardMs: probe.guardMs }).analyze(merged, 7)
    const streaming = new StreamingFrequencyProbeAnalyzer(new FrequencyProbeAnalyzer({ sampleRate: 44100, frequenciesHz: probe.frequenciesHz, toneDurationMs: probe.toneDurationMs, guardMs: probe.guardMs }))
    for (let i = 0; i < merged.length; i += 257) streaming.pushSamples(merged.subarray(i, Math.min(merged.length, i + 257)))
    expect(streaming.analyze(7)).toEqual(measurements)
    expect(measurements).toHaveLength(4)
    expect(measurements.every(measurement => measurement.signalRms > 0.01)).toBe(true)
    const report = { protocolVersion: 1, controlSessionId: 10, calibrationNonce: 20, probeSequence: 1, measurements }
    expect(decodeFrequencyReport(encodeFrequencyReport(report))).toEqual(report)
  })

  it('selects V2 candidates from actual carrier-center evidence', () => {
    const frequencies = actualCarrierFrequencies(6000, 12000, 4)
    const measurements = frequencies.map(frequencyHz => ({ frequencyHz, signalRms: 0.1, noiseRms: 0.01, snrDb: 20, peak: 0.3, usable: true, clipped: false }))
    const selected = selectMeasuredV2Config(measurements, 44100, 0.26)
    expect(selected?.config.carrierCount).toBe(4)
    expect(selected?.carrierFrequencies).toEqual(frequencies)
  })

  it('drives repeated calibration attempts through injected acoustic I/O', async () => {
    const sentGains: number[] = []
    const controller = new AdaptiveHandshakeController({
      runtime: new AdaptiveHandshakeRuntime(() => 1),
      transport: {
        sendRobust: async (_frame, gain) => { sentGains.push(gain) },
        waitForLevelReport: async (_context, _sequence) => ({ protocolVersion: 1, controlSessionId: 10, calibrationNonce: 20, pingSequence: 1, signalPeak: 0.2, signalRms: 0.1, noiseRms: 0.01, snrDb: 20, clippingFraction: 0, crcValid: true, classification: 'GOOD' as const }),
      },
      setCandidateGain: () => {},
    })
    const result = await controller.runGainSweep({ controlSessionId: 10, calibrationNonce: 20, role: 'INITIATOR', startedAt: 0 }, 'INITIATOR_TO_RESPONDER')
    expect(result.selectedGain).toBe(0.12)
    expect(sentGains.length).toBe(24)
  })
})
