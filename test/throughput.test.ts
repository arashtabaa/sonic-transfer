import { describe, expect, it } from 'vitest'
import { applySyntheticChannel, benchmarkPayload, formatDuration, ModemProfileKey } from '../app/acoustic'

describe('deterministic throughput and synthetic channel diagnostics', () => {
  it('reports actual rendered waveform timing and derived rates', () => {
    const payload = new Uint8Array(1024)
    const result = benchmarkPayload(payload, ModemProfileKey.BALANCED, { extraBlocks: 2 })
    expect(result.payloadBytes).toBe(1024)
    expect(result.pcmSamples).toBeGreaterThan(0)
    expect(result.durationSeconds).toBe(result.pcmSamples / 48000)
    expect(result.rawBitrate).toBeCloseTo(4 * 1000 / 30)
    expect(result.usefulBitrate).toBeCloseTo(8192 / result.durationSeconds)
    expect(result.protocolFrames).toBe(result.fountainBlocks + 1)
    expect(formatDuration(result.durationSeconds)).toMatch(/\d+[ms]/)
  }, 30000)

  it('is deterministic for seeded noise, delay, echo, and dropout', () => {
    const source = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 11) * 0.2)
    const options = { pcm: source, sampleRate: 48000, seed: 42, impairment: { snrDb: 20, gain: 0.5, delaySamples: 12, clockDriftPpm: 100, frequencyOffsetHz: 25, echo: { delaySamples: 8, gain: 0.2 }, dropoutMs: 100, impulseCount: 3 } }
    const first = applySyntheticChannel(options)
    const second = applySyntheticChannel(options)
    expect(first).toEqual(second)
    expect(first.length).toBe(source.length + 12)
    expect(first.slice(Math.floor(first.length / 2), Math.floor(first.length / 2) + 10)).toEqual(new Float32Array(10))
  })
})
