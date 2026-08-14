import { describe, expect, it } from 'vitest'
import { AcousticFrameType, encodeFrame, PilotMultitoneModem, PilotMultitoneStreamDecoder } from '../app/acoustic'

describe('pilot-assisted constant-power multitone V2', () => {
  it('round-trips a frame with periodic pilots across arbitrary chunks', () => {
    const config = { sampleRate: 48000, startFreq: 6000, endFreq: 18000, carrierCount: 16 as const, symbolDurationMs: 5 as const, guardMs: 1, gain: 0.7, pilotInterval: 16 as const }
    const packet = encodeFrame(0x534f4e49, AcousticFrameType.DATA, 3, new Uint8Array([1, 2, 3, 4, 5]))
    const pcm = new PilotMultitoneModem(config).encode(packet).samples
    const decoder = new PilotMultitoneStreamDecoder(new PilotMultitoneModem(config))
    const frames = []
    for (let i = 0; i < pcm.length; i += 137) frames.push(...decoder.pushSamples(pcm.slice(i, i + 137)))
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0]!.payload)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps the peak below the configured gain without clipping', () => {
    const config = { sampleRate: 48000, startFreq: 6000, endFreq: 18000, carrierCount: 16 as const, symbolDurationMs: 5 as const, guardMs: 1, gain: 0.7, pilotInterval: 8 as const }
    const samples = new PilotMultitoneModem(config).encode(new Uint8Array([0xff, 0x00, 0xa5])).samples
    expect(Math.max(...Array.from(samples).map(Math.abs))).toBeLessThanOrEqual(config.gain)
  })
})
