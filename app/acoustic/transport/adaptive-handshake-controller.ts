import { AcousticFrameType, encodeCalibrationPing, encodeFrame, type LevelReportPayload } from '../protocol/frame'
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
  private disposed = false
  private readonly pendingReports = new Map<number, { context: AdaptiveLinkContext; resolve: (report: LevelReportPayload | null) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly options: AdaptiveHandshakeControllerOptions) {}

  start(context: AdaptiveLinkContext): void {
    this.options.runtime.start(context.controlSessionId, context.calibrationNonce)
    this.emit('BOOTSTRAP_CONTROL_LINK', 'Connecting... Sending robust link probe')
  }

  async runGainSweep(context: AdaptiveLinkContext, direction: 'INITIATOR_TO_RESPONDER' | 'RESPONDER_TO_INITIATOR'): Promise<ReturnType<typeof selectGain>> {
    const measurements: GainMeasurement[] = []
    for (const gain of INITIAL_SYNTHETIC_CALIBRATION_POLICY.candidates) {
      if (this.disposed) return { selectedGain: null, measurements, reason: 'CONTROL_LINK_NOT_HEARD' }
      this.options.setCandidateGain(gain)
      this.emit(direction === 'INITIATOR_TO_RESPONDER' ? 'LOCAL_GAIN_SWEEP' : 'REMOTE_GAIN_SWEEP', `Testing ${direction === 'INITIATOR_TO_RESPONDER' ? 'local' : 'remote'} gain ${gain}`)
      for (let attempt = 0; attempt < INITIAL_SYNTHETIC_CALIBRATION_POLICY.samplesPerCandidate; attempt++) {
        const pingSequence = ++this.pingSequence
        const frame = encodeFrame(context.controlSessionId, AcousticFrameType.CALIBRATION_PING, pingSequence, encodeCalibrationPing({ protocolVersion: 1, controlSessionId: context.controlSessionId, calibrationNonce: context.calibrationNonce, pingSequence, txAppGain: gain }))
        const reportPromise = this.options.transport.waitForLevelReport(context, pingSequence, this.options.timeoutMs ?? 1500)
        await this.options.transport.sendRobust(frame, gain)
        const report = await reportPromise
        measurements.push(report ? { gain, classification: report.classification, snrDb: report.snrDb, clippingFraction: report.clippingFraction, crcValid: report.crcValid } : { gain, classification: 'NOT_HEARD', snrDb: null, clippingFraction: 0, crcValid: false })
      }
      const selection = selectGain(measurements)
      if (selection.selectedGain !== null) {
        this.options.setCandidateGain(null)
        return selection
      }
    }
    const result = selectGain(measurements)
    if (result.selectedGain !== null) this.options.setCandidateGain(null)
    return result
  }

  waitForLevelReport(context: AdaptiveLinkContext, pingSequence: number, timeoutMs: number): Promise<LevelReportPayload | null> {
    if (this.disposed) return Promise.resolve(null)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingReports.delete(pingSequence)
        resolve(null)
      }, timeoutMs)
      this.pendingReports.set(pingSequence, { context, resolve, timer })
    })
  }

  acceptLevelReport(context: AdaptiveLinkContext, report: LevelReportPayload): boolean {
    const pending = this.pendingReports.get(report.pingSequence)
    if (!pending || pending.context.controlSessionId !== context.controlSessionId || pending.context.calibrationNonce !== context.calibrationNonce || report.controlSessionId !== context.controlSessionId || report.calibrationNonce !== context.calibrationNonce) return false
    clearTimeout(pending.timer)
    this.pendingReports.delete(report.pingSequence)
    pending.resolve(report)
    return true
  }

  dispose(): void {
    this.disposed = true
    for (const pending of this.pendingReports.values()) {
      clearTimeout(pending.timer)
      pending.resolve(null)
    }
    this.pendingReports.clear()
  }

  private emit(state: AdaptiveHandshakeState, message: string): void { this.options.eventSink?.({ state, message }) }
}
