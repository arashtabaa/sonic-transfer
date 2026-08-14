import type { CalibrationDirection, LevelClassification, LevelReportPayload } from '../protocol/frame'
import type { PilotMultitoneConfig } from '../modulation/pilot-multitone-modem'

export type AdaptiveHandshakeState = 'IDLE' | 'BOOTSTRAP_CONTROL_LINK' | 'LOCAL_GAIN_SWEEP' | 'LOCAL_GAIN_LOCKED' | 'REMOTE_GAIN_SWEEP' | 'REMOTE_GAIN_LOCKED' | 'FREQUENCY_SCAN' | 'BAND_SELECTED' | 'PROFILE_NEGOTIATING' | 'PROFILE_VERIFYING' | 'READY' | 'FAILED' | 'ABORTED'
export interface AdaptiveLinkContext { controlSessionId: number; calibrationNonce: number; role: 'INITIATOR' | 'RESPONDER'; startedAt: number }
export type HandshakeFailure = 'CONTROL_LINK_NOT_HEARD' | 'SIGNAL_TOO_WEAK_AT_MAX_APP_GAIN' | 'FAST_UNAVAILABLE' | 'PROFILE_VERIFICATION_FAILED'

export interface GainMeasurement { gain: number; classification: LevelClassification; snrDb: number | null; clippingFraction: number; crcValid: boolean }
export interface GainPolicy { minAppGain: number; maxAppGain: number; candidates: number[]; requiredValidRatio: number; minimumSnrDb: number; maxClippingFraction: number; samplesPerCandidate: number }
export interface GainSelection { selectedGain: number | null; measurements: GainMeasurement[]; reason?: HandshakeFailure }
export interface FrequencyMeasurement { frequencyHz: number; signalRms: number; noiseRms: number | null; snrDb: number | null; peak: number; usable: boolean; clipped: boolean }
export interface SelectedBand { selectedStartFreq: number; selectedEndFreq: number; selectedCarrierCount: number; evidence: FrequencyMeasurement[] }
export interface AdaptiveHandshakeResult { controlSessionId: number; calibrationNonce: number; localTxGain: number; remoteTxGain: number; selectedDataProfile: string; modulationId: string; startFreq: number; endFreq: number; carrierCount: number; pilotInterval: number; txSampleRate: number; rxSampleRate: number; configFingerprint: string; verificationClass: 'READY'; createdAt: number }
export interface HandshakeEvent { atMs: number; state: AdaptiveHandshakeState; message: string; evidence?: Record<string, unknown> }

export const INITIAL_SYNTHETIC_CALIBRATION_POLICY: Readonly<GainPolicy> = Object.freeze({ minAppGain: 0.12, maxAppGain: 0.85, candidates: [0.12, 0.18, 0.26, 0.34, 0.46, 0.60, 0.74, 0.85], requiredValidRatio: 0.8, minimumSnrDb: 8, maxClippingFraction: 0.01, samplesPerCandidate: 3 })

export function createAdaptivePilotConfig(sampleRate: number, band: Pick<SelectedBand, 'selectedStartFreq' | 'selectedEndFreq' | 'selectedCarrierCount'>, options: { pilotInterval?: 8 | 16 | 32; symbolDurationMs?: 5 | 10 | 15; guardMs?: number; gain?: number } = {}): PilotMultitoneConfig {
  if (band.selectedStartFreq >= band.selectedEndFreq || band.selectedEndFreq > sampleRate / 2 - 1500) throw new Error('band violates Nyquist guard')
  if (![4, 8, 12, 16].includes(band.selectedCarrierCount)) throw new Error('unsupported carrier count')
  return { profileKey: 'fast_data_experimental' as PilotMultitoneConfig['profileKey'], modulationId: 'PILOT_MULTITONE_V2', sampleRate, startFreq: band.selectedStartFreq, endFreq: band.selectedEndFreq, carrierCount: band.selectedCarrierCount as PilotMultitoneConfig['carrierCount'], pilotInterval: options.pilotInterval ?? 16, symbolDurationMs: options.symbolDurationMs ?? 5, guardMs: options.guardMs ?? 1, gain: options.gain ?? 0.26 }
}

export function fingerprintAdaptiveConfig(config: PilotMultitoneConfig): string {
  return JSON.stringify({ protocolVersion: 1, modulationId: config.modulationId, startFreq: config.startFreq, endFreq: config.endFreq, carrierCount: config.carrierCount, pilotInterval: config.pilotInterval, symbolDurationMs: config.symbolDurationMs, guardMs: config.guardMs, gain: config.gain, sampleRate: config.sampleRate })
}

export function classifyLevel(signalRms: number, noiseRms: number | null, clippingFraction: number, crcValid: boolean): LevelClassification {
  if (!crcValid && signalRms <= 1e-6) return 'NOT_HEARD'
  if (clippingFraction > 0.01) return 'TOO_LOUD'
  if (!crcValid) return 'UNUSABLE'
  if (noiseRms === null || signalRms <= 1e-6) return 'TOO_WEAK'
  const snr = 20 * Math.log10(signalRms / Math.max(noiseRms, 1e-9))
  return snr >= 8 ? 'GOOD' : 'TOO_WEAK'
}

