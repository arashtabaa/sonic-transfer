import { describe, expect, it } from 'vitest'
import {
  AcousticFrameType,
  AdaptiveHandshakeController,
  AdaptiveHandshakeRuntime,
  BFSKAcousticModem,
  BFSKStreamDecoder,
  HALF_DUPLEX_TIMING,
  ModemProfileKey,
  classifyLevel,
  decodeCalibrationCommand,
  decodeCalibrationPing,
  decodeLevelReport,
  encodeCalibrationCommand,
  encodeFrame,
  encodeLevelReport,
  getProfileConfig,
  selectGain,
  type AdaptiveLinkContext,
  type GainMeasurement,
} from '../app/acoustic'

function resample(pcm: Float32Array, sourceRate: number, destinationRate: number): Float32Array {
  const output = new Float32Array(Math.round(pcm.length * destinationRate / sourceRate))
  for (let i = 0; i < output.length; i++) {
    const source = i * sourceRate / destinationRate
    const left = Math.floor(source)
    const fraction = source - left
    output[i] = (pcm[left] || 0) * (1 - fraction) + (pcm[Math.min(left + 1, pcm.length - 1)] || 0) * fraction
  }
  return output
}

class FakeClock {
  now = 0
  events: Array<{ name: string; at: number }> = []
  mark(name: string) { this.events.push({ name, at: this.now }) }
}

class Device {
  readonly tx: BFSKAcousticModem
  readonly rx: BFSKStreamDecoder
  readonly runtime: AdaptiveHandshakeRuntime
  readonly context: AdaptiveLinkContext
  readonly evidence: GainMeasurement[] = []
  controller!: AdaptiveHandshakeController
  peer!: Device
  dropNextReport = false
  selectedGain: number | null = null
  private readonly baseGain: number

  constructor(readonly name: 'A' | 'B', readonly sampleRate: number, readonly attenuation: number, private readonly clock: FakeClock) {
    const config = getProfileConfig(ModemProfileKey.ROBUST, sampleRate)
    this.tx = new BFSKAcousticModem(config)
    this.rx = new BFSKStreamDecoder(new BFSKAcousticModem({ ...config, sampleRate }))
    this.baseGain = config.gain
    this.runtime = new AdaptiveHandshakeRuntime(() => clock.now)
    this.context = { controlSessionId: 0x12345678, calibrationNonce: 0x55667788, role: name === 'A' ? 'INITIATOR' : 'RESPONDER', startedAt: 0 }
  }

  setup() {
    this.controller = new AdaptiveHandshakeController({
      runtime: this.runtime,
      transport: {
        sendRobust: async (frame, gain) => this.send(frame, gain),
        waitForLevelReport: (context, sequence, timeoutMs) => this.controller.waitForLevelReport(context, sequence, timeoutMs),
      },
      setCandidateGain: () => {},
      eventSink: () => {},
      timeoutMs: 10,
    })
    this.controller.start(this.context)
  }

  async send(frame: Uint8Array, gain: number) {
    this.clock.now += 20
    if (frame[9] === AcousticFrameType.CALIBRATION_PING && this.name === 'A') this.clock.mark('A_PING_TX_END')
    const encoded = this.tx.encode(frame).samples
    const scaled = encoded.map(sample => sample * (gain / this.baseGain) * this.attenuation)
    if (this.name === 'A' && frame[9] === AcousticFrameType.CALIBRATION_PING) {
      this.clock.now += HALF_DUPLEX_TIMING.TX_TO_RX_GUARD_MS
      this.clock.mark('A_RX_READY')
    }
    await this.peer.receive(resample(scaled, this.sampleRate, this.peer.sampleRate))
  }

  async receive(pcm: Float32Array) {
    const frames = this.rx.pushSamples(pcm)
    const observations = this.rx.takeObservations()
    for (const frame of frames) await this.handle(frame, observations.find(observation => observation.frame === frame)?.pcm)
  }

