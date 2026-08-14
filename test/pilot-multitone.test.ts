import { describe, expect, it } from 'vitest'
import { AcousticFrameType, applySyntheticChannel, encodeFrame, getPilotMultitoneConfig, PilotMultitoneModem, PilotMultitoneStreamDecoder } from '../app/acoustic'

describe('pilot-assisted constant-power multitone V2', () => {
  it('round-trips a frame with periodic pilots across arbitrary chunks', () => {
    const config = getPilotMultitoneConfig(48000, 16)
    const packet = encodeFrame(0x534f4e49, AcousticFrameType.DATA, 3, new Uint8Array([1, 2, 3, 4, 5]))
    const pcm = new PilotMultitoneModem(config).encode(packet).samples
    const decoder = new PilotMultitoneStreamDecoder(new PilotMultitoneModem(config))
    const frames = []
    for (let i = 0; i < pcm.length; i += 137) frames.push(...decoder.pushSamples(pcm.slice(i, i + 137)))
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0]!.payload)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps the peak below the configured gain without clipping', () => {
    const config = getPilotMultitoneConfig(48000, 8)
    const samples = new PilotMultitoneModem(config).encode(new Uint8Array([0xff, 0x00, 0xa5])).samples
    expect(Math.max(...Array.from(samples).map(Math.abs))).toBeLessThanOrEqual(config.gain)
  })

  it('reports deterministic V2 impairment outcomes without hiding failures', () => {
    const config = getPilotMultitoneConfig()
    const packet = encodeFrame(0x534f4e49, AcousticFrameType.DATA, 9, new Uint8Array(32).fill(0xa5))
    const pcm = new PilotMultitoneModem(config).encode(packet).samples
    const cases: Record<string, Float32Array> = {
      clean: pcm,
      snr30: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 30, impairment: { snrDb: 30 } }),
      snr25: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 25, impairment: { snrDb: 25 } }),
      snr20: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 20, impairment: { snrDb: 20 } }),
      snr15: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 15, impairment: { snrDb: 15 } }),
      clockPlus100: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 101, impairment: { clockDriftPpm: 100 } }),
      clockMinus100: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 102, impairment: { clockDriftPpm: -100 } }),
      echo: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 104, impairment: { echo: { delaySamples: 96, gain: 0.25 } } }),
      dropout100: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 105, impairment: { dropoutMs: 100 } }),
      dropout250: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 106, impairment: { dropoutMs: 250 } }),
      dropout500: applySyntheticChannel({ pcm, sampleRate: 48000, seed: 107, impairment: { dropoutMs: 500 } }),
    }
    const results: Record<string, number> = {}
    const decode = (signal: Float32Array, rxConfig = config) => new PilotMultitoneStreamDecoder(new PilotMultitoneModem(rxConfig)).pushSamples(signal).length
    for (const [name, signal] of Object.entries(cases)) {
      results[name] = decode(signal)
    }
    for (const [name, offset] of [['detunePlus10', 10], ['detuneMinus10', -10], ['detunePlus25', 25], ['detuneMinus25', -25]] as const) {
      const rxConfig = { ...config, startFreq: config.startFreq + offset, endFreq: config.endFreq + offset }
      results[name] = decode(pcm, rxConfig)
    }
    console.log('PILOT_MULTITONE_V2_IMPAIRMENTS', JSON.stringify(results))
    expect(results.clean).toBe(1)
  })

  it('decodes TX 48 kHz audio with an RX-local 44.1 kHz configuration', () => {
    const txConfig = getPilotMultitoneConfig(48000)
    const packet = encodeFrame(0x534f4e49, AcousticFrameType.DATA, 10, new Uint8Array([9, 8, 7, 6]))
    const tx = new PilotMultitoneModem(txConfig).encode(packet).samples
    const rx = new PilotMultitoneStreamDecoder(new PilotMultitoneModem(getPilotMultitoneConfig(44100)))
    const resampled = new Float32Array(Math.round(tx.length * 44100 / 48000))
    for (let i = 0; i < resampled.length; i++) { const source = i * 48000 / 44100; const left = Math.floor(source); const fraction = source - left; resampled[i] = (tx[left] || 0) * (1 - fraction) + (tx[Math.min(left + 1, tx.length - 1)] || 0) * fraction }
    expect(rx.pushSamples(resampled).map(frame => frame.sequence)).toEqual([10])
  })

})
