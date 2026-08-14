import { describe, expect, it } from 'vitest'
import {
  AcousticFrameType,
  BFSKAcousticModem,
  BFSKStreamDecoder,
  encodeFrame,
  getProfileConfig,
  ModemProfileKey,
} from '../app/acoustic'

function makeAudio(payload: Uint8Array, sessionId = 42, sequence = 1): Float32Array {
  const modem = new BFSKAcousticModem(getProfileConfig(ModemProfileKey.ROBUST, 48000))
  return modem.encode(encodeFrame(sessionId, AcousticFrameType.DATA, sequence, payload)).samples
}

function decodeInChunks(audio: Float32Array, sizes: number[]) {
  const modem = new BFSKAcousticModem(getProfileConfig(ModemProfileKey.ROBUST, 48000))
  const decoder = new BFSKStreamDecoder(modem)
  const result = []
  let offset = 0
  let i = 0
  while (offset < audio.length) {
    const size = sizes[i++ % sizes.length]!
    result.push(...decoder.pushSamples(audio.subarray(offset, Math.min(offset + size, audio.length))))
    offset += size
  }
  return result
}

describe('BFSK persistent stream receiver', () => {
  it('recovers one frame independent of callback chunking', () => {
    const audio = makeAudio(new Uint8Array([1, 2, 3, 4]))
    const expected = decodeInChunks(audio, [audio.length])
    for (const sizes of [[257], [1024], [2048], [4096], [4800], [137, 911, 257, 4096, 73, 4800]]) {
      expect(decodeInChunks(audio, sizes)).toEqual(expected)
    }
  })

  it('does not retain observation history by default', () => {
    const modem = new BFSKAcousticModem(getProfileConfig(ModemProfileKey.ROBUST, 48000))
    const decoder = new BFSKStreamDecoder(modem)
    decoder.pushSamples(makeAudio(new Uint8Array([1, 2, 3])))
    expect(decoder.takeObservations()).toEqual([])
  })

  it('emits zero frames for silence-only PCM', () => {
    expect(decodeInChunks(new Float32Array(48000), [257, 1024, 4096])).toEqual([])
  })

  it('recovers concatenated frames and ignores inter-frame silence', () => {
    const first = makeAudio(new Uint8Array([1]), 42, 1)
    const second = makeAudio(new Uint8Array([2]), 42, 2)
    const silence = new Float32Array(4800)
    const audio = new Float32Array(first.length + silence.length + second.length)
    audio.set(first)
    audio.set(silence, first.length)
    audio.set(second, first.length + silence.length)
    expect(decodeInChunks(audio, [4800, 257, 2048]).map(frame => frame.sequence)).toEqual([1, 2])
  })

  it('rejects a damaged frame and reacquires the following valid frame', () => {
    const bad = makeAudio(new Uint8Array([9]), 42, 1)
    const good = makeAudio(new Uint8Array([10]), 42, 2)
    const stride = new BFSKAcousticModem(getProfileConfig(ModemProfileKey.ROBUST, 48000)).getSymbolStrideSamples()
    bad.set(bad.subarray(stride * 10, stride * 11), stride * 20)
    const audio = new Float32Array(bad.length + good.length)
    audio.set(bad)
    audio.set(good, bad.length)

    const modem = new BFSKAcousticModem(getProfileConfig(ModemProfileKey.ROBUST, 48000))
    const decoder = new BFSKStreamDecoder(modem)
    const frames = decoder.pushSamples(audio)
    expect(frames.map(frame => frame.sequence)).toEqual([2])
    expect(decoder.getStats().crcRejected).toBeGreaterThan(0)
  })
})
