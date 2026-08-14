import { AcousticFrameType, decodeLevelReport, encodeCalibrationPing, encodeFrame, type LevelReportPayload } from '../protocol/frame'
import { INITIAL_SYNTHETIC_CALIBRATION_POLICY, type AdaptiveHandshakeState, type AdaptiveLinkContext, type GainMeasurement, AdaptiveHandshakeRuntime, selectGain } from './adaptive-handshake-runtime'

export interface AdaptiveCalibrationTransport {
  sendRobust(frame: Uint8Array, gain: number): Promise<void>
  waitForLevelReport(context: AdaptiveLinkContext, pingSequence: number, timeoutMs: number): Promise<LevelReportPayload | null>
}

export interface AdaptiveHandshakeControllerOptions {
  transport: AdaptiveCalibrationTransport
  runtime: AdaptiveHandshakeRuntime
  setCandidateGain: (gain: number | null) => void
  eventSink?: (event: { state: AdaptiveHandshakeState; message: string }) => void
  timeoutMs?: number
}

export class AdaptiveHandshakeController {
  private pingSequence = 0
  constructor(private readonly options: AdaptiveHandshakeControllerOptions) {}

  start(context: AdaptiveLinkContext): void {
    this.options.runtime.start(context.controlSessionId, context.calibrationNonce)
    this.emit('BOOTSTRAP_CONTROL_LINK', 'Connecting... Sending robust link probe')
  }

  async runGainSweep(context: AdaptiveLinkContext, direction: 'INITIATOR_TO_RESPONDER' | 'RESPONDER_TO_INITIATOR'): Promise<ReturnType<typeof selectGain>> {
    const measurements: GainMeasurement[] = []
    for (const gain of INITIAL_SYNTHETIC_CALIBRATION_POLICY.candidates) {
      this.options.setCandidateGain(gain)
      this.emit(direction === 'INITIATOR_TO_RESPONDER' ? 'LOCAL_GAIN_SWEEP' : 'REMOTE_GAIN_SWEEP', `Testing ${direction === 'INITIATOR_TO_RESPONDER' ? 'local' : 'remote'} gain ${gain}`)
      for (let attempt = 0; attempt < INITIAL_SYNTHETIC_CALIBRATION_POLICY.samplesPerCandidate; attempt++) {
        const pingSequence = ++this.pingSequence
        const frame = encodeFrame(context.controlSessionId, AcousticFrameType.CALIBRATION_PING, pingSequence, encodeCalibrationPing({ protocolVersion: 1, controlSessionId: context.controlSessionId, calibrationNonce: context.calibrationNonce, pingSequence, txAppGain: gain }))
        await this.options.transport.sendRobust(frame, gain)
        const report = await this.options.transport.waitForLevelReport(context, pingSequence, this.options.timeoutMs ?? 1500)
        measurements.push(report ? { gain, classification: report.classification, snrDb: report.snrDb, clippingFraction: report.clippingFraction, crcValid: report.crcValid } : { gain, classification: 'NOT_HEARD', snrDb: null, clippingFraction: 0, crcValid: false })
      }
    }
    const result = selectGain(measurements)
    if (result.selectedGain !== null) this.options.setCandidateGain(null)
    return result
  }

  private emit(state: AdaptiveHandshakeState, message: string): void { this.options.eventSink?.({ state, message }) }
}
