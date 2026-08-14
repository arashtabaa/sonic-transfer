import { describe, expect, it } from 'vitest'
import { AcousticFrameType, SessionLifecycleRuntime, decodeTransferEnd, decodeTransferPoll, decodeTransferStatus, encodeTransferEnd, encodeTransferPoll, encodeTransferStatus } from '../app/acoustic'

describe('two-device session lifecycle', () => {
  it('binds verification separately and acquires a new transfer session', () => {
    const runtime = new SessionLifecycleRuntime()
    runtime.beginControl(10)
    runtime.bindVerification(10)
    expect(runtime.acceptFrame(10, AcousticFrameType.PROFILE_PROBE_END)).toBe(true)
    expect(runtime.acceptFrame(11, AcousticFrameType.DATA)).toBe(false)
    expect(runtime.acceptFrame(11, AcousticFrameType.SESSION_HEADER)).toBe(true)
    runtime.acquireSessionHeader(11)
    expect(runtime.acceptFrame(11, AcousticFrameType.DATA)).toBe(true)
    expect(runtime.acceptFrame(12, AcousticFrameType.DATA)).toBe(false)
  })

  it('does not let a completed test session poison the next transfer', () => {
    const runtime = new SessionLifecycleRuntime()
    runtime.beginTransfer(20)
    expect(runtime.acceptFrame(20, AcousticFrameType.TEST_FILE_COMPLETE)).toBe(true)
    runtime.acquireSessionHeader(21)
    expect(runtime.acceptFrame(21, AcousticFrameType.DATA)).toBe(true)
  })

  it('strictly owns and validates transfer feedback frames', () => {
    const runtime = new SessionLifecycleRuntime()
    runtime.beginTransfer(20)
    const poll = encodeTransferPoll({ protocolVersion: 1, transferSessionId: 20, pollSequence: 1, framesPlayed: 10, lastDataSequence: 9 })
    expect(decodeTransferPoll(poll)).not.toBeNull()
    expect(runtime.acceptFeedbackFrame({ version: 1, sessionId: 20, frameType: AcousticFrameType.TRANSFER_POLL, sequence: 1, payload: poll, checksum: 0 })).toBe(true)
    expect(runtime.acceptFeedbackFrame({ version: 1, sessionId: 21, frameType: AcousticFrameType.TRANSFER_POLL, sequence: 1, payload: poll, checksum: 0 })).toBe(false)
    expect(decodeTransferStatus(encodeTransferStatus({ protocolVersion: 1, transferSessionId: 20, blocksReceived: 0, decodedCount: 0, complete: false }))).not.toBeNull()
    const sha = 'a'.repeat(64)
    const end = encodeTransferEnd({ protocolVersion: 1, transferSessionId: 20, expectedSha256: sha, actualSha256: sha, pass: true, blocksReceived: 1 })
    expect(decodeTransferEnd(end)).not.toBeNull()
    for (const malformed of ['', 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(65)]) expect(decodeTransferEnd(encodeTransferEnd({ protocolVersion: 1, transferSessionId: 20, expectedSha256: malformed, actualSha256: sha, pass: true, blocksReceived: 1 }))).toBeNull()
    expect(decodeTransferEnd(encodeTransferEnd({ protocolVersion: 1, transferSessionId: 20, expectedSha256: sha, actualSha256: sha, pass: true, blocksReceived: -1 }))).toBeNull()
  })
})
