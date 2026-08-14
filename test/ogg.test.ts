import { describe, expect, it } from 'vitest'
import {
  createOggPage,
  detectOggOpusSupport,
  encodeOggOpus,
  parseOggOpus,
} from '../app/acoustic'

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

describe('genuine Ogg/Opus artifact layer', () => {
  it('emits and parses Ogg pages with OpusHead and OpusTags', () => {
    const head = new Uint8Array(19)
    head.set(new TextEncoder().encode('OpusHead'))
    head[8] = 1
    head[9] = 1
    new DataView(head.buffer).setUint32(12, 48000, true)
    const tags = new TextEncoder().encode('OpusTags')
    const audio = new Uint8Array([0x01, 0x02, 0x03])
    const ogg = concat(
      createOggPage(head, 7, 0, 0x02, 0),
      createOggPage(tags, 7, 0, 0, 1),
      createOggPage(audio, 7, 960, 0, 2),
    )

    expect(new TextDecoder().decode(ogg.subarray(0, 4))).toBe('OggS')
    const parsed = parseOggOpus(ogg)
    expect(parsed.sampleRate).toBe(48000)
    expect(parsed.packets[2]).toEqual(audio)
  })

  it('reports unsupported when WebCodecs is unavailable instead of falling back to WebM', () => {
    const capability = detectOggOpusSupport()
    expect(capability.supported).toBe(false)
    expect(capability.mimeType).toBe('')
    expect(capability.reason).toContain('WebCodecs')
  })

  it('fails OGG export cleanly when the codec is unsupported', async () => {
    await expect(encodeOggOpus(new Float32Array(480), 48000)).rejects.toThrow('WebCodecs')
  })

  it('rejects truncated or non-Ogg input cleanly', () => {
    expect(() => parseOggOpus(new Uint8Array([0x4f, 0x67, 0x67]))).toThrow('Invalid Ogg page')
  })
})