  private async handle(frame: { sessionId: number; frameType: AcousticFrameType; sequence: number; payload: Uint8Array }, pcm?: Float32Array) {
    if (frame.frameType === AcousticFrameType.LINK_PROBE) {
      await this.send(encodeFrame(this.context.controlSessionId, AcousticFrameType.LINK_ACK, 1, new TextEncoder().encode('{}')), 0.3)
      return
    }
    if (frame.frameType === AcousticFrameType.LINK_ACK && this.name === 'A') {
      this.runtime.recordControlLink(true)
      await runInitiatorSweep(this)
      return
    }
    if (frame.frameType === AcousticFrameType.CALIBRATION_COMMAND) {
      const command = decodeCalibrationCommand(frame.payload)
      if (!command) throw new Error(`${this.name}: invalid calibration command`)
      if (command.phase === 'START_GAIN_SWEEP') {
        this.evidence.length = 0
        this.runtime.recordControlLink(true)
      } else if (command.phase === 'LOCK_GAIN') {
        const verified = selectGain(this.evidence)
        expect(verified.selectedGain).toBe(command.lockedGain)
        if (command.direction === 'INITIATOR_TO_RESPONDER') this.runtime.lockLocalGain(this.evidence)
        else this.runtime.lockRemoteGain(this.evidence)
      } else if (command.phase === 'SWITCH_DIRECTION') {
        this.runtime.beginRemoteGain()
        await runResponderSweep(this)
      }
      return
    }
    if (frame.frameType === AcousticFrameType.CALIBRATION_PING) {
      const ping = decodeCalibrationPing(frame.payload)
      if (!ping) throw new Error(`${this.name}: invalid ping`)
      if (this.name === 'B') this.clock.mark('B_PING_DECODED')
      const samples = pcm || new Float32Array()
      let sumSquares = 0
      let peak = 0
      let clipped = 0
      for (const sample of samples) {
        sumSquares += sample * sample
        peak = Math.max(peak, Math.abs(sample))
        if (Math.abs(sample) >= 0.98) clipped++
      }
      const signalRms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0
      const clippingFraction = samples.length ? clipped / samples.length : 0
      const classification = classifyLevel(signalRms, null, clippingFraction, true)
      this.evidence.push({ gain: ping.txAppGain, classification, signalRms, snrDb: null, clippingFraction, crcValid: true })
      if (this.name === 'B' && this.dropNextReport) {
        this.dropNextReport = false
        return
      }
      if (this.name === 'B') this.clock.now += HALF_DUPLEX_TIMING.ADAPTIVE_RESPONSE_MARGIN_MS
      const report = encodeFrame(ping.controlSessionId, AcousticFrameType.LEVEL_REPORT, ping.pingSequence, encodeLevelReport({ protocolVersion: 1, controlSessionId: ping.controlSessionId, calibrationNonce: ping.calibrationNonce, pingSequence: ping.pingSequence, signalPeak: peak, signalRms, noiseRms: null, snrDb: null, clippingFraction, crcValid: true, classification }))
      if (this.name === 'B') {
        this.clock.mark('B_REPORT_TX_START')
        this.clock.now += 20
        this.clock.mark('B_REPORT_TX_END')
        this.clock.now += HALF_DUPLEX_TIMING.TX_TO_RX_GUARD_MS
        this.clock.mark('B_RX_READY')
      }
      await this.send(report, 0.3)
      return
    }
    if (frame.frameType === AcousticFrameType.LEVEL_REPORT) {
      const report = decodeLevelReport(frame.payload)
      if (!report) throw new Error(`${this.name}: invalid report`)
      this.controller.acceptLevelReport(this.context, report)
      if (this.name === 'A') this.clock.mark('A_REPORT_DECODED')
    }
  }
}

async function runInitiatorSweep(device: Device) {
  const start = encodeFrame(device.context.controlSessionId, AcousticFrameType.CALIBRATION_COMMAND, 1, encodeCalibrationCommand({ protocolVersion: 1, controlSessionId: device.context.controlSessionId, calibrationNonce: device.context.calibrationNonce, phase: 'START_GAIN_SWEEP', direction: 'INITIATOR_TO_RESPONDER', sequence: 1 }))
  await device.send(start, 0.3)
  const result = await device.controller.runGainSweep(device.context, 'INITIATOR_TO_RESPONDER')
  expect(result.selectedGain).not.toBeNull()
  device.selectedGain = result.selectedGain
  device.runtime.lockLocalGain(result.measurements)
  const lock = encodeFrame(device.context.controlSessionId, AcousticFrameType.CALIBRATION_COMMAND, 2, encodeCalibrationCommand({ protocolVersion: 1, controlSessionId: device.context.controlSessionId, calibrationNonce: device.context.calibrationNonce, phase: 'LOCK_GAIN', direction: 'INITIATOR_TO_RESPONDER', sequence: 2, lockedGain: result.selectedGain }))
  await device.send(lock, 0.3)
  device.runtime.beginRemoteGain()
  const switchFrame = encodeFrame(device.context.controlSessionId, AcousticFrameType.CALIBRATION_COMMAND, 3, encodeCalibrationCommand({ protocolVersion: 1, controlSessionId: device.context.controlSessionId, calibrationNonce: device.context.calibrationNonce, phase: 'SWITCH_DIRECTION', direction: 'RESPONDER_TO_INITIATOR', sequence: 3 }))
  await device.send(switchFrame, 0.3)
}

