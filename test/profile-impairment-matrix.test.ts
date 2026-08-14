import { describe, expect, it } from 'vitest'
import { applySyntheticChannel, BFSKAcousticModem, BFSKStreamDecoder, getProfileConfig, ModemProfileKey, SonicWaveformRenderer } from '../app/acoustic'

describe('production profile synthetic impairment matrix', () => {
  it('records actual DATA frame detection under deterministic channel cases', () => {
    const payload = Uint8Array.from({ length: 256 }, (_, i) => (i * 31 + 7) & 0xff)
    const cases = [
      ['clean', {}],
      ['snr20', { snrDb: 20 }],
      ['clock+100ppm', { clockDriftPpm: 100 }],
      ['doppler+25ppm', { dopplerPpm: 25 }],
      ['echo', { echo: { delaySamples: 240, gain: 0.25 } }],
      ['dropout100ms', { dropoutMs: 100 }],
      ['dropout250ms', { dropoutMs: 250 }],
      ['dropout500ms', { dropoutMs: 500 }],
    ] as const
    const summary: Record<string, Record<string, { sent: number; detected: number; crcValid: number; crcInvalid: number }>> = {}
    for (const profile of [ModemProfileKey.ROBUST, ModemProfileKey.BALANCED, ModemProfileKey.TURBO]) {
      summary[profile] = {}
      const rendered = SonicWaveformRenderer.renderPayloadToPcm(payload, 'probe.bin', 'application/octet-stream', profile, 48000, 100, 2)
      for (const [name, impairment] of cases) {
        const channel = applySyntheticChannel({ pcm: rendered.pcm, sampleRate: 48000, seed: 1234, impairment })
        const decoder = new BFSKStreamDecoder(new BFSKAcousticModem(getProfileConfig(profile, 48000)))
        let detected = 0
        for (let offset = 0; offset < channel.length; offset += 2048) detected += decoder.pushSamples(channel.subarray(offset, Math.min(offset + 2048, channel.length))).length
        const stats = decoder.getStats()
        summary[profile]![name] = { sent: rendered.totalFrames, detected, crcValid: stats.crcValid, crcInvalid: stats.crcRejected }
      }
    }
    console.info('PROFILE_IMPAIRMENT_MATRIX', JSON.stringify(summary))
    expect(Object.values(summary).every(profile => profile.clean!.crcValid > 0)).toBe(true)
  }, 60000)
})
