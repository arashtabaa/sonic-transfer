import { describe, expect, it } from 'vitest'
import { AcousticFrameType, SessionLifecycleRuntime, TransferCompletionCache, encodeFrame, encodeTransferEnd } from '../app/acoustic'

describe('runtime closure primitives', () => {
  it('does not treat legacy END as successful completion', () => {
    const runtime = new SessionLifecycleRuntime()
    runtime.beginTransfer(7)
    const sha = 'b'.repeat(64)
    const legacy = encodeFrame(7, AcousticFrameType.END, 1, new Uint8Array())
    expect(runtime.acceptSenderCompletion({ ...runtimeFrame(legacy), frameType: AcousticFrameType.END }, sha)).toBe(false)
    const end = encodeFrame(7, AcousticFrameType.TRANSFER_END, 2, encodeTransferEnd({ protocolVersion: 1, transferSessionId: 7, expectedSha256: sha, actualSha256: sha, pass: true, blocksReceived: 10 }))
    expect(runtime.acceptSenderCompletion(runtimeFrame(end), sha)).toBe(true)
  })

  it('keys cached completion by session and expires it', () => {
    let now = 100
    const cache = new TransferCompletionCache(50, () => now)
    cache.remember({ transferSessionId: 10, expectedSha256: 'a'.repeat(64), actualSha256: 'a'.repeat(64), blocksReceived: 4, completedAt: now })
    expect(cache.forPoll(10, 10)?.transferSessionId).toBe(10)
    expect(cache.forPoll(11, 10)).toBeNull()
    cache.activateNewSession(11)
    expect(cache.forPoll(10, 10)).toBeNull()
    now = 200
    expect(cache.forPoll(10, 10)).toBeNull()
  })
})

function runtimeFrame(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const payloadLength = view.getUint16(14)
  return { version: view.getUint8(4), sessionId: view.getUint32(5), frameType: view.getUint8(9) as AcousticFrameType, sequence: view.getUint32(10), payload: bytes.slice(16, 16 + payloadLength), checksum: view.getUint32(16 + payloadLength) }
}
