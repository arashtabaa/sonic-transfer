import { afterEach, describe, expect, it } from 'vitest'
import { AcousticFrameType, AudioReceiver, BFSKAcousticModem, BFSKStreamDecoder, encodeFrame, getProfileConfig, ModemProfileKey } from '../app/acoustic'

let processor: { onaudioprocess: ((event: any) => void) | null } | null = null

function installFakeAudioBackend() {
  const stream = {
    getAudioTracks: () => [{
      getSettings: () => ({ sampleRate: 48000, channelCount: 1 }),
      label: 'Injected microphone',
      stop: () => {},
    }],
    getTracks: () => [{ stop: () => {} }],
  }
  class FakeAudioContext {
    sampleRate = 48000
    state = 'running'
    destination = {}
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} } }
    createScriptProcessor() {
      const node = { onaudioprocess: null as ((event: any) => void) | null, connect: () => {}, disconnect: () => {} }
      processor = node
      return node
    }
    resume = async () => {}
    close = async () => {}
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: FakeAudioContext } })
}

afterEach(() => {
  processor = null
  delete (globalThis as any).navigator
  delete (globalThis as any).window
})

describe('receiver re-arm lifecycle', () => {
  it('keeps the physical receiver active and decodes the first SESSION_HEADER', async () => {
    installFakeAudioBackend()
    const modem = new BFSKAcousticModem(getProfileConfig(ModemProfileKey.BALANCED, 48000))
    const decoder = new BFSKStreamDecoder(modem)
    const frames = [] as ReturnType<BFSKStreamDecoder['pushSamples']>
    const receiver = new AudioReceiver({ onAudioData: samples => frames.push(...decoder.pushSamples(samples)) })
    await receiver.start()
    expect(receiver.isActive()).toBe(true)

    const audio = modem.encode(encodeFrame(123, AcousticFrameType.SESSION_HEADER, 1, new Uint8Array([1, 2, 3]))).samples
    for (let offset = 0; offset < audio.length; offset += 1024) {
      const chunk = audio.subarray(offset, Math.min(audio.length, offset + 1024))
      processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => chunk } })
    }
    expect(frames.some(frame => frame.frameType === AcousticFrameType.SESSION_HEADER)).toBe(true)

    receiver.stop()
    expect(receiver.isActive()).toBe(false)
  })
})
