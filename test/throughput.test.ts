import { describe, expect, it } from 'vitest'
import { applySyntheticChannel, benchmarkPayload, createBenchmarkPayload, formatDuration, ModemProfileKey } from '../app/acoustic'

describe('deterministic throughput and synthetic channel diagnostics', () => {
  it('reports actual rendered waveform timing and derived rates', () => {
    const payload = new Uint8Array(1024)
    const result = benchmarkPayload(payload, ModemProfileKey.BALANCED, { extraBlocks: 2 })
    expect(result.originalPayloadBytes).toBe(1024)
    expect(result.pcmSamples).toBeGreaterThan(0)
    expect(result.durationSeconds).toBe(result.pcmSamples / 48000)
    expect(result.rawPhyBitrate).toBeCloseTo(4 * 1000 / 30)
    expect(result.sourceUsefulBitrate).toBeCloseTo(8192 / result.durationSeconds)
    expect(result.protocolFrames).toBe(result.transmittedFountainBlocks + 1)
    expect(formatDuration(result.durationSeconds)).toMatch(/\d+[ms]/)
  }, 30000)

  it('is deterministic for seeded noise, delay, echo, and dropout', () => {
    const source = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 11) * 0.2)
    const options = { pcm: source, sampleRate: 48000, seed: 42, impairment: { snrDb: 20, gain: 0.5, delaySamples: 12, clockDriftPpm: 100, dopplerPpm: 25, echo: { delaySamples: 8, gain: 0.2 }, dropoutMs: 100, impulseCount: 3 } }
    const first = applySyntheticChannel(options)
    const second = applySyntheticChannel(options)
    expect(first).toEqual(second)
    expect(first.length).toBe(source.length + 12)
    expect(first.slice(Math.floor(first.length / 2), Math.floor(first.length / 2) + 10)).toEqual(new Float32Array(10))
  })

  it('provides distinct deterministic entropy classes', () => {
    const repetitive = createBenchmarkPayload(1024, 'REPETITIVE')
    const structured = createBenchmarkPayload(1024, 'STRUCTURED')
    const randomLike = createBenchmarkPayload(1024, 'INCOMPRESSIBLE')
    const compressedLike = createBenchmarkPayload(1024, 'ALREADY_COMPRESSED_LIKE')
    expect(new Set([repetitive, structured, randomLike, compressedLike].map(bytes => Array.from(bytes).join(','))).size).toBe(4)
    expect(createBenchmarkPayload(1024, 'INCOMPRESSIBLE')).toEqual(randomLike)
  })
})