export function selectGain(measurements: GainMeasurement[], policy: GainPolicy = INITIAL_SYNTHETIC_CALIBRATION_POLICY): GainSelection {
  const byGain = new Map<number, GainMeasurement[]>()
  for (const measurement of measurements) {
    if (!policy.candidates.includes(measurement.gain)) continue
    const group = byGain.get(measurement.gain) || []
    group.push(measurement)
    byGain.set(measurement.gain, group)
  }
  for (const gain of [...policy.candidates].sort((a, b) => a - b)) {
    const group = byGain.get(gain) || []
    if (group.length < policy.samplesPerCandidate) continue
    const valid = group.filter(m => m.crcValid && m.classification === 'GOOD' && m.clippingFraction <= policy.maxClippingFraction)
    const snrs = valid.map(m => m.snrDb).filter((v): v is number => v !== null)
    if (valid.length / group.length >= policy.requiredValidRatio && snrs.length > 0 && Math.min(...snrs) >= policy.minimumSnrDb) return { selectedGain: gain, measurements }
  }
  return { selectedGain: null, measurements, reason: 'SIGNAL_TOO_WEAK_AT_MAX_APP_GAIN' }
}

export function selectFrequencyBand(measurements: FrequencyMeasurement[], sampleRate: number, carrierCount = 8): SelectedBand | null {
  if (![4, 8, 12, 16].includes(carrierCount)) return null
  const safe = measurements.filter(m => m.frequencyHz <= sampleRate / 2 - 1500 && m.usable && !m.clipped).sort((a, b) => a.frequencyHz - b.frequencyHz)
  if (safe.length < carrierCount) return null
  let best: FrequencyMeasurement[] = []
  let current: FrequencyMeasurement[] = []
  for (const measurement of safe) {
    const previous = current[current.length - 1]
    if (previous && measurement.frequencyHz - previous.frequencyHz > 2500) current = []
    current.push(measurement)
    if (current.length >= carrierCount && scoreBand(current) > scoreBand(best)) best = current.slice()
  }
  if (best.length < carrierCount) return null
  const chosen = best.slice(0, carrierCount)
  return { selectedStartFreq: chosen[0]!.frequencyHz, selectedEndFreq: chosen[chosen.length - 1]!.frequencyHz, selectedCarrierCount: chosen.length, evidence: chosen }
}

function scoreBand(band: FrequencyMeasurement[]): number {
  if (!band.length) return -Infinity
  const snr = band.map(m => m.snrDb ?? -Infinity).sort((a, b) => a - b)
  return (snr[Math.floor(snr.length / 2)] || -Infinity) * 10 + (band[band.length - 1]!.frequencyHz - band[0]!.frequencyHz) * 0.001
}

export class AdaptiveHandshakeRuntime {
  private _state: AdaptiveHandshakeState = 'IDLE'
  private readonly _events: HandshakeEvent[] = []
  private _result: AdaptiveHandshakeResult | null = null
  constructor(private readonly now: () => number = () => Date.now()) {}
  get state(): AdaptiveHandshakeState { return this._state }
  get events(): readonly HandshakeEvent[] { return this._events }
  get result(): AdaptiveHandshakeResult | null { return this._result }
  start(controlSessionId: number, calibrationNonce: number): void { this._result = null; this.transition('BOOTSTRAP_CONTROL_LINK', 'Sending robust acoustic link ping', { controlSessionId, calibrationNonce }) }
  recordControlLink(heard: boolean): void { if (this._state !== 'BOOTSTRAP_CONTROL_LINK') return; if (heard) this.transition('LOCAL_GAIN_SWEEP', 'Control link heard; beginning local application-gain sweep'); else this.fail('CONTROL_LINK_NOT_HEARD') }
  lockLocalGain(measurements: GainMeasurement[]): GainSelection { const selection = selectGain(measurements); if (selection.selectedGain === null) this.fail(selection.reason!); else this.transition('LOCAL_GAIN_LOCKED', `Local acoustic output gain locked at ${selection.selectedGain}`, { gain: selection.selectedGain }); return selection }
  beginRemoteGain(): void { if (this._state === 'LOCAL_GAIN_LOCKED') this.transition('REMOTE_GAIN_SWEEP', 'Switching direction for remote gain sweep') }
  lockRemoteGain(measurements: GainMeasurement[]): GainSelection { const selection = selectGain(measurements); if (selection.selectedGain === null) this.fail(selection.reason!); else this.transition('REMOTE_GAIN_LOCKED', `Remote acoustic output gain locked at ${selection.selectedGain}`, { gain: selection.selectedGain }); return selection }
  selectBand(measurements: FrequencyMeasurement[], sampleRate: number, carrierCount = 8): SelectedBand | null { if (!['REMOTE_GAIN_LOCKED', 'FREQUENCY_SCAN'].includes(this._state)) return null; const band = selectFrequencyBand(measurements, sampleRate, carrierCount); if (!band) { this.fail('FAST_UNAVAILABLE'); return null }; this.transition('BAND_SELECTED', `Selected DATA band ${band.selectedStartFreq}-${band.selectedEndFreq} Hz`, { selectedCarrierCount: band.selectedCarrierCount }); return band }
  beginProfileVerification(): void { if (this._state === 'BAND_SELECTED') this.transition('PROFILE_NEGOTIATING', 'Proposing exact measured FAST V2 profile') }
  profileAccepted(): void { if (this._state === 'PROFILE_NEGOTIATING') this.transition('PROFILE_VERIFYING', 'Running actual V2 profile probes') }
  complete(result: AdaptiveHandshakeResult): void { if (this._state === 'PROFILE_VERIFYING') { this._result = Object.freeze({ ...result, verificationClass: 'READY' }); this.transition('READY', 'LINK VERIFIED — READY TO SEND') } }
  fail(reason: HandshakeFailure): void { this._result = null; this.transition('FAILED', reason) }
  abort(): void { this._result = null; this.transition('ABORTED', 'Adaptive link aborted') }
  private transition(state: AdaptiveHandshakeState, message: string, evidence?: Record<string, unknown>): void { this._state = state; this._events.push({ atMs: this.now(), state, message, evidence }) }
}