async function runResponderSweep(device: Device) {
  const result = await device.controller.runGainSweep(device.context, 'RESPONDER_TO_INITIATOR')
  expect(result.selectedGain).not.toBeNull()
  device.selectedGain = result.selectedGain
  const lock = encodeFrame(device.context.controlSessionId, AcousticFrameType.CALIBRATION_COMMAND, 4, encodeCalibrationCommand({ protocolVersion: 1, controlSessionId: device.context.controlSessionId, calibrationNonce: device.context.calibrationNonce, phase: 'LOCK_GAIN', direction: 'RESPONDER_TO_INITIATOR', sequence: 4, lockedGain: result.selectedGain }))
  await device.send(lock, 0.3)
  device.runtime.lockRemoteGain(result.measurements)
}

describe('adaptive gain two-device PCM harness', () => {
  it('completes asymmetric cross-rate gain negotiation through robust PCM', async () => {
    const clock = new FakeClock()
    const a = new Device('A', 48000, 0.15, clock)
    const b = new Device('B', 44100, 0.9, clock)
    a.peer = b; b.peer = a; a.setup(); b.setup()
    await a.send(encodeFrame(a.context.controlSessionId, AcousticFrameType.LINK_PROBE, 1, new TextEncoder().encode('{}')), 0.3)
    expect(a.runtime.events.map(event => event.state)).toEqual(['BOOTSTRAP_CONTROL_LINK', 'LOCAL_GAIN_SWEEP', 'LOCAL_GAIN_LOCKED', 'REMOTE_GAIN_SWEEP', 'REMOTE_GAIN_LOCKED'])
    expect(b.runtime.events.map(event => event.state)).toEqual(['BOOTSTRAP_CONTROL_LINK', 'LOCAL_GAIN_SWEEP', 'LOCAL_GAIN_LOCKED', 'REMOTE_GAIN_SWEEP', 'REMOTE_GAIN_LOCKED'])
    expect(a.selectedGain).not.toBe(b.selectedGain)
    expect(a.evidence.every(measurement => measurement.signalRms > 0 && measurement.snrDb === null)).toBe(true)
    expect(b.evidence.every(measurement => measurement.signalRms > 0 && measurement.snrDb === null)).toBe(true)
    expect(a.evidence.every(measurement => measurement.clippingFraction <= 0.01)).toBe(true)
    expect(b.evidence.every(measurement => measurement.clippingFraction <= 0.01)).toBe(true)
    expect(a.runtime.state).toBe('REMOTE_GAIN_LOCKED')
    expect(b.runtime.state).toBe('REMOTE_GAIN_LOCKED')
    const names = clock.events.map(event => event.name)
    expect(names.indexOf('A_PING_TX_END')).toBeLessThan(names.indexOf('A_RX_READY'))
    expect(names.indexOf('A_RX_READY')).toBeLessThan(names.indexOf('B_PING_DECODED'))
    expect(names.indexOf('B_PING_DECODED')).toBeLessThan(names.indexOf('B_REPORT_TX_START'))
    expect(names.indexOf('B_REPORT_TX_START')).toBeLessThan(names.indexOf('B_REPORT_TX_END'))
    expect(names.indexOf('B_REPORT_TX_END')).toBeLessThan(names.indexOf('B_RX_READY'))
    expect(names.indexOf('B_RX_READY')).toBeLessThan(names.indexOf('A_REPORT_DECODED'))
    const ready = clock.events.find(event => event.name === 'A_RX_READY')!.at
    const response = clock.events.find(event => event.name === 'B_REPORT_TX_START')!.at
    expect(response).toBeGreaterThanOrEqual(ready + HALF_DUPLEX_TIMING.ADAPTIVE_RESPONSE_MARGIN_MS)
  }, 120000)

  it('records one lost PCM report as NOT_HEARD and still completes', async () => {
    const clock = new FakeClock()
    const a = new Device('A', 48000, 0.55, clock)
    const b = new Device('B', 44100, 0.9, clock)
    a.peer = b; b.peer = a; a.setup(); b.setup(); b.dropNextReport = true
    await a.send(encodeFrame(a.context.controlSessionId, AcousticFrameType.LINK_PROBE, 1, new TextEncoder().encode('{}')), 0.3)
    expect(a.runtime.state).toBe('REMOTE_GAIN_LOCKED')
    expect(b.runtime.state).toBe('REMOTE_GAIN_LOCKED')
  }, 120000)
})
