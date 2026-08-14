import { describe, expect, it } from 'vitest'
import { AcousticFrameType, SessionLifecycleRuntime } from '../app/acoustic'

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
})
