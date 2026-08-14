import { describe, expect, it } from 'vitest'
import { applySyntheticChannel, AcousticFrameType, encodeFrame, getFastDataConfig, ParallelMultitoneModem, ParallelMultitoneStreamDecoder } from '../app/acoustic'

describe('FAST_DATA_EXPERIMENTAL impairment probes', () => {
  it('records clean/noise/clock/detuning cases without claiming physical support', () => {
    const base = getFastDataConfig()
    const packet = encodeFrame(42, AcousticFrameType.DATA, 1, Uint8Array.from({ length: 64 }, (_, i) => i))
    const cases: Record<string, Float32Array> = {
      clean: new ParallelMultitoneModem(base).encode(packet).samples,
      snr20: applySyntheticChannel({ pcm: new ParallelMultitoneModem(base).encode(packet).samples, sampleRate: 48000, seed: 1, impairment: { snrDb: 20 } }),
      snr15: applySyntheticChannel({ pcm: new ParallelMultitoneModem(base).encode(packet).samples, sampleRate: 48000, seed: 2, impairment: { snrDb: 15 } }),
      clockPlus100: applySyntheticChannel({ pcm: new ParallelMultitoneModem(base).encode(packet).samples, sampleRate: 48000, seed: 3, impairment: { clockDriftPpm: 100 } }),
      clockMinus100: applySyntheticChannel({ pcm: new ParallelMultitoneModem(base).encode(packet).samples, sampleRate: 48000, seed: 4, impairment: { clockDriftPpm: -100 } }),
      detunePlus10Hz: new ParallelMultitoneModem({ ...base, startFreq: base.startFreq + 10, endFreq: base.endFreq + 10 }).encode(packet).samples,
      detuneMinus10Hz: new ParallelMultitoneModem({ ...base, startFreq: base.startFreq - 10, endFreq: base.endFreq - 10 }).encode(packet).samples,
    }
    const results: Record<string, number> = {}
    for (const [name, pcm] of Object.entries(cases)) results[name] = new ParallelMultitoneStreamDecoder(base).pushSamples(pcm).length
    console.info('FAST_MULTITONE_IMPAIRMENTS', JSON.stringify(results))
    expect(results.clean).toBe(1)
  })
})
